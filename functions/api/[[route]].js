// Portal da Logística — API no Cloudflare Pages (Pages Functions). Contrato em CLOUDFLARE.md.
//
// Bindings (Pages → Settings → Bindings / Variables and secrets):
//   DB              D1 database (schema em db/schema.sql)
//   SESSION_SECRET  secret: assina o cookie de sessão (string longa e aleatória)
//   TOKEN_SECRET    secret: assina o token curto para a API da Azure e o link de redefinir senha
//   EMAIL           binding Cloudflare Email Service (envio) + variável EMAIL_FROM (remetente do domínio verificado)
//
// Login: e-mail + senha (PBKDF2 no próprio Worker). Quem não está em `usuarios` não entra.
// Administradores iniciais (BOOT) são sempre TI, igual a boot() em firestore.rules.

const FERRAMENTAS = ["monitor", "custo", "pedidos"];
// NÍVEL por ferramenta e por pessoa (03/11/2026): ausente = sem acesso · "ver" = abre e lê · "editar" = também altera
// (Monitor: ignorar/reativar NF · Custo: cobertura e bandas · Pedidos: excluir da lista). TI é sempre "editar" em tudo.
const NIVEIS = ["ver", "editar"];
// Modelo de cada perfil: os níveis que a tela aplica ao escolher o perfil de uma pessoa (a pessoa pode ser ajustada depois
// e fica "personalizada"). Guardado em perfis.modelo (JSON); sem a coluna/valor, valem estes.
const MODELO_BASE = {
  ti: { monitor: "editar", custo: "editar", pedidos: "editar" },
  logistica: { monitor: "editar" },
  leitor: { monitor: "ver" },
  faturamento: { monitor: "ver" },
};
const BOOT = ["v.tozeti@pharmaesthetics.com.br", "m.milani@pharmaesthetics.com.br"];
// Perfis: o que cada um PODE FAZER (as ferramentas que a pessoa ABRE continuam por pessoa). Ficam na tabela `perfis` do D1;
// enquanto a tabela não existir (migração não rodada), valem estes. `ti` sempre pode tudo (não dá para tirar e ficar sem admin).
// Permissões = UMA POR FERRAMENTA (pedido do usuário, 27/10). Ferramenta nova do Monitor (ex.: "limpar notas") = 1 linha aqui
// + checar `u.pode.<id>` na rota dela; a tela de perfis mostra a caixinha sozinha. Sem nenhuma do Monitor = só vê travadas e subiram.
// Só DONO_PERFIS cria, altera ou apaga perfis (pedido do usuário, 26/10).
const DONO_PERFIS = "v.tozeti@pharmaesthetics.com.br";
const CATALOGO = [
  { id: "nf_ignorar", nome: "Ignorar e reativar NF", grupo: "Monitor de NFs" },
  { id: "nf_ver_ocultas", nome: "Ver notas ocultas", grupo: "Monitor de NFs" },
  // grava a NF no log mestre do robô (fila na Azure; o robô aplica no próximo ciclo). Padrão: TI e Logística (27/10)
  { id: "nf_ignorar_robo", nome: "Ignorar no robô (e ver o histórico)", grupo: "Monitor de NFs" },
  // Pedidos e fretes (aba do Custo de Frete, 28/10): só administração vê; excluir pedido da lista é do TI. Ninguém além do TI por padrão.
  { id: "pedidos_ver", nome: "Ver Pedidos e fretes", grupo: "Custo de Frete" },
  { id: "pedidos_excluir", nome: "Excluir pedidos da lista", grupo: "Custo de Frete" },
  { id: "admin", nome: "Administrar usuários", grupo: "Portal" },
];
const IDS_PERM = CATALOGO.map((c) => c.id);
const PERFIS_BASE = {
  ti: { rotulo: "TI", perms: IDS_PERM.slice(), sistema: true },
  logistica: { rotulo: "Logística", perms: ["nf_ignorar", "nf_ver_ocultas", "nf_ignorar_robo"], sistema: true },
  leitor: { rotulo: "Somente leitura", perms: [], sistema: true },
  faturamento: { rotulo: "Faturamento", perms: [], sistema: false },
};
// linha da tabela -> lista de permissões. Coluna `permissoes` (JSON) manda; sem ela (migração antiga), vem das colunas fixas.
function permsDaLinha(r) {
  if (r.permissoes) { try { return JSON.parse(r.permissoes).filter((i) => IDS_PERM.includes(i)); } catch (_) {} }
  const l = [];
  if (r.editar_nfs) l.push("nf_ignorar", "nf_ver_ocultas", "nf_ignorar_robo");
  if (r.admin) l.push("admin");
  return l;
}
const podeDe = (perms) => {
  const o = {};
  for (const i of IDS_PERM) o[i] = perms.includes(i);
  o.editar = o.nf_ignorar;               // nome antigo, para telas em cache
  return o;
};
const NOME_PERFIL = /^[a-z][a-z0-9-]{1,29}$/;
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

