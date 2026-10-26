// Portal da Logística — API no Cloudflare Pages (Pages Functions). Contrato em CLOUDFLARE.md.
//
// Bindings (Pages → Settings → Bindings / Variables and secrets):
//   DB              D1 database (schema em db/schema.sql)
//   SESSION_SECRET  secret: assina o cookie de sessão (string longa e aleatória)
//   TOKEN_SECRET    secret: assina o token curto para a API da Azure
//
// Login: e-mail + senha (PBKDF2 no próprio Worker). Quem não está em `usuarios` não entra.
// Administradores iniciais (BOOT) são sempre TI, igual a boot() em firestore.rules.

const PERFIS = ["logistica", "ti", "leitor"];
const FERRAMENTAS = ["monitor", "custo"];
const BOOT = ["v.tozeti@pharmaesthetics.com.br", "m.milani@pharmaesthetics.com.br"];
const ITERACOES = 100000;          // limite do PBKDF2 no runtime do Workers
const SESSAO_S = 12 * 3600;
const TOKEN_S = 300;
const MAX_FALHAS = 5;
const BLOQUEIO_S = 15 * 60;

const enc = new TextEncoder();
const dec = new TextDecoder();

class Falha extends Error {
  constructor(status, codigo, extra) { super(codigo); this.status = status; this.extra = extra || {}; }
}

