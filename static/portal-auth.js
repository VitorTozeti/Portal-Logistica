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

  // Administradores iniciais: entram como TI mesmo sem documento em `usuarios/` (para poder cadastrar
  // os demais pelo site). DEVE bater com a função boot() de firestore.rules.
  const BOOTSTRAP = ["v.tozeti@pharmaesthetics.com.br", "m.milani@pharmaesthetics.com.br"];
  const PERFIS = ["logistica", "ti", "leitor"];

  let auth = null, db = null, usuarioAtual = null, criando = false;
  if (ATIVO && SDK) {
    firebase.initializeApp(FIREBASE_CONFIG);
    auth = firebase.auth();
    db = firebase.firestore();
  }

  // perfil da pessoa, ou null se o e-mail NÃO está autorizado (sem documento em `usuarios/`)
  async function carregarPerfil(user) {
    const email = (user.email || "").toLowerCase();
    try {
      // teto de 8 s: com o Firestore ainda não criado/sem rede o get() ficaria pendurado e o login "travaria"
      const d = await Promise.race([
        db.collection("usuarios").doc(email).get(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000)),
      ]);
      if (d.exists && PERFIS.includes(d.data().perfil)) return { email, perfil: d.data().perfil };
    } catch (_) { /* sem permissão/rede → trata como não autorizado */ }
    return BOOTSTRAP.includes(email) ? { email, perfil: "ti" } : null;
  }


  // resolve {email, perfil} (logado) ou null (deslogado) — 1ª resposta do Firebase Auth
  const pronto = new Promise((resolve) => {
    if (!ATIVO || !SDK) { resolve(ATIVO ? null : { email: "", perfil: "servidor" }); return; }
    auth.onAuthStateChanged(async (u) => {
      if (criando) return;                       // fluxo de login/1º acesso cuida da própria sessão
      usuarioAtual = u ? await carregarPerfil(u) : null;
      if (u && !usuarioAtual) { try { sessionStorage.setItem("portal_sem_acesso", "1"); } catch (_) {} await auth.signOut(); }
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
      criando = true;                                // evita corrida com o onAuthStateChanged
      try {
        await auth.signInWithEmailAndPassword((email || "").trim(), senha || "");
        usuarioAtual = await carregarPerfil(auth.currentUser);
        if (!usuarioAtual) { await auth.signOut(); throw new Error("sem-acesso"); }
        return usuarioAtual;
      } finally { criando = false; }
    },
    // CADASTRO (cadastro.html): a pessoa escolhe a própria senha. Só vale se o e-mail estiver
    // autorizado (documento em `usuarios/`); senão a conta recém-criada é apagada.
    async cadastrar(email, senha) {
      if (!SDK) throw new Error("SDK do Firebase não carregou");
      criando = true;
      try {
        const cred = await auth.createUserWithEmailAndPassword((email || "").trim().toLowerCase(), senha || "");
        const p = await carregarPerfil(cred.user);
        if (!p) { await cred.user.delete(); throw new Error("sem-acesso"); }
        await cred.user.getIdToken();      // garante a sessão gravada antes de redirecionar
        usuarioAtual = p;
        return p;
      } finally { criando = false; }
    },
    // ESQUECI A SENHA (esqueci.html): manda o link de redefinição (só chega a quem já tem conta)
    async redefinirSenha(email) {
      if (!SDK) throw new Error("SDK do Firebase não carregou");
      await auth.sendPasswordResetEmail((email || "").trim().toLowerCase());
    },
    async sair() { if (auth) await auth.signOut(); usuarioAtual = null; },

    // ---- usuários (só o perfil ti; as Rules barram os demais) ----
    async listarUsuarios() {
      const q = await db.collection("usuarios").get();
      const l = []; q.forEach((d) => l.push({ email: d.id, perfil: d.data().perfil }));
      return l.sort((x, y) => x.email.localeCompare(y.email));
    },
    async salvarUsuario(email, perfil) {
      if (!PERFIS.includes(perfil)) throw new Error("perfil inválido");
      await db.collection("usuarios").doc((email || "").trim().toLowerCase()).set({ perfil });
    },
    async removerUsuario(email) { await db.collection("usuarios").doc(email.toLowerCase()).delete(); },

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