// objeto {ferramenta: "ver"|"editar"} válido (ids e níveis desconhecidos caem fora)
function limparNiveis(x) {
  const o = {};
  if (x && typeof x === "object") for (const f of FERRAMENTAS) if (NIVEIS.includes(x[f])) o[f] = x[f];
  return o;
}
// Pessoa sem `niveis` gravado (antes de 03/11): deriva do que ela já tinha — ninguém perde nem ganha acesso na virada.
function niveisLegado(perfil, row, P) {
  const f = ferramentasDe(perfil, row), perms = (P[perfil] && P[perfil].perms) || [], n = {};
  if (f.includes("monitor")) n.monitor = perms.includes("nf_ignorar") ? "editar" : "ver";
  if (f.includes("custo")) n.custo = "editar";
  if (perms.includes("pedidos_excluir")) n.pedidos = "editar"; else if (perms.includes("pedidos_ver")) n.pedidos = "ver";
  return n;
}
function niveisDe(perfil, row, P) {
  if (perfil === "ti") return { monitor: "editar", custo: "editar", pedidos: "editar" };
  if (row && row.niveis) { try { return limparNiveis(JSON.parse(row.niveis)); } catch (_) {} }
  return niveisLegado(perfil, row || {}, P);
}
// permissões efetivas = as do PERFIL, ajustadas pelo NÍVEL da pessoa em cada ferramenta
function efetivas(perfil, permsPerfil, niveis) {
  if (perfil === "ti") return IDS_PERM.slice();
  const s = new Set(permsPerfil);
  if (niveis.monitor !== "editar") { s.delete("nf_ignorar"); s.delete("nf_ignorar_robo"); }     // só ver o Monitor: sem ações
  if (niveis.pedidos) { s.add("pedidos_ver"); if (niveis.pedidos === "editar") s.add("pedidos_excluir"); else s.delete("pedidos_excluir"); }
  return [...s];
}
const ordemFerr = (niveis) => FERRAMENTAS.filter((f) => niveis[f]);

// mapa nome -> {rotulo, perms, sistema}. Lido do D1 (1 consulta por requisição); sem a tabela, PERFIS_BASE.
async function lerPerfis(db) {
  let P;
  try {
    const rows = (await db.prepare("SELECT * FROM perfis").all()).results;
    P = {};
    for (const r of rows) {
      let modelo = null;
      if (r.modelo) { try { modelo = limparNiveis(JSON.parse(r.modelo)); } catch (_) {} }
      P[r.nome] = { rotulo: r.rotulo, perms: permsDaLinha(r), sistema: !!r.sistema, modelo: modelo || limparNiveis(MODELO_BASE[r.nome] || { monitor: "ver" }) };
    }
  } catch (_) {
    P = JSON.parse(JSON.stringify(PERFIS_BASE));
  }
  P.ti = { ...(P.ti || PERFIS_BASE.ti), perms: IDS_PERM.slice(), sistema: true, modelo: limparNiveis(MODELO_BASE.ti) };
  for (const n of Object.keys(P)) if (!P[n].modelo) P[n].modelo = limparNiveis(MODELO_BASE[n] || { monitor: "ver" });
  return P;
}
const perfisDo = async (ctx) => (ctx.perfis ||= await lerPerfis(ctx.env.DB));

