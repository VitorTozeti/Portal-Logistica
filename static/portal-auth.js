// portal-auth.js — GATE LEVE do front estático (GitHub Pages).
//
// ⚠️ ISTO NÃO É SEGURANÇA FORTE. O site do GitHub Pages é 100% estático: não há
// servidor para conferir senha. O melhor possível aqui é um gate em JavaScript —
// e o hash da senha fica VISÍVEL neste arquivo no site publicado (view-source).
// Serve só para manter olhares casuais fora do preview público. O login REAL
// (cookie assinado HMAC) roda no servidor FastAPI (auth.py/app.py), não aqui.
//
// COMO A CREDENCIAL ENTRA: no deploy do Pages (.github/workflows/pages.yml) um passo
// troca o placeholder abaixo por "usuario:sha256hex(senha)", a partir do GitHub Secret
// PORTAL_PAGES_AUTH (definido como "usuario:senha" em Settings → Secrets → Actions).
// Se o secret NÃO estiver definido, o placeholder permanece e o gate fica DESLIGADO
// (fail-open) — assim ninguém se tranca fora por esquecer de configurar.

window.PORTAL_PAGES_AUTH = "__PORTAL_PAGES_AUTH__";

window.PortalGate = (function () {
  const RAW = window.PORTAL_PAGES_AUTH || "";
  const CHAVE = "portal_pages_ok";
  // gate só faz sentido quando o site é ESTÁTICO (Pages / arquivo local)
  const ESTATICO = location.protocol === "file:" || /(^|\.)github\.io$/.test(location.hostname);
  // ativo apenas se o secret foi injetado (não é mais o placeholder "__…__")
  const CONFIG = ESTATICO && RAW && !RAW.startsWith("__");
  const idx = RAW.indexOf(":");
  const USUARIO = CONFIG && idx > -1 ? RAW.slice(0, idx) : "";
  const HASH = CONFIG && idx > -1 ? RAW.slice(idx + 1) : "";

  async function sha256(txt) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(txt));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  return {
    ativo() { return CONFIG; },
    autenticado() {
      if (!CONFIG) return true;              // gate desligado → tudo liberado
      try { return sessionStorage.getItem(CHAVE) === "1"; } catch (_) { return false; }
    },
    async validar(usuario, senha) {
      if (!CONFIG) return true;
      const ok = (usuario || "").trim() === USUARIO && (await sha256(senha || "")) === HASH;
      if (ok) { try { sessionStorage.setItem(CHAVE, "1"); } catch (_) {} }
      return ok;
    },
    sair() { try { sessionStorage.removeItem(CHAVE); } catch (_) {} },
  };
})();