const json = (obj, status = 200, headers = {}) =>
  new Response(obj === null ? null : JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
const erro = (status, codigo, extra) => json({ erro: codigo, ...(extra || {}) }, status);

// ---------- base64url + HMAC ----------
function b64u(buf) {
  let s = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64u(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
async function chaveHmac(segredo) {
  if (!segredo) throw new Falha(500, "segredo-ausente");
  return crypto.subtle.importKey("raw", enc.encode(segredo), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function assinar(segredo, payload) {
  const corpo = b64u(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await chaveHmac(segredo), enc.encode(corpo));
  return corpo + "." + b64u(sig);
}
async function verificar(segredo, token) {
  const [corpo, sig] = (token || "").split(".");
  if (!corpo || !sig) return null;
  const ok = await crypto.subtle.verify("HMAC", await chaveHmac(segredo), unb64u(sig), enc.encode(corpo));
  if (!ok) return null;
  const p = JSON.parse(dec.decode(unb64u(corpo)));
  return p.exp > Date.now() / 1000 ? p : null;
}

// ---------- senha ----------
async function derivar(senha, salt, iter) {
  const base = await crypto.subtle.importKey("raw", enc.encode(senha), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" }, base, 256);
}
async function hashSenha(senha) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERACOES}$${b64u(salt)}$${b64u(await derivar(senha, salt, ITERACOES))}`;
}
async function confereSenha(senha, guardado) {
  if (!guardado) return false;
  const [, iter, s, h] = guardado.split("$");
  const a = new Uint8Array(await derivar(senha, unb64u(s), Number(iter)));
  const b = unb64u(h);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------- cookie ----------
const COOKIE = "pt_sess";
const cookie = (valor, max) => `${COOKIE}=${valor}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${max}`;
function lerCookie(request) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp("(?:^|;\\s*)" + COOKIE + "=([^;]+)"));
  return m ? m[1] : null;
}

// ---------- usuários ----------
const normEmail = (e) => {
  const x = String(e || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)) throw new Falha(400, "email-invalido");
  return x;
};
const texto = (x) => (x == null ? "" : String(x).slice(0, 300));

function ferramentasDe(perfil, row) {
  if (perfil === "ti") return FERRAMENTAS.slice();
  if (row.ferramentas) {
    try { return JSON.parse(row.ferramentas).filter((i) => FERRAMENTAS.includes(i)); } catch (_) {}
  }
  return row.acesso_custo ? ["monitor", "custo"] : ["monitor"];
}

// perfil efetivo da pessoa, ou null se não está autorizada
async function perfilDe(db, email) {
  const row = await db.prepare("SELECT * FROM usuarios WHERE email = ?").bind(email).first();
  if (BOOT.includes(email)) {
    return { email, perfil: "ti", ferramentas: FERRAMENTAS.slice(), acessoCusto: true, temSenha: !!(row && row.senha), ultimoAcesso: row ? row.ultimo_acesso : 0 };
  }
  if (!row || !PERFIS.includes(row.perfil)) return null;
  const ferramentas = ferramentasDe(row.perfil, row);
  return { email, perfil: row.perfil, ferramentas, acessoCusto: ferramentas.includes("custo"), temSenha: !!row.senha, ultimoAcesso: row.ultimo_acesso || 0 };
}
const publico = (u) => ({ email: u.email, perfil: u.perfil, ferramentas: u.ferramentas, acessoCusto: u.acessoCusto });

async function sessaoAtual(ctx) {
  const p = await verificar(ctx.env.SESSION_SECRET, lerCookie(ctx.request));
  if (!p) return { erro: erro(401, "sem-sessao") };
  const u = await perfilDe(ctx.env.DB, p.e);
  if (!u) return { erro: erro(403, "sem-acesso") };
  return { u };
}
function exigir(u, perfis) {
  if (!perfis.includes(u.perfil)) throw new Falha(403, "sem-permissao");
}

async function gravarUsuario(db, email, body) {
  const atual = await db.prepare("SELECT * FROM usuarios WHERE email = ?").bind(email).first();
  let perfil = atual ? atual.perfil : "leitor";
  if (body.perfil !== undefined) {
    if (!PERFIS.includes(body.perfil)) throw new Falha(400, "perfil-invalido");
    perfil = body.perfil;
  }
  let ferramentas = atual ? atual.ferramentas : null;
  let acesso = atual ? atual.acesso_custo : 0;
  if (body.ferramentas !== undefined) {
    if (!Array.isArray(body.ferramentas) || body.ferramentas.length > 20) throw new Falha(400, "ferramentas-invalidas");
    const lista = body.ferramentas.filter((i) => FERRAMENTAS.includes(i));
    ferramentas = JSON.stringify(lista);
    acesso = lista.includes("custo") ? 1 : 0;
  } else if (typeof body.acessoCusto === "boolean") {
    acesso = body.acessoCusto ? 1 : 0;
  }
  const senha = body.resetar_senha === true ? null : (atual ? atual.senha : null);
  const ultimo = atual ? atual.ultimo_acesso : null;
  await db.prepare(
    `INSERT INTO usuarios (email, perfil, ferramentas, acesso_custo, ultimo_acesso, senha) VALUES (?,?,?,?,?,?)
     ON CONFLICT(email) DO UPDATE SET perfil = excluded.perfil, ferramentas = excluded.ferramentas,
       acesso_custo = excluded.acesso_custo, senha = excluded.senha`
  ).bind(email, perfil, ferramentas, acesso, ultimo, senha).run();
}

// ---------- limite de tentativas (por e-mail e por IP) ----------
const ipDe = (request) => request.headers.get("CF-Connecting-IP") || "sem-ip";
async function segundosBloqueado(db, chave) {
  const r = await db.prepare("SELECT n, ate FROM tentativas WHERE chave = ?").bind(chave).first();
  const agora = Date.now();
  return r && r.ate > agora ? Math.ceil((r.ate - agora) / 1000) : 0;
}
async function registrarFalha(db, chave) {
  const r = await db.prepare("SELECT n, ate FROM tentativas WHERE chave = ?").bind(chave).first();
  const agora = Date.now();
  let atual = 0;
  if (r) atual = r.ate > agora ? r.n : (r.ate > 0 ? 0 : r.n);
  const n = atual + 1;
  const trava = n >= MAX_FALHAS;
  await db.prepare(
    "INSERT INTO tentativas (chave, n, ate) VALUES (?,?,?) ON CONFLICT(chave) DO UPDATE SET n = excluded.n, ate = excluded.ate"
  ).bind(chave, trava ? 0 : n, trava ? agora + BLOQUEIO_S * 1000 : 0).run();
}
async function limparFalhas(db, chave) {
  await db.prepare("DELETE FROM tentativas WHERE chave = ?").bind(chave).run();
}

// ---------- sessão ----------
async function abrirSessao(ctx, u) {
  const exp = Math.floor(Date.now() / 1000) + SESSAO_S;
  const tok = await assinar(ctx.env.SESSION_SECRET, { e: u.email, exp });
  return json(publico(u), 200, { "Set-Cookie": cookie(tok, SESSAO_S) });
}

async function login(ctx, body) {
  const db = ctx.env.DB;
  const email = normEmail(body.email);
  const senha = String(body.senha || "");
  const kE = "e:" + email, kI = "ip:" + ipDe(ctx.request);
  const espera = Math.max(await segundosBloqueado(db, kE), await segundosBloqueado(db, kI));
  if (espera) return erro(429, "bloqueado", { segundos: espera });

  const u = await perfilDe(db, email);
  if (!u) { await registrarFalha(db, kE); await registrarFalha(db, kI); return erro(401, "credenciais"); }
  if (!u.temSenha) return erro(409, "primeiro-acesso");

  const row = await db.prepare("SELECT senha FROM usuarios WHERE email = ?").bind(email).first();
  if (!(await confereSenha(senha, row.senha))) {
    await registrarFalha(db, kE); await registrarFalha(db, kI);
    return erro(401, "credenciais");
  }
  await limparFalhas(db, kE);
  await db.prepare("UPDATE usuarios SET ultimo_acesso = ? WHERE email = ?").bind(Date.now(), email).run();
  return abrirSessao(ctx, { ...u, ultimoAcesso: Date.now() });
}

// Primeiro acesso: a pessoa define a própria senha. Só vale para e-mail autorizado SEM senha ainda.
async function primeiroAcesso(ctx, body) {
  const db = ctx.env.DB;
  const email = normEmail(body.email);
  const senha = String(body.senha || "");
  const kE = "e:" + email, kI = "ip:" + ipDe(ctx.request);
  const espera = Math.max(await segundosBloqueado(db, kE), await segundosBloqueado(db, kI));
  if (espera) return erro(429, "bloqueado", { segundos: espera });
  if (senha.length < 8) return erro(400, "senha-curta");

  const row = await db.prepare("SELECT email, senha FROM usuarios WHERE email = ?").bind(email).first();
  if (!row) {
    if (!BOOT.includes(email)) { await registrarFalha(db, kE); await registrarFalha(db, kI); return erro(403, "sem-acesso"); }
    await db.prepare("INSERT INTO usuarios (email, perfil, ferramentas, acesso_custo) VALUES (?, 'ti', NULL, 1)").bind(email).run();
  } else if (row.senha) {
    return erro(409, "senha-ja-definida");
  }
  await db.prepare("UPDATE usuarios SET senha = ?, ultimo_acesso = ? WHERE email = ?")
    .bind(await hashSenha(senha), Date.now(), email).run();
  const u = await perfilDe(db, email);
  return abrirSessao(ctx, u);
}

async function trocarSenha(ctx, u, body) {
  const db = ctx.env.DB;
  const row = await db.prepare("SELECT senha FROM usuarios WHERE email = ?").bind(u.email).first();
  if (!row || !(await confereSenha(String(body.atual || ""), row.senha))) return erro(401, "credenciais");
  const nova = String(body.nova || "");
  if (nova.length < 8) return erro(400, "senha-curta");
  await db.prepare("UPDATE usuarios SET senha = ? WHERE email = ?").bind(await hashSenha(nova), u.email).run();
  return json({ ok: true });
}

// ---------- ações ----------
const logStmt = (db, nfId, acao, tipo, motivo, por, em) =>
  db.prepare("INSERT INTO acoes_log (nf_id, acao, tipo, motivo, por, em) VALUES (?,?,?,?,?,?)")
    .bind(nfId, acao, tipo, motivo, por, em);

// ---------- roteador ----------
export async function onRequest(ctx) {
  try {
    return await rotear(ctx);
  } catch (e) {
    if (e instanceof Falha) return erro(e.status, e.message, e.extra);
    console.error("api:", e && e.stack ? e.stack : e);
    return erro(500, "servidor");
  }
}

async function rotear(ctx) {
  const { request, env } = ctx;
  const m = request.method;
  const [a, b] = (ctx.params.route || []).map((s) => decodeURIComponent(s));

  // corpo JSON obrigatório em POST/PUT (um formulário de outro site não consegue mandar isso; reforça o SameSite)
  const corpo = async () => {
    if (!(request.headers.get("Content-Type") || "").includes("application/json")) throw new Falha(415, "json-obrigatorio");
    try { return await request.json(); } catch (_) { throw new Falha(400, "json-invalido"); }
  };

  if (a === "login" && m === "POST") return login(ctx, await corpo());
  if (a === "primeiro-acesso" && m === "POST") return primeiroAcesso(ctx, await corpo());
  if (a === "logout" && m === "POST") return json({ ok: true }, 200, { "Set-Cookie": cookie("", 0) });

  const sess = await sessaoAtual(ctx);
  if (sess.erro) return sess.erro;
  const u = sess.u;

  if (a === "me" && m === "GET") return json(publico(u));
  if (a === "senha" && m === "POST") return trocarSenha(ctx, u, await corpo());

  if (a === "token" && m === "GET") {
    const exp = Math.floor(Date.now() / 1000) + TOKEN_S;
    const token = await assinar(env.TOKEN_SECRET, { e: u.email, p: u.perfil, exp });
    return json({ token, exp });
  }

  if (a === "usuarios") {
    exigir(u, ["ti"]);
    if (!b && m === "GET") {
      const rows = (await env.DB.prepare("SELECT * FROM usuarios ORDER BY email").all()).results;
      return json(rows.map((r) => {
        const f = ferramentasDe(r.perfil, r);
        return { email: r.email, perfil: r.perfil, ferramentas: f, acessoCusto: f.includes("custo"), ultimoAcesso: r.ultimo_acesso || 0 };
      }));
    }
    if (b === "lote" && m === "POST") {
      const body = await corpo();
      if (!Array.isArray(body.itens) || body.itens.length > 100) throw new Falha(400, "lote-invalido");
      for (const it of body.itens) await gravarUsuario(env.DB, normEmail(it.email), it);
      return json({ ok: true });
    }
    if (b && m === "PUT") { await gravarUsuario(env.DB, normEmail(b), await corpo()); return json({ ok: true }); }
    if (b && m === "DELETE") {
      await env.DB.prepare("DELETE FROM usuarios WHERE email = ?").bind(normEmail(b)).run();
      return json(null, 204);
    }
  }

  if (a === "acoes") {
    if (!b && m === "GET") {
      return json((await env.DB.prepare("SELECT id, tipo, motivo, nf, filial, em FROM acoes").all()).results);
    }
    if (b === "log" && m === "GET") {
      exigir(u, ["ti"]);
      const id = new URL(request.url).searchParams.get("id") || "";
      const r = await env.DB.prepare(
        "SELECT acao, tipo, motivo, por, em FROM acoes_log WHERE nf_id = ? ORDER BY em DESC, id DESC LIMIT 1"
      ).bind(id).first();
      return json(r || null);
    }
    exigir(u, ["logistica", "ti"]);
    if (b && m === "PUT") {
      const body = await corpo();
      if (!["ignorada", "tratada"].includes(body.tipo)) throw new Falha(400, "tipo-invalido");
      const agora = Date.now();
      await env.DB.batch([
        env.DB.prepare("INSERT OR REPLACE INTO acoes (id, tipo, motivo, nf, filial, em) VALUES (?,?,?,?,?,?)")
          .bind(b, body.tipo, texto(body.motivo), texto(body.nf), texto(body.filial), agora),
        logStmt(env.DB, b, "ocultar", body.tipo, texto(body.motivo), u.email, agora),
      ]);
      return json({ ok: true });
    }
    if (b && m === "DELETE") {
      const agora = Date.now();
      await env.DB.batch([
        env.DB.prepare("DELETE FROM acoes WHERE id = ?").bind(b),
        logStmt(env.DB, b, "reativar", "", "", u.email, agora),
      ]);
      return json(null, 204);
    }
  }

  throw new Falha(404, "nao-encontrado");
}
