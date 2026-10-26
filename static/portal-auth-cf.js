// portal-auth-cf.js — backend de login/perfis para a CLOUDFLARE (Pages Functions + D1).
//
// Só liga em hosts *.pages.dev (ver quer()). No GitHub Pages (github.io), no servidor interno e em
// arquivo local este arquivo não faz nada — vale o Firebase de portal-auth.js.
//
// Mesma interface do PortalGate do Firebase (as telas não mudam). Diferenças:
//   • login por e-mail e senha conferido pelo Worker, com cookie HttpOnly (o JavaScript não lê a sessão);
//   • perfil, ferramentas, ações e log vêm do Worker em /api/* (contrato em CLOUDFLARE.md).
// A SEGURANÇA REAL está no Worker (functions/api); esconder botão aqui é só UX.

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
    if (r.status === 204) return null;
    const dados = await r.json().catch(() => ({}));
    if (!r.ok) {
      // o código de erro vem do Worker (credenciais, primeiro-acesso, bloqueado, sem-sessao, sem-acesso...)
      const e = new Error(dados.erro || (r.status === 403 ? "sem-acesso" : "http-" + r.status));
      e.status = r.status;
      e.segundos = dados.segundos;
      throw e;
    }
    return dados;
  }

  // código de erro do Worker -> mensagem que o login.html já sabe mostrar (bloqueado:<segundos>)
  function traduzir(e) {
    if (e.message === "bloqueado") return new Error("bloqueado:" + (e.segundos || 60));
    return e;
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

    // 1ª resposta: quem sou eu (401 = sem sessão, 403 = sessão de alguém que saiu do portal)
    let erroCarga = false;   // servidor fora do ar / resposta inesperada (ex.: 404 antes do deploy da API)
    const pronto = req("GET", "/me").then(perfilDe).catch((e) => {
      if (e.message === "sem-acesso") { try { sessionStorage.setItem("portal_sem_acesso", "1"); } catch (_) {} }
      else if (e.message !== "sem-sessao") erroCarga = true;
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
      erro() { return erroCarga; },
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

      // Login por e-mail e senha (o Worker confere e grava o cookie de sessão)
      async entrar(email, senha) {
        try {
          usuarioAtual = perfilDe(await req("POST", "/login", { email: (email || "").trim(), senha: senha || "" }));
          return usuarioAtual;
        } catch (e) { throw traduzir(e); }
      },
      // Primeiro acesso: a pessoa autorizada define a própria senha (só funciona se a conta ainda não tem senha)
      async primeiroAcesso(email, senha) {
        try {
          usuarioAtual = perfilDe(await req("POST", "/primeiro-acesso", { email: (email || "").trim(), senha: senha || "" }));
          return usuarioAtual;
        } catch (e) { throw traduzir(e); }
      },
      // cadastro público e "esqueci a senha" não existem no modo Cloudflare: quem administra é o TI
      async cadastrar() { throw new Error("use-login"); },
      async redefinirSenha() { throw new Error("sem-email"); },
      async trocarSenha(atual, nova) {
        try { await req("POST", "/senha", { atual, nova }); } catch (e) { throw traduzir(e); }
      },
      async redefinirSenhaPropria() { throw new Error("use-trocar-senha"); },
      async sair() {
        try { await req("POST", "/logout"); } catch (_) {}
        usuarioAtual = null;
      },

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
