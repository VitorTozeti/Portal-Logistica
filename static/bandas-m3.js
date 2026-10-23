/* Banda do M3 — editor montado dentro de "Regras da escolha" (custo.html).
   Uso: BandasM3.montar(elementoRaiz, { api, toast, msgErro })
     api(metodo, caminho, corpo) -> Promise (já com login Firebase), toast(msg, {erro}), msgErro(e) -> texto.
   Rotas da Azure (mesmo login do Custo de Frete): GET /v1/cobertura/banda, GET .../banda/impacto?uf=,
   POST .../banda/validar, PUT .../banda. Regras do motor em banda.py / escolha.py (Azure).
   Layout (23/10): lista de estados como na Cobertura (por região, com busca) + painel do estado com as 3 regras.
   Escolha: clicar na linha — a escolhida fica verde. A 1ª linha de cada regra é a "★ Recomendada (padrão)":
   é o que a Azure usa enquanto não houver banda salva (M3 é o único método; não há mais "sem banda"/Ponderada). */
(function(){
"use strict";
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const SEG = [["CAPITAL", "Capital", "a capital do estado"], ["INTERIOR", "Interior", "demais cidades do estado"],
             ["DISTRIBUIDOR", "Distribuidor", "cliente distribuidor, qualquer cidade"]];
const nf = (v, d) => v.toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtR = v => (v < 0 ? "−" : "") + "R$ " + nf(Math.abs(v), 0);
const fmtP = v => nf(v * 100, 1) + "%";
const fmtD = v => (v > 1e-9 ? "+" : v < -1e-9 ? "−" : "") + nf(Math.abs(v), 2) + " d";
const fmtB = b => nf(b, 1);
const CAPITAIS = {"AC":"1200401","AL":"2704302","AM":"1302603","AP":"1600303","BA":"2927408","CE":"2304400","DF":"5300108","ES":"3205309","GO":"5208707","MA":"2111300","MG":"3106200","MS":"5002704","MT":"5103403","PA":"1501402","PB":"2507507","PE":"2611606","PI":"2211001","PR":"4106902","RJ":"3304557","RN":"2408102","RO":"1100205","RR":"1400100","RS":"4314902","SC":"4205407","SE":"2800308","SP":"3550308","TO":"1721000"};
const igual = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-9;

const CSS = `
.bm{--bm-verde:var(--at,#047857);--bm-tinta:#ffffff}
:root[data-theme="dark"] .bm{--bm-tinta:#03251a}
.bm-topo h3{margin:0 0 4px;font-size:16px}
.bm-esq{position:sticky;top:12px;display:grid;gap:8px;min-inline-size:0}
.bm-esq .ufs{position:static;max-height:calc(100dvh - 300px);min-height:260px}
.bm-esq input[type=search]{inline-size:100%;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;font-size:15px}
.bm-esq input[type=search]:focus-visible{outline:2px solid var(--brand);outline-offset:1px}
.bm-vazio-uf{padding:14px 12px;color:var(--soft);font-size:14.5px}
.bm-cabuf{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:baseline;margin:0 0 10px}
.bm-cabuf h3{margin:0;font-size:20px} .bm-cabuf .bm-info{font-size:14px}
.bm-info,.bm-mudo{color:var(--soft);font-size:14px}
.bm-card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin:0 0 14px}
.bm-card h4{margin:0 0 4px;font-size:16px;color:var(--brand)}
.bm-esc{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:10px 0}
.bm-esc .bm-atual{font-size:14.5px}
.bm-esc .bm-atual b{color:var(--bm-verde)}
.bm-tab{overflow-x:auto;border:1px solid var(--line);border-radius:10px;margin:8px 0 6px}
.bm-tab table{inline-size:100%;border-collapse:collapse;min-inline-size:660px;font-size:14px}
.bm-tab th,.bm-tab td{text-align:right;white-space:nowrap;padding:8px 10px;border-bottom:1px solid var(--line)}
.bm-tab th{color:var(--soft);font-size:13.5px;font-weight:600}
.bm-tab th:first-child,.bm-tab td:first-child{text-align:left}
.bm-tab tbody tr{cursor:pointer}
.bm-tab tbody tr:hover{background:color-mix(in srgb,var(--bm-verde) 7%,transparent)}
.bm-tab tbody tr:last-child td{border-bottom:0}
.bm-tab td:first-child label{display:inline-flex;gap:8px;align-items:center;cursor:pointer;font-weight:700}
.bm-tab input[type=radio]{accent-color:var(--bm-verde);inline-size:16px;block-size:16px;margin:0;cursor:pointer}
.bm-tab input[type=radio]:focus-visible{outline:2px solid var(--bm-verde);outline-offset:2px}
.bm-tab tr.bm-sel{background:color-mix(in srgb,var(--bm-verde) 30%,var(--card));box-shadow:inset 6px 0 0 var(--bm-verde);font-weight:700}
.bm-tab tr.bm-sel td{border-bottom-color:color-mix(in srgb,var(--bm-verde) 40%,transparent)}
.bm-tab tr.bm-sel td:first-child label{color:var(--ink)}
.bm-tab tr.bm-sel td:first-child label::after{content:"✓ escolhida";font-size:13px;font-weight:800;margin-left:6px;padding:2px 10px;border-radius:9999px;background:var(--bm-verde);color:var(--bm-tinta)}
.bm-tab tr.bm-estr:not(.bm-rec) td:first-child label span::after{content:" ★";color:var(--alerta)}
.bm-tab tr.bm-rec td{border-bottom:2px solid var(--line)}
.bm-tab tr.bm-rec td:first-child label span{white-space:nowrap}
.bm-tab tr.bm-rec .bm-sub{display:block;font-size:12.5px;font-weight:400;color:var(--soft)}
.bm-tab tr.bm-rec.bm-sel .bm-sub{color:var(--ink)}
.bm-pos{color:var(--at)} .bm-neg{color:var(--bq)}
.bm-tab td.bm-mix{white-space:normal;text-align:left;min-width:160px;font-size:13px;color:var(--soft)}
.bm-bloqbox{margin:8px 0;padding:10px 12px;border-radius:10px;font-size:14px;line-height:1.5;
  background:color-mix(in srgb,var(--alerta) 14%,var(--card));border:1px solid color-mix(in srgb,var(--alerta) 55%,transparent)}
.bm-bloqbox b{color:var(--ink)}
.bm-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:0 0 10px;font-size:13.5px;color:var(--soft)}
.bm-chip{display:inline-flex;gap:5px;align-items:center;border:1px solid color-mix(in srgb,var(--bq) 55%,transparent);border-radius:9999px;padding:2px 10px;
  font-weight:700;color:var(--bq);background:color-mix(in srgb,var(--bq) 10%,transparent)}
.bm-mixb{text-decoration:line-through;text-decoration-thickness:1.5px;color:var(--bq);opacity:.9}
.bm-tag{display:inline-block;font-size:12.5px;font-weight:700;border-radius:20px;padding:1px 9px;background:color-mix(in srgb,var(--bq) 18%,transparent);color:var(--bq)}
.bm-bar{position:sticky;bottom:0;z-index:20;background:var(--card);border:2px solid var(--brand);border-radius:12px;padding:12px 16px;
  display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:6px 0 18px}
.bm-bar[hidden]{display:none}
.bm-st{flex:1;min-width:220px;font-size:15px;line-height:1.45} .bm-r{color:var(--bl)}
.bm-bar input{background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:8px 10px;min-width:260px}
.bm-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:10px 0 12px}
.bm-kpi{border:1px solid var(--line);border-radius:12px;padding:10px 14px;background:var(--bg)}
.bm-kpi span{display:block;font-size:13px;color:var(--soft);font-weight:600}
.bm-kpi b{display:block;font-size:clamp(20px,1.2rem + .4vw,24px);font-weight:800;letter-spacing:-.01em;margin-top:2px;color:var(--ink)}
.bm-kpi small{display:block;font-size:12.5px;color:var(--soft);margin-top:2px}
.bm-kpi .bm-lev{font-size:14px;color:var(--ink);margin-top:4px;line-height:1.5}
.bm-kpi.bm-real{border-color:color-mix(in srgb,var(--brand) 55%,var(--line));box-shadow:inset 4px 0 0 var(--brand)}
.bm-fonteb{display:inline-flex;gap:6px;align-items:center;font-size:13px;font-weight:700;border-radius:9999px;padding:3px 12px;
  background:color-mix(in srgb,var(--bm-verde) 16%,transparent);color:var(--ink);border:1px solid color-mix(in srgb,var(--bm-verde) 45%,transparent)}
.bm-fonteb.bm-velha{background:color-mix(in srgb,var(--alerta) 16%,transparent);border-color:color-mix(in srgb,var(--alerta) 50%,transparent)}
.bm details{margin:0 0 12px;font-size:14px;color:var(--soft)} .bm summary{cursor:pointer;font-weight:700;color:var(--ink)}
.bm details ul{margin:6px 0 0;padding-left:18px;line-height:1.6}
.sr-only{position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.bm-sim .bm-form{display:flex;flex-wrap:wrap;gap:10px 14px;align-items:flex-end;margin:10px 0}
.bm-sim label.bm-f{display:grid;gap:3px;font-size:13.5px;color:var(--soft)}
.bm-sim select,.bm-sim input[type=number]{background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:8px 10px;font-size:15px;color:var(--ink);min-inline-size:0}
.bm-sim .bm-ck{display:inline-flex;gap:6px;align-items:center;font-size:14.5px;color:var(--ink);padding-bottom:8px}
.bm-simres{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;margin-top:10px}
.bm-simres h5{margin:0 0 4px;font-size:15px}
.bm-simres .bm-tab{margin:4px 0}
.bm-simres .bm-tab table{min-inline-size:0}
.bm-simres tr.bm-sel{background:color-mix(in srgb,var(--bm-verde) 30%,var(--card));box-shadow:inset 6px 0 0 var(--bm-verde);font-weight:700}
.bm-simres tr.bm-fora td{color:var(--soft)}
.bm-simres tr.bm-fora td:first-child{text-decoration:line-through}
.bm-simres .bm-resumo{grid-column:1/-1;padding:10px 12px;border-radius:10px;border:1px solid var(--line);font-size:15px;line-height:1.5}
@media (prefers-reduced-motion:no-preference){.bm-tab tbody tr{transition:background .15s}}
@media (max-width:640px){.bm-bar input{min-width:0;flex:1}}
`;

let montado = false;

function montar(raiz, ctx){
  if(montado) return;
  montado = true;
  const { api, toast } = ctx;
  if(!document.getElementById("bm-css")){ const st = document.createElement("style"); st.id = "bm-css"; st.textContent = CSS; document.head.appendChild(st); }
  // a Azure tem dois formatos de erro: {"erro": "..."} (rotas do Custo) e {"error": {"message"}} (limite de taxa etc.)
  const msgErro = e => {
    const c = (e && e.corpo) || {};
    if(e && e.status === 429) return "A API recusou por excesso de chamadas seguidas (limite de 5 por segundo). Espere alguns segundos e tente de novo.";
    return c.erro || (c.error && c.error.message) || (e && e.status ? "A API respondeu " + e.status + "." : "") || ctx.msgErro(e);
  };
  const espera = ms => new Promise(r => setTimeout(r, ms));
  // GET com nova tentativa quando a API devolve 429 (limite de taxa por IP)
  async function apiGet(caminho){
    for(let t = 0; ; t++){
      try{ return await api("GET", caminho); }
      catch(e){ if(e && e.status === 429 && t < 4){ await espera(1200 * (t + 1)); continue; } throw e; }
    }
  }
  const $ = s => raiz.querySelector(s);
  raiz.innerHTML =
    '<div class="bm"><p class="sub bm-topo">Escolha a banda de cada regra: <b>clique na linha</b>, a escolhida fica verde.</p>' +
    '<details><summary>Como a escolha funciona</summary><ul>' +
    '<li>Banda = quantos dias úteis a mais que a transportadora mais rápida a escolha aceita para pagar menos frete.</li>' +
    '<li>Três regras por estado: Capital, Interior e Distribuidor (cliente distribuidor, qualquer cidade).</li>' +
    '<li>Sem banda salva, a API usa a ★ Recomendada: maior economia sem aumentar o prazo.</li>' +
    '<li>Frete e economia comparados sem ICMS, como o motor da Azure. Transportadora bloqueada na Cobertura não entra.</li></ul></details>' +
    '<div class="aviso" id="bm-aviso" hidden></div>' +
    '<div class="exp"><div class="bm-esq"><input type="search" id="bm-q" placeholder="Filtrar estado…" aria-label="Filtrar estado por nome ou sigla">' +
    '<div class="ufs" id="bm-ufs" role="listbox" aria-label="Estados"></div></div>' +
    '<div class="painel-uf" id="bm-painel"><div class="vazio">carregando…</div></div></div>' +
    '<div class="bm-bar" id="bm-bar" hidden><div class="bm-st" id="bm-st" aria-live="polite"></div>' +
    '<input type="text" id="bm-motivo" placeholder="Motivo da alteração (obrigatório, mín. 10 letras)" aria-label="Motivo">' +
    '<button type="button" class="btn" id="bm-desfazer">Desfazer</button>' +
    '<button type="button" class="btn pri" id="bm-salvar" disabled>Salvar</button></div></div>';

  let est = null, base = new Map(), des = new Map(), uf = "SP", cache = {}, vez = 0, q = "";
  let bloqUF = new Set();          // transportadoras (nome curto) bloqueadas no ESTADO aberto
  const REG = ctx.regioes || null, NOME = ctx.nomeUF || {};
  const nomeUF = u => NOME[u] || u;
  const semAcento = t => String(t).toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
  const chave = (u, s) => u + "|" + s;
  const salvo = (u, s) => { const b = base.get(chave(u, s)); return b === undefined ? null : b; };
  const desejado = (u, s) => { const k = chave(u, s); return des.has(k) ? des.get(k) : salvo(u, s); };
  const pendentes = () => [...des.keys()].filter(k => (des.get(k) ?? null) !== (base.get(k) ?? null));
  const pendUF = u => SEG.some(([s]) => { const k = chave(u, s); return des.has(k) && (des.get(k) ?? null) !== (base.get(k) ?? null); });
  const nSalvas = u => SEG.filter(([s]) => desejado(u, s) != null).length;
  const padraoDe = (u, s) => ((est.padroes && est.padroes[u] && est.padroes[u][s]) ?? 0);
  const aviso = html => { const a = $("#bm-aviso"); a.hidden = !html; a.innerHTML = html || ""; };
  function itens(){
    const out = [];
    for(const u of est.ufs) for(const [s] of SEG){ const b = desejado(u, s); if(b !== null && b !== undefined) out.push({ uf: u, segmento: s, banda: b, motivo: "" }); }
    return out;
  }
  const grupos = () => REG ? REG.map(([n, l]) => [n, l.filter(u => est.ufs.includes(u))]) : [["Estados", est.ufs]];

  async function carregarEstado(){
    est = await apiGet("/v1/cobertura/banda");
    base = new Map(); for(const r of est.regras) base.set(chave(r.uf, r.segmento), r.banda);
    des = new Map();
    if(!est.ufs.includes(uf)) uf = est.ufs[0];
    await desenhar();
  }
  const limparCache = () => { cache = {}; };
  // uma UF por vez (só a que está aberta): 1 chamada por clique, longe do limite de 5/s da API
  async function impacto(u){ if(!cache[u]) cache[u] = await apiGet("/v1/cobertura/banda/impacto?uf=" + encodeURIComponent(u)); return cache[u]; }

  function desenharLista(){
    const f = semAcento(q.trim());
    let h = "";
    for(const [rn, l] of grupos()){
      const vis = l.filter(u => !f || semAcento(u).includes(f) || semAcento(nomeUF(u)).includes(f));
      if(!vis.length) continue;
      h += "<h4>" + esc(rn) + "</h4>";
      for(const u of vis){
        const n = nSalvas(u);
        h += '<button type="button" class="ufb" role="option" data-uf="' + u + '" aria-current="' + (u === uf) + '"><span class="sg">' + u + '</span><span class="nm">' + esc(nomeUF(u)) + "</span>" +
          (pendUF(u) ? '<span class="mm" title="alterações ainda não salvas"></span>' : "") +
          (n ? '<span class="ex" title="' + n + ' de 3 regras com banda salva (as outras usam a recomendada)">' + n + "/3 salvas</span>" : "") + "</button>";
      }
    }
    $("#bm-ufs").innerHTML = h || '<div class="bm-vazio-uf">Nenhum estado encontrado.</div>';
    $("#bm-ufs").querySelectorAll(".ufb").forEach(b => b.onclick = () => { uf = b.dataset.uf; desenhar(); });
  }

  async function desenhar(){
    desenharLista();
    const pa = est.prazo_ajuste || {};
    const aq = (est.modo_sem_banda === "ponderada"
      ? "Atenção: a reserva <b>ESCOLHA_SEM_BANDA=ponderada</b> está ligada na Azure — regra sem banda salva usa o método antigo, não a recomendada. " : "") +
      (pa.erro ? "O <b>ajuste de prazo</b> não está carregado na Azure (" + esc(pa.erro) + "): o M3 compara só o prazo prometido, sem o desvio medido no OTIF. " : "");
    let d;
    try{ d = await impacto(uf); }
    catch(e){ aviso(aq); $("#bm-painel").innerHTML = '<div class="aviso">Não consegui carregar ' + esc(nomeUF(uf)) + ". " + esc(msgErro(e)) + "</div>"; return; }
    aviso(aq);
    const bloq = (d.bloqueios || []).filter(b => !b.liberado);
    bloqUF = new Set(bloq.filter(b => b.onde === uf).map(b => b.curto));
    let h = '<select class="uf-mob" id="bm-mob" aria-label="Estado">' + est.ufs.map(u => '<option value="' + u + '"' + (u === uf ? " selected" : "") + ">" + esc(nomeUF(u)) + "</option>").join("") + "</select>";
    const bb = d.base || {}, per = bb.periodo || [];
    const MES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
    const mesBr = m => { const x = /^(\d{4})-(\d{2})/.exec(m || ""); return x ? MES[+x[2] - 1] + "/" + x[1].slice(2) : ""; };
    const selo = d.fonte === "recalculo"
      ? '<span class="bm-fonteb" title="' + esc(d.descricao || "") + '">Dados reais ' + esc(per.length ? mesBr(per[0]) + "–" + mesBr(per[1]) : "") + " · bloqueios considerados</span>"
      : '<span class="bm-fonteb bm-velha" title="' + esc(d.descricao || "") + '">Planilha de 23/10 · sem bloqueios</span>';
    h += '<div class="bm-cabuf"><h3>' + esc(nomeUF(uf)) + "</h3>" + selo + "</div>";
    const at = pa.atualizacao || {};
    const dBr = iso => { const x = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ""); return x ? x[3] + "/" + x[2] + "/" + x[1] : ""; };
    if(pa.gerado_em){
      const falhou = at.ligada && /^(RECUSADO|erro)/.test(at.resultado || "");
      h += '<p class="bm-mudo" id="bm-otif">Prazo do OTIF de ' + esc(dBr(pa.gerado_em)) + (at.ligada ? " (atualização automática diária)" : " (arquivo da imagem, sem atualização automática)") +
        (falhou ? ' · <span class="bm-fonteb bm-velha" title="' + esc(at.resultado) + '">última atualização não aplicada: ' + esc(at.resultado) + " — segue o dado anterior</span>" : "") + "</p>";
    }
    if(bloq.length) h += '<div class="bm-chips"><span>Bloqueios da Cobertura em ' + esc(nomeUF(uf)) + ':</span>' +
      bloq.map(b => '<span class="bm-chip" title="Bloqueada em ' + esc(b.onde) + '">✕ ' + esc(b.curto) + " · " + esc(b.onde === uf ? "estado inteiro" : b.onde) + "</span>").join("") + "</div>";
    h += SEG.map(([s, nome, desc]) => cardRegra(d, s, nome, desc, bloq)).join("");
    h += '<section class="bm-card bm-sim"><h4>Simular um pedido neste estado</h4>' +
      '<p class="bm-mudo">Motor da Azure sem e com os bloqueios atuais, na banda já salva.</p>' +
      '<div class="bm-form"><label class="bm-f">Cidade<select id="bm-sc" aria-label="Cidade do pedido"><option value="' + CAPITAIS[uf] + '">Capital</option></select></label>' +
      '<label class="bm-f">Peso (kg)<input type="number" id="bm-sp" min="0.1" max="2000" step="0.1" value="12" style="inline-size:90px"></label>' +
      '<label class="bm-f">Valor da NF (R$)<input type="number" id="bm-sv" min="0" step="100" value="2500" style="inline-size:120px"></label>' +
      '<label class="bm-ck"><input type="checkbox" id="bm-sd"> Cliente distribuidor</label>' +
      '<button type="button" class="btn pri" id="bm-sgo">Simular</button></div>' +
      '<div id="bm-sres" aria-live="polite"></div></section>';
    $("#bm-painel").innerHTML = h;
    prepararSim();
    const mob = $("#bm-mob"); if(mob) mob.onchange = () => { uf = mob.value; desenhar(); };
    for(const [s] of SEG){
      raiz.querySelectorAll('input[name="bm-' + s + '"]').forEach(r => r.onchange = () => escolher(s, r.value === "" ? null : Number(r.value)));
      // clicar em qualquer ponto da linha escolhe a banda dela
      const fx = raiz.querySelector('button[data-fixar="' + s + '"]'); if(fx) fx.onclick = () => escolher(s, Number(fx.dataset.v));
      raiz.querySelectorAll('tr[data-seg="' + s + '"]').forEach(tr => tr.onclick = ev => {
        if(ev.target.closest("input,label")) return;          // o próprio radio/label já tratam
        escolher(s, tr.dataset.b === "" ? null : Number(tr.dataset.b));
      });
    }
    barra();
  }
  // ---- simulador de pedido (sem x com bloqueios) ----
  const munis = {};
  const tit = t => String(t).toLowerCase().replace(/(^|[\s-])\S/g, c => c.toUpperCase());
  async function prepararSim(){
    const u = uf, sel = $("#bm-sc"), go = $("#bm-sgo");
    if(!sel || !go) return;
    go.onclick = () => simular();
    try{
      if(!munis[u]) munis[u] = (await apiGet("/v1/cobertura/municipios?uf=" + encodeURIComponent(u))).municipios;
    }catch(e){ return; }                      // sem a lista, só a capital fica disponível
    if(u !== uf || !$("#bm-sc")) return;
    const cap = CAPITAIS[u];
    sel.innerHTML = munis[u].map(m => '<option value="' + m.ibge + '"' + (m.ibge === cap ? " selected" : "") + ">" + esc(tit(m.cidade)) + (m.ibge === cap ? " (capital)" : "") + "</option>").join("");
  }
  const dias = v => v == null ? "—" : nf(v, 2) + " d";
  function tabSim(c){
    if(c.erro) return '<p class="bm-mudo">' + esc(c.erro) + "</p>";
    let h = '<div class="bm-tab"><table><thead><tr><th>Transportadora</th><th>Frete</th><th>Prazo esperado</th><th></th></tr></thead><tbody>';
    for(const l of c.candidatas){
      const nota = l.escolhida ? "✓ escolhida" : (!l.na_disputa ? "bloqueada" : (l.elegivel ? "na banda" : "fora da banda"));
      h += '<tr class="' + (l.escolhida ? "bm-sel" : "") + (l.na_disputa ? "" : " bm-fora") + '"><td>' + esc(l.nome) + "</td><td>R$ " + nf(l.preco, 2) + "</td><td>" + dias(l.prazo_esperado) + "</td><td>" + nota + "</td></tr>";
    }
    return h + "</tbody></table></div>" + (c.limite_prazo != null ? '<p class="bm-mudo">Banda +' + fmtB(c.banda) + " d: aceita até " + dias(c.limite_prazo) + ".</p>" : "");
  }
  async function simular(){
    const caixa = $("#bm-sres"), go = $("#bm-sgo");
    const corpo = { uf, ibge: $("#bm-sc").value, peso: Number($("#bm-sp").value), valor_nf: Number($("#bm-sv").value), distribuidor: $("#bm-sd").checked };
    if(!(corpo.peso > 0) || !(corpo.valor_nf >= 0)){ caixa.innerHTML = '<div class="aviso">Informe peso maior que 0 e valor da NF.</div>'; return; }
    go.disabled = true; caixa.innerHTML = '<p class="bm-mudo">simulando…</p>';
    let r;
    try{ r = await api("POST", "/v1/cobertura/banda/simular", corpo); }
    catch(e){ caixa.innerHTML = '<div class="aviso">' + esc(msgErro(e)) + "</div>"; go.disabled = false; return; }
    go.disabled = false;
    const sem = r.cenarios.sem, com = r.cenarios.com, df = r.diferenca;
    const seg = { CAPITAL: "Capital", INTERIOR: "Interior", DISTRIBUIDOR: "Distribuidor" }[r.regra] || r.regra;
    const sinal = v => (v >= 0 ? "+" : "−");
    let res;
    if(!df) res = "Não foi possível comparar: algum cenário não achou transportadora.";
    else if(!r.bloqueadas.length) res = "Nenhuma transportadora está bloqueada para <b>" + esc(tit(r.cidade)) + "</b>: os dois cenários são iguais (" + esc(com.escolhida.nome) + ").";
    else if(!df.mudou) res = "O bloqueio de <b>" + esc(r.bloqueadas.join(", ")) + "</b> não muda a escolha: continua <b>" + esc(com.escolhida.nome) + "</b>.";
    else res = "Com o bloqueio de <b>" + esc(r.bloqueadas.join(", ")) + "</b>, a escolha passa de <b>" + esc(sem.escolhida.nome) + "</b> para <b>" + esc(com.escolhida.nome) + "</b>: " +
      'frete <b class="' + (df.custo > 0 ? "bm-neg" : "bm-pos") + '">' + sinal(df.custo) + "R$ " + nf(Math.abs(df.custo), 2) + "</b> (" + sinal(df.custo) + fmtP(Math.abs(df.custo_pct)) + "), " +
      "prazo esperado " + (df.prazo == null ? "—" : "<b>" + sinal(df.prazo) + nf(Math.abs(df.prazo), 2) + " d</b>") + ".";
    caixa.innerHTML = '<p class="bm-mudo">' + esc(tit(r.cidade)) + " · regra <b>" + esc(seg) + "</b> · banda +" + fmtB(com.banda || 0) + " d · " + nf(r.pedido.peso, 1) + " kg · NF R$ " + nf(r.pedido.valor_nf, 0) + '</p><div class="bm-simres">' +
      "<div><h5>Sem bloqueios</h5>" + tabSim(sem) + "</div><div><h5>Com os bloqueios atuais</h5>" + tabSim(com) + '</div><div class="bm-resumo">' + res + "</div></div>";
  }
  $("#bm-q").oninput = e => { q = e.target.value; desenharLista(); };
  function escolher(s, b){
    des.set(chave(uf, s), b);
    desenhar().then(() => { const r = raiz.querySelector('input[name="bm-' + s + '"][value="' + (b == null ? "" : b) + '"]'); if(r) r.focus(); });
  }

  function cardRegra(d, s, nome, desc, bloq){
    const quadro = d.segmentos[s], salva = desejado(uf, s), pad = padraoDe(uf, s);
    let h = '<section class="bm-card"><h4>' + nome + ' <span class="bm-mudo">· ' + esc(desc) + "</span></h4>";
    const rotEf = salva != null ? "+" + fmtB(salva) + " d (banda salva)" : (pad > 0 ? "★ Recomendada +" + fmtB(pad) + " d (padrão)" : "★ Recomendada: só a mais rápida (padrão)");
    if(!quadro){
      return h + '<p class="bm-mudo">Sem pedidos desta regra em ' + esc(nomeUF(uf)) + ' na base: não há como medir o impacto de uma banda aqui.</p>' +
        '<div class="bm-esc"><span class="bm-atual">Escolhida: <b>' + esc(rotEf) + "</b></span></div></section>";
    }
    const h0 = quadro.hoje, nMes = (d.base && d.base.meses) || 9;
    const lev = Object.entries(h0.quem_levou || {}).slice(0, 3).map(([t, n]) => esc(t) + " " + fmtP(n / h0.pedidos)).join("<br>");
    h += '<div class="bm-kpis">' +
      '<div class="bm-kpi bm-real"><span>Frete real hoje</span><b>' + fmtR(h0.frete_fatura != null ? h0.frete_fatura : h0.frete) + "</b><small>" +
        (h0.frete_fatura != null ? "faturado, com ICMS · " + fmtR(h0.frete) + " sem ICMS" : "sem ICMS") + "</small></div>" +
      '<div class="bm-kpi bm-real"><span>Prazo realizado hoje</span><b>' + fmtB(h0.prazo_real) + " d úteis</b><small>média das entregas</small></div>" +
      '<div class="bm-kpi"><span>Pedidos</span><b>' + h0.pedidos.toLocaleString("pt-BR") + "</b><small>" + nMes + " meses" + (quadro.poucos ? " · poucos, use com cautela" : "") + "</small></div>" +
      '<div class="bm-kpi"><span>Quem levou</span><div class="bm-lev">' + (lev || "—") + "</div></div></div>";
    if(d.fonte !== "recalculo" && bloq.length){
      const nomes = [...new Set(bloq.map(b => b.curto))].join(", ");
      h += '<div class="bm-bloqbox" role="status"><b>' + esc(nomes) + " bloqueada.</b> A API já respeita. Esta tabela ainda é a planilha de 23/10: o nome riscado no mix mostra quanto dependia dela.</div>";
    }
    h += '<div class="bm-esc"><span class="bm-atual">Escolhida: <b>' + esc(rotEf) + "</b></span></div>";
    // recalculado com os bloqueios: a melhor banda de AGORA pode ser outra que a recomendada da planilha (padrao da API)
    const melhorAgora = quadro.sugestao;
    if(d.fonte === "recalculo" && !igual(melhorAgora, pad > 0 ? pad : null)){
      h += '<div class="bm-bloqbox" role="status">Melhor banda sem piorar o prazo agora: ' + (melhorAgora == null ? "<b>nenhuma</b>" : "<b>+" + fmtB(melhorAgora) + " d</b>") +
           " (a ★ Recomendada da API segue " + (pad > 0 ? "+" + fmtB(pad) + " d" : "só a mais rápida") + ")." +
           (melhorAgora != null ? ' <button type="button" class="btn" data-fixar="' + s + '" data-v="' + melhorAgora + '">Fixar +' + fmtB(melhorAgora) + " d</button>" : "") + "</div>";
    }
    h += '<div class="bm-tab"><table><caption class="sr-only">Bandas de ' + nome + " em " + esc(nomeUF(uf)) + "</caption>" +
         '<thead><tr><th scope="col">Banda</th><th scope="col">Economia</th><th scope="col">R$ (' + nMes + ' meses)</th><th scope="col">Prazo médio</th><th scope="col">Δ prazo vs hoje</th><th scope="col">Prazo prometido</th><th scope="col">Mix de transportadoras</th></tr></thead><tbody>';
    // 1ª linha: ★ Recomendada (padrão) = nenhuma banda salva; mostra os números da banda recomendada
    const lr = pad > 0 ? quadro.bandas.find(x => igual(x.banda, pad)) : null;
    const col = b => '<td class="' + (b.economia_rs >= 0 ? "bm-pos" : "bm-neg") + '">' + fmtP(b.economia_pct) + "</td>" +
           '<td class="' + (b.economia_rs >= 0 ? "bm-pos" : "bm-neg") + '">' + fmtR(b.economia_rs) + "</td>" +
           "<td>" + fmtB(b.prazo) + " d</td>" +
           '<td class="' + (b.delta_prazo > 1e-9 ? "bm-neg" : "bm-pos") + '">' + fmtD(b.delta_prazo) + "</td>" +
           "<td>" + fmtB(b.prazo_prometido) + " d</td>";
    const emBloq = b => Object.entries(b.mix).filter(([t]) => bloqUF.has(t)).reduce((a, [, v]) => a + v, 0);
    const mixDe = b => Object.entries(b.mix).filter(([, v]) => v >= 0.005).sort((a, c) => c[1] - a[1])
      .map(([t, v]) => bloqUF.has(t) ? '<s class="bm-mixb" title="Bloqueada: este resultado conta com ela">' + esc(t) + " " + fmtP(v) + "</s>" : esc(t) + " " + fmtP(v)).join(" · ") +
      (d.fonte !== "recalculo" && emBloq(b) >= 0.005 ? ' <span class="bm-tag" title="Parte dos pedidos desta banda iria para transportadora hoje bloqueada">⚠ ' + fmtP(emBloq(b)) + " bloqueada</span>" : "");
    h += '<tr data-seg="' + s + '" data-b="" class="bm-rec' + (salva == null ? " bm-sel" : "") + '"><td><label><input type="radio" name="bm-' + s + '" value=""' + (salva == null ? " checked" : "") +
         '><span>★ Recomendada<span class="bm-sub">' + (pad > 0 ? "+" + fmtB(pad) + " d · padrão da API" : "só a mais rápida · padrão da API") + "</span></span></label></td>" +
         (lr ? col(lr) + '<td class="bm-mix">' + mixDe(lr) + "</td>" : '<td colspan="6" style="text-align:left;color:var(--soft)">' + (pad > 0 ? "Sem números para esta banda." : "Nenhuma banda economiza sem piorar o prazo aqui: usa só a transportadora mais rápida.") + "</td>") + "</tr>";
    for(const b of quadro.bandas){
      const sel = igual(salva, b.banda);
      h += '<tr data-seg="' + s + '" data-b="' + b.banda + '" class="' + (sel ? "bm-sel " : "") + (igual(pad, b.banda) ? "bm-estr" : "") + '">' +
           '<td><label><input type="radio" name="bm-' + s + '" value="' + b.banda + '"' + (sel ? " checked" : "") + "><span>+" + fmtB(b.banda) + " d</span></label></td>" +
           col(b) + '<td class="bm-mix">' + mixDe(b) + "</td></tr>";
    }
    return h + '</tbody></table></div><p class="bm-mudo">★ maior economia sem aumentar o prazo · economia contra o frete real de hoje, sem ICMS.</p></section>';
  }

  async function barra(){
    const ks = pendentes(), bar = $("#bm-bar"), id = ++vez;
    bar.hidden = !ks.length;
    if(!ks.length) return;
    let r;
    try{ r = await api("POST", "/v1/cobertura/banda/validar", { regras: itens(), base_versao: est.versao }); }
    catch(e){ r = { ok: false, violacoes: [msgErro(e)] }; }
    if(id !== vez) return;
    $("#bm-st").innerHTML = "<b>" + ks.length + (ks.length === 1 ? " alteração pendente" : " alterações pendentes") + "</b> · " +
      (r.ok ? "pronto para salvar" : '<span class="bm-r">não pode ser salva</span>: ' + esc((r.violacoes || []).join(" ")));
    $("#bm-salvar").disabled = !r.ok;
  }

  async function salvar(){
    const motivo = $("#bm-motivo").value.trim();
    if(motivo.length < 10){ toast("Escreva o motivo (pelo menos 10 letras).", { erro: true }); $("#bm-motivo").focus(); return; }
    try{
      const r = await api("PUT", "/v1/cobertura/banda", { regras: itens(), base_versao: est.versao, motivo });
      toast("Bandas salvas (" + (r.mudancas || []).length + " mudança(s)).");
      limparCache(); $("#bm-motivo").value = ""; await carregarEstado();
    }catch(e){
      if(e.status === 409){ toast("As bandas mudaram enquanto você editava. Recarreguei.", { erro: true }); limparCache(); await carregarEstado(); }
      else toast(msgErro(e), { erro: true });
    }
  }
  $("#bm-desfazer").onclick = () => { des = new Map(); $("#bm-motivo").value = ""; desenhar(); };
  $("#bm-salvar").onclick = salvar;

  carregarEstado().catch(e => {
    montado = false;
    raiz.innerHTML = '<div class="aviso">Não consegui carregar as bandas agora. ' + esc(msgErro(e)) + ' <button type="button" class="btn" id="bm-tentar">Tentar de novo</button></div>';
    const t = raiz.querySelector("#bm-tentar"); if(t) t.onclick = () => montar(raiz, ctx);
  });
}

window.BandasM3 = { montar };
})();
