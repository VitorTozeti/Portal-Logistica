// portal-auth-cf.js — backend de login/perfis para a CLOUDFLARE (Pages + Access + Worker).
//
// ESTADO: PREPARADO, INERTE. Só liga em hosts *.pages.dev (ver quer()). No GitHub Pages (github.io), no
// servidor interno e em arquivo local este arquivo não faz nada — vale o Firebase de portal-auth.js.
//
// Mesma interface do PortalGate do Firebase (as telas não mudam). Diferenças:
//   • quem LOGA é o Cloudflare Access (e-mail corporativo / Microsoft) ANTES da página abrir — não há senha aqui;
//   • perfil, ferramentas, ações e log vêm de um Worker same-origin em /api/* (contrato em CLOUDFLARE.md);
//   • a identidade da pessoa é lida pelo Worker no cabeçalho do Access — o navegador nunca manda o e-mail.
// A SEGURANÇA REAL está no Worker (confere o JWT do Access e o perfil); esconder botão aqui é só UX.

window.PortalGateCF = (function () {
  // hosts que usam este backend. Domínio próprio na Cloudflare: acrescente aqui (ex.: |portal\.empresa\.com\.br).
  const HOSTS_CF = /(\.pages\.dev|^portal\.pharmaesthetics\.com\.br)$/;
  const API = "/api";

  function quer() { return HOSTS_CF.test(location.hostname); }

  async function req(metodo, caminho, corpo) {
    const r = await fetch(API + caminho, {
      method: metodo,
      credentials: "same-origin",
      headers: corpo === undefined ? {} : { "Content-Type": "application/json" },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    if (r.status === 401 || r.status === 403) throw new Error("sem-acesso");
    if (!r.ok) throw new Error("http-" + r.status);
    return r.status === 204 ? null : r.json();
  }

  // base = { FERRAMENTAS, FERRAMENTA_TI, IDS, PERFIS, ferramentasDe } vindos de portal-auth.js
  function montar(base) {
    const { FERRAMENTAS, FERRAMENTA_TI, IDS, PERFIS, ferramentasDe } = base;
    let usuarioAtual = null, tokenCache = null;
    const ouvintes = new Set();
    let ultimoMapa = new Map(), timer = null;

    const perfilDe = (x) => ({
      email: (x.email || "").toLowerCase(),
      perfil: x.perfil,
      doc: true,
      ferramentas: ferramentasDe(x.perfil, x),
      acessoCusto: ferramentasDe(x.perfil, x).includes("custo"),
    });

    // 1ª resposta: quem sou eu (o Worker lê o Access e devolve o perfil, ou 403 se o e-mail não está em usuarios)
    const pronto = req("GET", "/me").then(perfilDe).catch((e) => {
      if (e.message === "sem-acesso") { try { sessionStorage.setItem("portal_sem_acesso", "1"); } catch (_) {} }
      return null;
    }).then((p) => { usuarioAtual = p; return p; });

    // ---- ações (ignorar/reativar NF): sem tempo real nativo → consulta a cada 15 s enquanto houver ouvinte ----
    async function atualizarAcoes() {
      try {
        const lista = await req("GET", "/acoes");
        ultimoMapa = new Map(lista.map((a) => [a.id, a]));
        ouvintes.forEach((cb) => cb(ultimoMapa));
      } catch (e) { console.warn("[acoes] sem leitura:", e.message); }
    }

    return {
      modo() { return "cloudflare"; },
      ativo() { return true; },
      pronto,
      usuario() { return usuarioAtual; },
      perfil() { return usuarioAtual ? usuarioAtual.perfil : null; },
      podeEditar() { return !!usuarioAtual && ["logistica", "ti"].includes(usuarioAtual.perfil); },
      podeCusto() { return !!usuarioAtual && usuarioAtual.acessoCusto === true; },
      podeFerramenta(id) { return !!usuarioAtual && (usuarioAtual.ferramentas || []).includes(id); },
      ferramentas() { return FERRAMENTAS.slice(); },
      ferramentaTI() { return FERRAMENTA_TI; },
      ferramentasDe,

      // Token para a API da Azure: o Worker devolve o JWT do Access (a Azure passa a validá-lo — ver CLOUDFLARE.md)
      async idToken(forcar) {
        if (!forcar && tokenCache && tokenCache.ate > Date.now() + 60000) return tokenCache.token;
        const t = await req("GET", "/token");
        tokenCache = { token: t.token, ate: (t.exp || 0) * 1000 || Date.now() + 300000 };
        return t.token;
      },

      // Sem senha aqui: quem autentica é o Access.
      async entrar() { throw new Error("sem-acesso"); },
      async cadastrar() { throw new Error("sem-acesso"); },
      async redefinirSenha() {},
      async redefinirSenhaPropria() { throw new Error("sem-senha"); },
      async sair() { location.href = "/cdn-cgi/access/logout"; return new Promise(() => {}); },

      // ---- usuários (só o perfil ti; o Worker barra os demais) ----
      async listarUsuarios() {
        const l = await req("GET", "/usuarios");
        return l.map((x) => ({ email: x.email, perfil: x.perfil, ferramentas: ferramentasDe(x.perfil, x), ultimoAcesso: x.ultimoAcesso || 0 }))
                .sort((a, b) => a.email.localeCompare(b.email));
      },
      async salvarUsuario(email, perfil) {
        if (!PERFIS.includes(perfil)) throw new Error("perfil inválido");
        await req("PUT", "/usuarios/" + encodeURIComponent(email.trim().toLowerCase()), { perfil });
      },
      async salvarFerramentas(email, lista) {
        const f = (lista || []).filter((i) => IDS.includes(i));
        await req("PUT", "/usuarios/" + encodeURIComponent(email.trim().toLowerCase()), { ferramentas: f, acessoCusto: f.includes("custo") });
      },
      async salvarFerramentasVarios(itens) {
        await req("POST", "/usuarios/lote", { itens: itens.map((it) => {
          const f = (it.ferramentas || []).filter((i) => IDS.includes(i));
          return { email: it.email.trim().toLowerCase(), ferramentas: f, acessoCusto: f.includes("custo") };
        }) });
      },
      async salvarVarios(emails, perfil) {
        if (!PERFIS.includes(perfil)) throw new Error("perfil inválido");
        await req("POST", "/usuarios/lote", { itens: emails.map((e) => ({ email: e.trim().toLowerCase(), perfil })) });
      },
      async removerUsuario(email) { await req("DELETE", "/usuarios/" + encodeURIComponent(email.toLowerCase())); },

      // ---- ações ----
      ouvirAcoes(cb) {
        ouvintes.add(cb);
        atualizarAcoes();
        if (!timer) timer = setInterval(() => { if (!document.hidden) atualizarAcoes(); }, 15000);
        return () => { ouvintes.delete(cb); if (!ouvintes.size && timer) { clearInterval(timer); timer = null; } };
      },
      async ocultar(id, tipo, motivo, nf, filial) {
        await req("PUT", "/acoes/" + encodeURIComponent(id), { tipo, motivo: motivo || "", nf: nf || "", filial: filial || "" });
        await atualizarAcoes();
      },
      async reativar(id) {
        await req("DELETE", "/acoes/" + encodeURIComponent(id));
        await atualizarAcoes();
      },
      async ultimoLog(id) {
        try { const x = await req("GET", "/acoes/log?id=" + encodeURIComponent(id)); return x ? { ...x, ms: x.em || 0 } : null; }
        catch (_) { return null; }
      },
    };
  }

  return { quer, montar };
})();