// perfil efetivo da pessoa, ou null se não está autorizada
async function perfilDe(db, email, P) {
  const row = await db.prepare("SELECT * FROM usuarios WHERE email = ?").bind(email).first();
  if (BOOT.includes(email)) {
    const n = niveisDe("ti", row, P);
    return { email, perfil: "ti", rotulo: P.ti.rotulo, ferramentas: FERRAMENTAS.slice(), niveis: n, acessoCusto: true, pode: { ...podeDe(IDS_PERM), custo_editar: true },
             donoPerfis: email === DONO_PERFIS, temSenha: !!(row && row.senha), ultimoAcesso: row ? row.ultimo_acesso : 0 };
  }
  if (!row || !P[row.perfil]) return null;
  const niveis = niveisDe(row.perfil, row, P), ferramentas = ordemFerr(niveis);
  const pode = { ...podeDe(efetivas(row.perfil, P[row.perfil].perms, niveis)), custo_editar: niveis.custo === "editar" };
  // acesso com validade (valido_ate em ms): vencido = não entra mais (o TI renova na tela). TI/BOOT nunca vencem.
  const expirado = !!(row.valido_ate && row.valido_ate < Date.now() && row.perfil !== "ti");
  return { email, perfil: row.perfil, rotulo: P[row.perfil].rotulo, ferramentas, niveis, acessoCusto: ferramentas.includes("custo"),
           pode, donoPerfis: email === DONO_PERFIS, expirado, validoAte: row.valido_ate || 0,
           temSenha: !!row.senha, ultimoAcesso: row.ultimo_acesso || 0 };
}
const publico = (u) => ({ email: u.email, perfil: u.perfil, rotulo: u.rotulo, ferramentas: u.ferramentas, niveis: u.niveis, acessoCusto: u.acessoCusto, pode: u.pode,
                          donoPerfis: u.donoPerfis, validoAte: u.validoAte || 0 });

async function sessaoAtual(ctx) {
  const p = await verificar(ctx.env.SESSION_SECRET, lerCookie(ctx.request));
  if (!p) return { erro: erro(401, "sem-sessao") };
  const u = await perfilDe(ctx.env.DB, p.e, await perfisDo(ctx));
  if (!u) return { erro: erro(403, "sem-acesso") };
  if (u.expirado) return { erro: erro(403, "acesso-expirado") };
  return { u };
}
// permissão do PERFIL: um id de CATALOGO (ex.: "nf_ignorar", "admin")
function exigir(u, permissao) {
  if (!u.pode || !u.pode[permissao]) throw new Falha(403, "sem-permissao");
}

// Colunas/tabela novas (03/11/2026). Em vez de exigir migração manual, o Worker cria o que falta na 1ª vez que precisa
// (ALTER ... ADD COLUMN é aditivo e seguro) e repete a operação uma vez.
const FALTA_ESTRUTURA = /no such (table|column)|has no column named|no column named/i;
let migrada = false;
async function autoMigrar(db) {
  if (migrada) return;
  const cmds = [
    "ALTER TABLE usuarios ADD COLUMN niveis TEXT",
    "ALTER TABLE usuarios ADD COLUMN valido_ate INTEGER",
    "ALTER TABLE perfis ADD COLUMN modelo TEXT",
    `CREATE TABLE IF NOT EXISTS acessos_log (id INTEGER PRIMARY KEY AUTOINCREMENT, alvo TEXT NOT NULL, por TEXT NOT NULL,
       tipo TEXT NOT NULL, detalhe TEXT, em INTEGER NOT NULL)`,
  ];
  for (const c of cmds) {
    try { await db.prepare(c).run(); } catch (e) { if (!/duplicate column|already exists/i.test(String(e && e.message))) throw e; }
  }
  migrada = true;
}
async function comMigracao(db, fn) {
  try { return await fn(); }
  catch (e) {
    if (!FALTA_ESTRUTURA.test(String(e && e.message))) throw e;
    try { await autoMigrar(db); } catch (_) { throw new Falha(409, "migracao-pendente"); }
    return await fn();
  }
}

