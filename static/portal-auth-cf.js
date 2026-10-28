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
  // PLANO GRATUITO (100 mil chamadas/dia nas Functions): toda chamada /api/* conta. Por isso (26/10):
  //   • "quem sou eu" (/me) e o token da Azure (/token) ficam guardados na aba (sessionStorage) e servem a
  //     navegação entre as páginas sem nova chamada; 401 em qualquer rota apaga o guardado;
  //   • as ações (ignorar/reativar NF) são relidas a cada 60 s com a aba visível, e na hora em que a aba volta.
  const ME_TTL_MS = 10 * 60 * 1000, ACOES_MS = 60000;
  const guardado = {
    ler(k) { try { const x = JSON.parse(sessionStorage.getItem(k) || "null"); return x && x.ate > Date.now() ? x.v : null; } catch (_) { return null; } },
    gravar(k, v, ms) { try { sessionStorage.setItem(k, JSON.stringify({ v, ate: Date.now() + ms })); } catch (_) {} },
    limpar() { try { sessionStorage.removeItem("cf_me"); sessionStorage.removeItem("cf_tok"); } catch (_) {} },
  };

  function quer() { return HOSTS_CF.test(location.hostname); }

  async function req(metodo, caminho, corpo) {
    const r = await fetch(API + caminho, {
      method: metodo,
      credentials: "same-origin",
      headers: corpo === undefined ? {} : { "Content-Type": "application/json" },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    if (r.status === 401) guardado.limpar();
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
      rotulo: x.rotulo || "",
      doc: true,
      ferramentas: ferramentasDe(x.perfil, x),
      acessoCusto: ferramentasDe(x.perfil, x).includes("custo"),
      pode: x.pode || null,
      donoPerfis: x.donoPerfis === true,
    });

    // 1ª resposta: quem sou eu (401 = sem sessão, 403 = sessão de alguém que saiu do portal)
    let erroCarga = false;   // servidor fora do ar / resposta inesperada (ex.: 404 antes do deploy da API)
    const meGuardado = guardado.ler("cf_me");
    const pronto = (meGuardado ? Promise.resolve(meGuardado) : req("GET", "/me").then((x) => { guardado.gravar("cf_me", x, ME_TTL_MS); return x; }))
      .then(perfilDe).catch((e) => {
      if (e.message === "sem-acesso") { try { sessionStorage.setItem("portal_sem_acesso", "1"); } catch (_) {} }
      else if (e.message !== "sem-sessao") erroCarga = true;
      return null;
    }).then((p) => { usuarioAtual = p; return p; });

    // ---- ações (ignorar/reativar NF): sem tempo real nativo → consulta a cada 15 s enquanto houver ouvinte ----
    let ultimaLeitura = 0;
    async function atualizarAcoes() {
      ultimaLeitura = Date.now();
      try {
        const lista = await req("GET", "/acoes");
        ultimoMapa = new Map(lista.map((a) => [a.id, a]));
        ouvintes.forEach((cb) => cb(ultimoMapa));
      } catch (e) { console.warn("[acoes] sem leitura:", e.message); }
    }

    // aba voltou a ficar visível: relê na hora se a última leitura passou de 20 s (quem trocou de aba vê o atual)
    function aoVoltar() { if (!document.hidden && Date.now() - ultimaLeitura > 20000) atualizarAcoes(); }

    return {
      modo() { return "cloudflare"; },
      ativo() { return true; },
      pronto,
      erro() { return erroCarga; },
      usuario() { return usuarioAtual; },
      perfil() { return usuarioAtual ? usuarioAtual.perfil : null; },
      // o que o PERFIL permite (vem do Worker); sem `pode` (sessão antiga guardada), cai na regra fixa de antes
      // permissão por ferramenta (id do catálogo do Worker: nf_ignorar, nf_ver_ocultas, admin…)
      pode(id) {
        if (!usuarioAtual) return false;
        if (usuarioAtual.pode && id in usuarioAtual.pode) return !!usuarioAtual.pode[id];
        if (id === "admin" || id.startsWith("pedidos_")) return usuarioAtual.perfil === "ti";   // sessão antiga guardada
        return ["logistica", "ti"].includes(usuarioAtual.perfil);
      },
      podeEditar() { return this.pode("nf_ignorar"); },
      rotulo() { return usuarioAtual ? (usuarioAtual.rotulo || usuarioAtual.perfil) : ""; },
      admin() { return !!usuarioAtual && (usuarioAtual.pode ? !!usuarioAtual.pode.admin : usuarioAtual.perfil === "ti"); },
      donoPerfis() { return !!usuarioAtual && usuarioAtual.donoPerfis === true; },
      podeCusto() { return !!usuarioAtual && usuarioAtual.acessoCusto === true; },
      podeFerramenta(id) { return !!usuarioAtual && (usuarioAtual.ferramentas || []).includes(id); },
      ferramentas() { return FERRAMENTAS.slice(); },
      ferramentaTI() { return FERRAMENTA_TI; },
      ferramentasDe,

      // Token para a API da Azure: o Worker devolve o JWT do Access (a Azure passa a validá-lo — ver CLOUDFLARE.md)
      async idToken(forcar) {
        if (!forcar && !tokenCache) tokenCache = guardado.ler("cf_tok");
        if (!forcar && tokenCache && tokenCache.ate > Date.now() + 60000) return tokenCache.token;
        const t = await req("GET", "/token");
        tokenCache = { token: t.token, ate: (t.exp || 0) * 1000 || Date.now() + 300000 };
        guardado.gravar("cf_tok", tokenCache, Math.max(tokenCache.ate - Date.now() - 60000, 0));
        return t.token;
      },

      // Login por e-mail e senha (o Worker confere e grava o cookie de sessão)
      async entrar(email, senha) {
        try {
          const x = await req("POST", "/login", { email: (email || "").trim(), senha: senha || "" });
          guardado.limpar(); guardado.gravar("cf_me", x, ME_TTL_MS);
          usuarioAtual = perfilDe(x);
          return usuarioAtual;
        } catch (e) { throw traduzir(e); }
      },
      // Primeiro acesso: a pessoa autorizada define a própria senha (só funciona se a conta ainda não tem senha)
      async primeiroAcesso(email, senha) {
        try {
          const x = await req("POST", "/primeiro-acesso", { email: (email || "").trim(), senha: senha || "" });
          guardado.limpar(); guardado.gravar("cf_me", x, ME_TTL_MS);
          usuarioAtual = perfilDe(x);
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
        guardado.limpar(); tokenCache = null;
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
        guardado.limpar();                       // o Worker confere se o perfil existe
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
        await req("POST", "/usuarios/lote", { itens: emails.map((e) => ({ email: e.trim().toLowerCase(), perfil })) });
      },
      // ---- perfis (listar: admin; criar/alterar/apagar: só o dono, o Worker barra os demais) ----
      async listarPerfis() { return req("GET", "/perfis"); },          // { catalogo:[{id,nome,grupo}], perfis:[...] }
      async salvarPerfil(nome, dados) { guardado.limpar(); return req("PUT", "/perfis/" + encodeURIComponent(nome), dados); },
      async removerPerfil(nome) { await req("DELETE", "/perfis/" + encodeURIComponent(nome)); },
      async removerUsuario(email) { await req("DELETE", "/usuarios/" + encodeURIComponent(email.toLowerCase())); },

      // ---- ações ----
      ouvirAcoes(cb) {
        ouvintes.add(cb);
        atualizarAcoes();
        if (!timer) {
          timer = setInterval(() => { if (!document.hidden) atualizarAcoes(); }, ACOES_MS);
          document.addEventListener("visibilitychange", aoVoltar);
        }
        return () => { ouvintes.delete(cb); if (!ouvintes.size && timer) { clearInterval(timer); timer = null; document.removeEventListener("visibilitychange", aoVoltar); } };
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
