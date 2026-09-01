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
// Se o secret NÃO estiver definido, cai na credencial PADRÃO abaixo (fail-CLOSED):
// o login SEMPRE aparece no Pages e ninguém entra sem senha. Para trocar a senha
// oficial, defina o secret PORTAL_PAGES_AUTH — ele sobrescreve o padrão no build.

window.PORTAL_PAGES_AUTH = "__PORTAL_PAGES_AUTH__";
// Credencial PADRÃO (quando o secret não foi injetado). Formato "usuario:sha256hex(senha)".
// Padrão atual: usuário "logistica", senha "portal2026". Gate leve — este valor fica
// visível no view-source (é só p/ manter olhares casuais fora do preview público).
window.PORTAL_PAGES_AUTH_DEFAULT = "logistica:09ddc5ca1d9317a325857b8bcd44cee9ea23fadb939801e64cda7dd32887ee0a";

window.PortalGate = (function () {
  const INJ = window.PORTAL_PAGES_AUTH || "";
  // secret injetado no build, senão a credencial padrão (fail-closed: login sempre exigido)
  const RAW = (INJ && !INJ.startsWith("__")) ? INJ : (window.PORTAL_PAGES_AUTH_DEFAULT || "");
  const CHAVE = "portal_pages_ok";
  // gate só faz sentido quando o site é ESTÁTICO (Pages / arquivo local)
  const ESTATICO = location.protocol === "file:" || /(^|\.)github\.io$/.test(location.hostname);
  // ativo sempre que for estático e houver credencial (secret OU padrão)
  const CONFIG = ESTATICO && !!RAW && RAW.indexOf(":") > -1;
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