// histórico de acessos: quem mudou o acesso de quem. Best-effort: nunca derruba a operação.
async function logAcesso(db, por, alvo, tipo, detalhe) {
  const gravar = () => db.prepare("INSERT INTO acessos_log (alvo, por, tipo, detalhe, em) VALUES (?,?,?,?,?)")
    .bind(alvo, por, tipo, JSON.stringify(detalhe || []), Date.now()).run();
  try { await comMigracao(db, gravar); } catch (e) { console.warn("acessos_log:", e && e.message); }
}
const ROT_FERR = { monitor: "Monitor de NFs", custo: "Custo de Frete", pedidos: "Pedidos e fretes" };
const ROT_NIVEL = (n) => (n === "editar" ? "Editar" : n === "ver" ? "Ver" : "Sem acesso");
const dataBR = (ms) => (ms ? new Date(ms).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "sem validade");
function resumoMudanca(antes, depois) {
  const l = [];
  if (antes.perfil !== depois.perfil) l.push(`Perfil: ${antes.perfil || "—"} → ${depois.perfil}`);
  for (const f of FERRAMENTAS) if (antes.niveis[f] !== depois.niveis[f]) l.push(`${ROT_FERR[f]}: ${ROT_NIVEL(antes.niveis[f])} → ${ROT_NIVEL(depois.niveis[f])}`);
  if ((antes.validoAte || 0) !== (depois.validoAte || 0)) l.push(`Validade: ${dataBR(antes.validoAte)} → ${dataBR(depois.validoAte)}`);
  return l;
}

async function gravarUsuario(db, email, body, P, por) {
  const atual = await db.prepare("SELECT * FROM usuarios WHERE email = ?").bind(email).first();
  let perfil = atual ? atual.perfil : "leitor";
  if (body.perfil !== undefined) {
    if (!P[body.perfil]) throw new Falha(400, "perfil-invalido");
    perfil = body.perfil;
  }
  const niveisAntes = atual ? niveisDe(atual.perfil, atual, P) : {};
  let ferramentas = atual ? atual.ferramentas : null;
  let acesso = atual ? atual.acesso_custo : 0;
  let niveis;                                   // undefined = não mexer na coluna `niveis`
  if (body.niveis !== undefined) {
    if (!body.niveis || typeof body.niveis !== "object" || Array.isArray(body.niveis)) throw new Falha(400, "niveis-invalidos");
    niveis = limparNiveis(body.niveis);
  } else if (body.ferramentas !== undefined) {
    if (!Array.isArray(body.ferramentas) || body.ferramentas.length > 20) throw new Falha(400, "ferramentas-invalidas");
    const lista = body.ferramentas.filter((i) => FERRAMENTAS.includes(i));
    if (atual && atual.niveis) {              // telas antigas em cache: mantém o nível que a pessoa já tinha em cada ferramenta
      niveis = {}; for (const f of lista) niveis[f] = niveisAntes[f] || (f === "monitor" ? "ver" : "editar");
    } else {
      ferramentas = JSON.stringify(lista);
      acesso = lista.includes("custo") ? 1 : 0;
    }
  } else if (typeof body.acessoCusto === "boolean") {
    acesso = body.acessoCusto ? 1 : 0;
  }
  if (niveis !== undefined) { ferramentas = JSON.stringify(ordemFerr(niveis)); acesso = niveis.custo ? 1 : 0; }
  let validoAte;                                // undefined = não mexer
  if (body.validoAte !== undefined) {
    validoAte = body.validoAte === null || body.validoAte === 0 ? null : Number(body.validoAte);
    if (validoAte !== null && !(validoAte > 0)) throw new Falha(400, "validade-invalida");
  }
  const senha = body.resetar_senha === true ? null : (atual ? atual.senha : null);
  const ultimo = atual ? atual.ultimo_acesso : null;
  const cols = ["email", "perfil", "ferramentas", "acesso_custo", "ultimo_acesso", "senha"], vals = [email, perfil, ferramentas, acesso, ultimo, senha];
  if (niveis !== undefined) { cols.push("niveis"); vals.push(JSON.stringify(niveis)); }
  if (validoAte !== undefined) { cols.push("valido_ate"); vals.push(validoAte); }
  const sql = `INSERT INTO usuarios (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(",")})
     ON CONFLICT(email) DO UPDATE SET ${cols.filter((c) => c !== "email" && c !== "ultimo_acesso").map((c) => `${c} = excluded.${c}`).join(", ")}`;
  try {
    await comMigracao(db, () => db.prepare(sql).bind(...vals).run());
  } catch (e) {
    // a tabela antiga só aceita logistica/ti/leitor (CHECK); perfil novo exige a migração de db/schema.sql
    if (/CHECK constraint/i.test(String(e && e.message))) throw new Falha(409, "migracao-pendente");
    throw e;
  }
  // histórico: só o que mudou de verdade
  const depoisRow = { ...(atual || {}), perfil, niveis: niveis !== undefined ? JSON.stringify(niveis) : (atual && atual.niveis) || null,
                      ferramentas, acesso_custo: acesso };
  const depois = { perfil, niveis: niveisDe(perfil, depoisRow, P), validoAte: validoAte !== undefined ? (validoAte || 0) : (atual && atual.valido_ate) || 0 };
  const antes = { perfil: atual ? atual.perfil : null, niveis: niveisAntes, validoAte: (atual && atual.valido_ate) || 0 };
  const mudou = resumoMudanca(antes, depois);
  if (!atual) mudou.unshift("Pessoa adicionada");
  if (body.resetar_senha === true) mudou.push("Senha redefinida");
  if (mudou.length && por) await logAcesso(db, por, email, atual ? "alterou" : "adicionou", mudou);
}

