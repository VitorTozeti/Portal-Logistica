// portal-auth.js — LOGIN POR PESSOA + PERFIS no front estático (GitHub Pages), via Firebase.
//
// Substitui o antigo gate de 1 usuário/1 senha em JS. Agora:
//   • Firebase Auth (e-mail+senha) identifica cada pessoa;
//   • o perfil vem de `usuarios/{email}` no Firestore: "logistica" | "ti" | (ausente = "leitor");
//   • logistica e ti EDITAM (ignorar/reativar NF); leitor só visualiza;
//   • ti também lê `acoes_log` (quem mexeu em cada nota).
// A SEGURANÇA REAL está nas Firestore Security Rules (firestore.rules), que rodam no servidor
// do Google. Esconder botão aqui é só UX — as Rules é que barram escrita de quem não pode.
// O firebaseConfig abaixo é PÚBLICO por desenho (não é segredo).
//
// No servidor real (FastAPI/on-prem) este módulo fica inerte: vale o login por cookie do auth.py.
// Exige, ANTES deste script: firebase-app-compat, firebase-auth-compat, firebase-firestore-compat.

window.PortalGate = (function () {
  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyB_YAPSMqmJ_QNqzGZmTr9EbfWc5PAdvg4",
    authDomain: "portal-logistica-bde60.firebaseapp.com",
    projectId: "portal-logistica-bde60",
    storageBucket: "portal-logistica-bde60.firebasestorage.app",
    messagingSenderId: "1067576259582",
    appId: "1:1067576259582:web:a5b8402fc2d28eb32fc6af",
  };
  // só faz sentido quando o site é ESTÁTICO (Pages / arquivo local)
  const ESTATICO = location.protocol === "file:" || /(^|\.)github\.io$/.test(location.hostname);
  const ATIVO = ESTATICO;                       // fail-CLOSED: se o SDK não carregar, ninguém entra
  const SDK = typeof firebase !== "undefined";

  let auth = null, db = null, usuarioAtual = null;
  if (ATIVO && SDK) {
    firebase.initializeApp(FIREBASE_CONFIG);
    auth = firebase.auth();
    db = firebase.firestore();
  }

  async function carregarPerfil(user) {
    const email = (user.email || "").toLowerCase();
    let perfil = "leitor";
    try {
      const d = await db.collection("usuarios").doc(email).get();
      if (d.exists && ["logistica", "ti"].includes(d.data().perfil)) perfil = d.data().perfil;
    } catch (_) { /* sem permissão/rede → segue como leitor */ }
    return { email, perfil };
  }

  // resolve {email, perfil} (logado) ou null (deslogado) — 1ª resposta do Firebase Auth
  const pronto = new Promise((resolve) => {
    if (!ATIVO || !SDK) { resolve(ATIVO ? null : { email: "", perfil: "servidor" }); return; }
    auth.onAuthStateChanged(async (u) => {
      usuarioAtual = u ? await carregarPerfil(u) : null;
      resolve(usuarioAtual);
    });
  });

  const agora = () => firebase.firestore.FieldValue.serverTimestamp();

  return {
    ativo() { return ATIVO; },
    pronto,
    usuario() { return usuarioAtual; },
    perfil() { return usuarioAtual ? usuarioAtual.perfil : null; },
    podeEditar() { return !!usuarioAtual && ["logistica", "ti"].includes(usuarioAtual.perfil); },

    async entrar(email, senha) {
      if (!SDK) throw new Error("SDK do Firebase não carregou");
      await auth.signInWithEmailAndPassword((email || "").trim(), senha || "");
      usuarioAtual = await carregarPerfil(auth.currentUser);
      return usuarioAtual;
    },
    async sair() { if (auth) await auth.signOut(); usuarioAtual = null; },

    // ---- ações (ignorar/reativar NF) ----
    // Ouve `acoes` em tempo real; cb recebe Map(id → {tipo, motivo, nf, filial, em})
    ouvirAcoes(cb) {
      if (!db) return () => {};
      return db.collection("acoes").onSnapshot((snap) => {
        const m = new Map();
        snap.forEach((d) => m.set(d.id, d.data()));
        cb(m);
      }, (e) => console.warn("[acoes] sem leitura:", e.message));
    },
    // ação + linha de log na MESMA gravação (batch)
    async ocultar(id, tipo, motivo, nf, filial) {
      const t = agora(), por = usuarioAtual.email, b = db.batch();
      b.set(db.collection("acoes").doc(id), { tipo, motivo: motivo || "", nf: nf || "", filial: filial || "", em: t });
      b.set(db.collection("acoes_log").doc(), { id, acao: "ocultar", tipo, motivo: motivo || "", por, em: t });
      await b.commit();
    },
    async reativar(id) {
      const t = agora(), por = usuarioAtual.email, b = db.batch();
      b.delete(db.collection("acoes").doc(id));
      b.set(db.collection("acoes_log").doc(), { id, acao: "reativar", tipo: "", motivo: "", por, em: t });
      await b.commit();
    },
    // última mudança de uma NF (só o perfil ti consegue ler — as Rules barram os outros)
    async ultimoLog(id) {
      if (!db) return null;
      try {
        const s = await db.collection("acoes_log").where("id", "==", id).get();
        let ult = null;
        s.forEach((d) => { const x = d.data(); const ms = x.em && x.em.toMillis ? x.em.toMillis() : 0;
          if (!ult || ms > ult.ms) ult = { ...x, ms }; });
        return ult;
      } catch (_) { return null; }
    },
  };
})();
