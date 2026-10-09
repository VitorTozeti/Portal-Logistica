// auth-ui.js — comportamento COMUM das telas de acesso (login, cadastro, esqueci a senha).
window.AuthUI = (function () {
  const $ = (s) => document.querySelector(s);

  // ---- tema (mesma chave do index.html) ----
  function tema() {
    let t = "dark";
    try { t = localStorage.getItem("portal_tema") || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"); } catch (_) {}
    document.documentElement.setAttribute("data-theme", t);
    const b = document.createElement("button");
    b.type = "button"; b.className = "tema"; b.setAttribute("aria-label", "Alternar tema claro/escuro");
    const ico = () => (b.textContent = document.documentElement.getAttribute("data-theme") === "light" ? "☀️" : "🌙");
    b.onclick = () => {
      const n = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", n);
      try { localStorage.setItem("portal_tema", n); } catch (_) {}
      ico();
    };
    ico(); document.body.appendChild(b);
  }

  // ---- mostrar/ocultar senha ----
  function olho(input) {
    const wrap = document.createElement("div"); wrap.className = "campo";
    input.parentNode.insertBefore(wrap, input); wrap.appendChild(input);
    const b = document.createElement("button");
    b.type = "button"; b.className = "olho"; b.textContent = "👁"; b.setAttribute("aria-label", "Mostrar senha");
    b.onclick = () => {
      const ver = input.type === "password";
      input.type = ver ? "text" : "password";
      b.textContent = ver ? "🙈" : "👁";
      b.setAttribute("aria-label", ver ? "Ocultar senha" : "Mostrar senha");
    };
    wrap.appendChild(b);
    return wrap;
  }

  // ---- força da senha (0-4) ----
  function forca(pw) {
    let n = 0;
    if (pw.length >= 6) n++;
    if (pw.length >= 10) n++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) n++;
    if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) n++;
    return pw ? Math.max(n, 1) : 0;
  }
  const FORCA_TXT = ["", "Fraca", "Razoável", "Boa", "Forte"];

  // ---- aviso (erro/ok) com leitor de tela (aria-live) ----
  function aviso(el, tipo, texto) {
    el.className = "aviso " + (tipo || "") + (texto ? " show" : "");
    el.textContent = texto || "";
  }
  function dica(input, texto) {            // erro inline logo abaixo do campo
    let d = document.querySelector(".dica[data-for='" + input.id + "']");   // 1 só por campo (não empilha)
    if (!d) { d = document.createElement("div"); d.className = "dica"; d.dataset.for = input.id; d.setAttribute("aria-live", "polite");
      (input.closest(".campo") || input).insertAdjacentElement("afterend", d); }
    d.textContent = texto || "";
    input.setAttribute("aria-invalid", texto ? "true" : "false");
  }
  function carregando(btn, on, rotulo) {
    if (on) { btn.dataset.rot = btn.textContent; btn.disabled = true; btn.innerHTML = '<span class="spin"></span><span></span>'; btn.lastChild.textContent = rotulo || "Aguarde…"; }
    else { btn.disabled = false; btn.textContent = rotulo || btn.dataset.rot || btn.textContent; }
  }

  // ---- mensagens de erro do Firebase em português ----
  function msgErro(x, contexto) {
    const c = (x && x.code) || "", m = x && x.message;
    if (m === "sem-acesso") return "Este e-mail não está autorizado. Peça acesso ao TI.";
    if (m && m.indexOf("bloqueado:") === 0) return "Muitas tentativas. Tente de novo em " + m.split(":")[1] + " s.";
    if (c === "auth/network-request-failed") return "Sem conexão. Verifique a internet e tente de novo.";
    if (c === "auth/too-many-requests") return "Muitas tentativas. Aguarde alguns minutos e tente de novo.";
    if (c === "auth/email-already-in-use") return "Já existe uma conta com este e-mail. Entre ou use “Esqueci a senha”.";
    if (c === "auth/weak-password") return "Senha muito fraca. Use pelo menos 6 caracteres.";
    if (c === "auth/invalid-email") return "E-mail inválido.";
    if (c === "auth/user-disabled") return "Esta conta está desativada. Fale com o TI.";
    if (c === "auth/invalid-credential" || c === "auth/wrong-password" || c === "auth/user-not-found")
      return contexto === "login" ? "E-mail ou senha incorretos. Se ainda não tem conta, use “Criar conta”." : "E-mail ou senha inválidos.";
    return "Não foi possível concluir. Tente de novo.";
  }
  const emailOk = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

  // ---- destino depois do login (?next=./algo), só caminho relativo seguro ----
  function destino() {
    try {
      const n = new URLSearchParams(location.search).get("next") || "";
      if (/^\.\/[A-Za-z0-9_\-./?=&%#]*$/.test(n) && n.indexOf("..") < 0 && n.indexOf("//") < 0) return n;
    } catch (_) {}
    return "./painel.html";
  }
  const comNext = (pagina) => { const n = new URLSearchParams(location.search).get("next"); return n ? pagina + "?next=" + encodeURIComponent(n) : pagina; };

  // ---- trava local contra tentativas em sequência (além da proteção do Firebase) ----
  const CH = "portal_login_falhas";
  const lerF = () => { try { return JSON.parse(localStorage.getItem(CH) || "{}"); } catch (_) { return {}; } };
  const gravaF = (o) => { try { localStorage.setItem(CH, JSON.stringify(o)); } catch (_) {} };
  const trava = {
    restante() { const f = lerF(); return f.ate && f.ate > Date.now() ? Math.ceil((f.ate - Date.now()) / 1000) : 0; },
    falhou() { const f = lerF(); const n = (f.ate && f.ate > Date.now() ? f.n : (f.n || 0)) + 1;
      gravaF(n >= 5 ? { n: 0, ate: Date.now() + 60000 } : { n }); },
    limpar() { gravaF({}); },
  };

  return { $, tema, olho, forca, FORCA_TXT, aviso, dica, carregando, msgErro, emailOk, destino, comNext, trava };
})();