// ---------- perfis (só DONO_PERFIS altera) ----------
async function listarPerfis(ctx) {
  const P = await perfisDo(ctx);
  const uso = {};
  try {
    for (const r of (await ctx.env.DB.prepare("SELECT perfil, COUNT(*) AS n FROM usuarios GROUP BY perfil").all()).results) uso[r.perfil] = r.n;
  } catch (_) {}
  const perfis = Object.entries(P).map(([nome, x]) => ({ nome, rotulo: x.rotulo, permissoes: x.perms, modelo: x.modelo, sistema: x.sistema, pessoas: uso[nome] || 0 }))
    .sort((a, b) => (b.sistema - a.sistema) || a.rotulo.localeCompare(b.rotulo));
  return { catalogo: CATALOGO, ferramentas: FERRAMENTAS.map((id) => ({ id, nome: ROT_FERR[id] })), perfis };
}
async function gravarPerfil(ctx, nome, body) {
  if (!NOME_PERFIL.test(nome)) throw new Falha(400, "nome-invalido");
  const P = await perfisDo(ctx);
  const rotulo = texto(body.rotulo).trim().slice(0, 40) || (P[nome] && P[nome].rotulo) || nome;
  if (body.permissoes !== undefined && (!Array.isArray(body.permissoes) || body.permissoes.length > 50)) throw new Falha(400, "permissoes-invalidas");
  let perms = body.permissoes !== undefined ? [...new Set(body.permissoes.filter((i) => IDS_PERM.includes(i)))] : ((P[nome] && P[nome].perms) || []);
  if (nome === "ti") perms = IDS_PERM.slice();
  const sistema = P[nome] && P[nome].sistema ? 1 : 0;
  let modelo;                                  // undefined = não mexer
  if (body.modelo !== undefined) {
    if (!body.modelo || typeof body.modelo !== "object" || Array.isArray(body.modelo)) throw new Falha(400, "modelo-invalido");
    modelo = nome === "ti" ? limparNiveis(MODELO_BASE.ti) : limparNiveis(body.modelo);
  }
  const cols = ["nome", "rotulo", "editar_nfs", "admin", "sistema", "permissoes"];
  const vals = [nome, rotulo, perms.includes("nf_ignorar") ? 1 : 0, perms.includes("admin") ? 1 : 0, sistema, JSON.stringify(perms)];
  if (modelo !== undefined) { cols.push("modelo"); vals.push(JSON.stringify(modelo)); }
  try {
    await comMigracao(ctx.env.DB, () => ctx.env.DB.prepare(
      `INSERT INTO perfis (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(",")})
       ON CONFLICT(nome) DO UPDATE SET ${cols.filter((c) => c !== "nome").map((c) => `${c} = excluded.${c}`).join(", ")}`
    ).bind(...vals).run());
    await logAcesso(ctx.env.DB, ctx.u ? ctx.u.email : "", "perfil:" + nome, "perfil", [
      "Perfil salvo" + (body.permissoes !== undefined ? " (permissões)" : "") + (modelo !== undefined ? " (modelo de níveis)" : "")]);
  } catch (e) {
    if (/no such (table|column)|has no column/i.test(String(e && e.message))) throw new Falha(409, "migracao-pendente");
    throw e;
  }
  ctx.perfis = null;
}
async function apagarPerfil(ctx, nome) {
  const P = await perfisDo(ctx);
  if (!P[nome]) throw new Falha(404, "nao-encontrado");
  if (P[nome].sistema) throw new Falha(409, "perfil-do-sistema");
  const r = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE perfil = ?").bind(nome).first();
  if (r && r.n) throw new Falha(409, "perfil-em-uso", { pessoas: r.n });
  await ctx.env.DB.prepare("DELETE FROM perfis WHERE nome = ?").bind(nome).run();
  ctx.perfis = null;
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

  const u = await perfilDe(db, email, await perfisDo(ctx));
  if (!u) { await registrarFalha(db, kE); await registrarFalha(db, kI); return erro(401, "credenciais"); }
  if (u.expirado) return erro(403, "acesso-expirado");
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
  const u = await perfilDe(db, email, await perfisDo(ctx));
  return abrirSessao(ctx, u);
}

// ---------- esqueci a senha (autoatendimento) ----------
// Fluxo: /api/esqueci manda por e-mail um link de uso único (30 min) → redefinir.html → /api/redefinir.
// O link leva um token assinado (TOKEN_SECRET) com o e-mail e o "carimbo" da senha atual; ao trocar a senha o carimbo muda
// e o link morre (uso único). Só e-mail JÁ cadastrado recebe; a resposta é sempre a mesma (não revela quem tem conta).
const RESET_S = 30 * 60;
const carimbo = (guardado) => (guardado ? guardado.slice(-12) : "-");
function emailReset(link) {
  const texto = `Você pediu para redefinir a senha do Portal da Logística.

Abra o link (vale 30 minutos e só funciona uma vez):
${link}

Se não foi você, ignore este e-mail: nada muda na sua conta.`;
  const html = `<p>Você pediu para redefinir a senha do <b>Portal da Logística</b>.</p><p><a href="${link}">Criar nova senha</a></p>` +
    `<p>O link vale 30 minutos e só funciona uma vez.</p><p style="color:#666">Se não foi você, ignore este e-mail: nada muda na sua conta.</p>`;
  return { texto, html };
}
async function esqueciSenha(ctx, body) {
  const db = ctx.env.DB;
  let email;
  try { email = normEmail(body.email); } catch (_) { return json({ ok: true }); }
  const kE = "rs:" + email, kI = "rsip:" + ipDe(ctx.request);
  // limite de pedidos (por e-mail e por IP): evita encher a caixa de alguém. Bloqueado = responde igual, sem enviar.
  if ((await segundosBloqueado(db, kE)) || (await segundosBloqueado(db, kI))) return json({ ok: true });
  await registrarFalha(db, kE); await registrarFalha(db, kI);

  const row = await db.prepare("SELECT email, senha, valido_ate FROM usuarios WHERE email = ?").bind(email).first()
    .catch(() => db.prepare("SELECT email, senha FROM usuarios WHERE email = ?").bind(email).first());
  if (!row) return json({ ok: true });
  if (row.valido_ate && row.valido_ate < Date.now()) return json({ ok: true });
  if (!ctx.env.EMAIL || !ctx.env.EMAIL_FROM) { console.error("esqueci: binding EMAIL / variável EMAIL_FROM ausente"); return json({ ok: true }); }

  const exp = Math.floor(Date.now() / 1000) + RESET_S;
  const tok = await assinar(ctx.env.TOKEN_SECRET, { e: email, k: "rs", h: carimbo(row.senha), exp });
  const link = new URL(ctx.request.url).origin + "/redefinir.html#t=" + tok;     // # = não vai para logs de servidor
  const { texto, html } = emailReset(link);
  try {
    await ctx.env.EMAIL.send({ to: email, from: ctx.env.EMAIL_FROM, subject: "Redefinir sua senha — Portal da Logística", text: texto, html });
    await logAcesso(db, email, email, "senha", ["Pediu redefinição de senha por e-mail"]);
  } catch (e) { console.error("esqueci: falha no envio:", e && e.message); }
  return json({ ok: true });
}
async function redefinirSenha(ctx, body) {
  const db = ctx.env.DB;
  const senha = String(body.senha || "");
  if (senha.length < 8) return erro(400, "senha-curta");
  const kI = "ip:" + ipDe(ctx.request);
  const espera = await segundosBloqueado(db, kI);
  if (espera) return erro(429, "bloqueado", { segundos: espera });
  const p = await verificar(ctx.env.TOKEN_SECRET, String(body.token || ""));
  const row = p && p.k === "rs" ? await db.prepare("SELECT email, senha, valido_ate FROM usuarios WHERE email = ?").bind(p.e).first()
    .catch(() => db.prepare("SELECT email, senha FROM usuarios WHERE email = ?").bind(p.e).first()) : null;
  if (!row || carimbo(row.senha) !== p.h || (row.valido_ate && row.valido_ate < Date.now())) {
    await registrarFalha(db, kI);
    return erro(400, "link-invalido");
  }
  await db.prepare("UPDATE usuarios SET senha = ?, ultimo_acesso = ? WHERE email = ?")
    .bind(await hashSenha(senha), Date.now(), row.email).run();
  await limparFalhas(db, "e:" + row.email);
  await logAcesso(db, row.email, row.email, "senha", ["Redefiniu a senha pelo link do e-mail"]);
  const u = await perfilDe(db, row.email, await perfisDo(ctx));
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

// ---------- diagnóstico ----------
async function saude(env) {
  const r = { db: !!env.DB, session_secret: !!env.SESSION_SECRET, token_secret: !!env.TOKEN_SECRET, email_envio: !!(env.EMAIL && env.EMAIL_FROM), tabelas: {} };
  if (env.DB) {
    for (const t of ["usuarios", "acoes", "acoes_log", "tentativas", "perfis", "acessos_log"]) {
      try { await env.DB.prepare(`SELECT 1 FROM ${t} LIMIT 1`).all(); r.tabelas[t] = "ok"; }
      catch (e) { r.tabelas[t] = String(e && e.message || e).slice(0, 120); }
    }
    try { await env.DB.prepare("SELECT senha FROM usuarios LIMIT 1").all(); r.coluna_senha = "ok"; }
    catch (e) { r.coluna_senha = String(e && e.message || e).slice(0, 120); }
  }
  return json(r);
}

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

  // diagnóstico de configuração (só diz sim/não — nenhum valor): útil logo após o deploy
  if (a === "saude" && m === "GET") return saude(env);

  if (a === "login" && m === "POST") return login(ctx, await corpo());
  if (a === "primeiro-acesso" && m === "POST") return primeiroAcesso(ctx, await corpo());
  if (a === "esqueci" && m === "POST") return esqueciSenha(ctx, await corpo());
  if (a === "redefinir" && m === "POST") return redefinirSenha(ctx, await corpo());
  if (a === "logout" && m === "POST") return json({ ok: true }, 200, { "Set-Cookie": cookie("", 0) });

  const sess = await sessaoAtual(ctx);
  if (sess.erro) return sess.erro;
  const u = sess.u;

  if (a === "me" && m === "GET") return json(publico(u));
  if (a === "senha" && m === "POST") return trocarSenha(ctx, u, await corpo());

  if (a === "token" && m === "GET") {
    const exp = Math.floor(Date.now() / 1000) + TOKEN_S;
    // "r" = pode ignorar NF no robô: a Azure confere este claim nas rotas /v1/portal/ignorar
    // "pv"/"px" = Pedidos e fretes (ver / excluir): a Azure confere em /v1/portal/pedidos*
    // "ce" = nível EDITAR no Custo de Frete (ver = só leitura): a Azure barra a gravação de cobertura e banda sem ele
    const token = await assinar(env.TOKEN_SECRET, { e: u.email, p: u.perfil, c: u.acessoCusto, r: !!(u.pode && u.pode.nf_ignorar_robo),
                                                   pv: !!(u.pode && u.pode.pedidos_ver), px: !!(u.pode && u.pode.pedidos_excluir),
                                                   ce: !!(u.pode && u.pode.custo_editar), exp });
    return json({ token, exp });
  }

  if (a === "acessos-log" && m === "GET") {
    exigir(u, "admin");
    const lim = Math.min(Math.max(parseInt(new URL(request.url).searchParams.get("limite") || "100", 10) || 100, 1), 300);
    let rows = [];
    try { rows = (await env.DB.prepare("SELECT alvo, por, tipo, detalhe, em FROM acessos_log ORDER BY em DESC, id DESC LIMIT ?").bind(lim).all()).results; }
    catch (e) { if (!FALTA_ESTRUTURA.test(String(e && e.message))) throw e; }          // tabela ainda não criada: histórico vazio
    return json(rows.map((r) => { let d = []; try { d = JSON.parse(r.detalhe || "[]"); } catch (_) {} return { alvo: r.alvo, por: r.por, tipo: r.tipo, detalhe: d, em: r.em }; }));
  }

  if (a === "perfis") {
    ctx.u = u;
    if (!b && m === "GET") { exigir(u, "admin"); return json(await listarPerfis(ctx)); }
    if (u.email !== DONO_PERFIS) throw new Falha(403, "sem-permissao");
    if (b && m === "PUT") { await gravarPerfil(ctx, b, await corpo()); return json(await listarPerfis(ctx)); }
    if (b && m === "DELETE") { await apagarPerfil(ctx, b); return json(null, 204); }
  }

  if (a === "usuarios") {
    exigir(u, "admin");
    const P = await perfisDo(ctx);
    if (!b && m === "GET") {
      const rows = (await env.DB.prepare("SELECT * FROM usuarios ORDER BY email").all()).results;
      return json(rows.map((r) => {
        const f = ferramentasDe(r.perfil, r);
        const n = niveisDe(r.perfil, r, P);
        return { email: r.email, perfil: r.perfil, ferramentas: ordemFerr(n), niveis: n, acessoCusto: !!n.custo, ultimoAcesso: r.ultimo_acesso || 0,
                 validoAte: r.valido_ate || 0, personalizado: !!r.niveis };
      }));
    }
    if (b === "lote" && m === "POST") {
      const body = await corpo();
      if (!Array.isArray(body.itens) || body.itens.length > 100) throw new Falha(400, "lote-invalido");
      for (const it of body.itens) await gravarUsuario(env.DB, normEmail(it.email), it, P, u.email);
      return json({ ok: true });
    }
    if (b && m === "PUT") { await gravarUsuario(env.DB, normEmail(b), await corpo(), P, u.email); return json({ ok: true }); }
    if (b && m === "DELETE") {
      const alvo = normEmail(b);
      await env.DB.prepare("DELETE FROM usuarios WHERE email = ?").bind(alvo).run();
      await logAcesso(env.DB, u.email, alvo, "removeu", ["Acesso removido do portal"]);
      return json(null, 204);
    }
  }

  if (a === "acoes") {
    if (!b && m === "GET") {
      const l = (await env.DB.prepare("SELECT id, tipo, motivo, nf, filial, em FROM acoes").all()).results;
      // quem não vê as ocultas recebe só o id (o Monitor precisa para tirar a nota da lista), sem motivo nem quem/quando
      return json(u.pode.nf_ver_ocultas ? l : l.map((a) => ({ id: a.id, tipo: a.tipo })));
    }
    if (b === "log" && m === "GET") {
      exigir(u, "admin");
      const id = new URL(request.url).searchParams.get("id") || "";
      const r = await env.DB.prepare(
        "SELECT acao, tipo, motivo, por, em FROM acoes_log WHERE nf_id = ? ORDER BY em DESC, id DESC LIMIT 1"
      ).bind(id).first();
      return json(r || null);
    }
    exigir(u, "nf_ignorar");
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
