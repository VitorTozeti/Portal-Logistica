/* Banda do M3 — escolha guiada, montada em Custo de Frete > Regras da escolha.
   Uso: BandasM3.montar(elementoRaiz, { api, toast, msgErro })
     api(metodo, caminho, corpo) -> Promise (já com login Firebase), toast(msg, {erro}), msgErro(e) -> texto.
   Rotas da Azure: GET /v1/cobertura/banda, GET .../banda/impacto?uf=, POST .../banda/validar, PUT .../banda.

   Como se escolhe (23/10/2026):
     1. CRITÉRIO — a pessoa escolhe a política ("não piorar o prazo", "aceitar até +0,2 d", "máxima economia") e a
        tela calcula a banda de cada regra (UF × Capital/Interior/Distribuidor) nos 27 estados, com o total estimado.
     2. VISÃO BRASIL — uma grade UF × regra mostra o que está salvo, o que vai mudar e onde a sugestão difere.
     3. DETALHE — por estado, cada regra tem um gráfico economia × prazo (um ponto por resultado distinto),
        a escolha em botões de opção e o resumo da banda escolhida (economia, prazo, mix de transportadoras).
   Nada vale até salvar com motivo. Regras do motor em banda.py / escolha.py (Azure). */
(function(){
"use strict";
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const SEG = [["CAPITAL", "Capital", "pedido para a capital"], ["INTERIOR", "Interior", "demais cidades"],
             ["DISTRIBUIDOR", "Distribuidor", "cliente distribuidor, qualquer cidade"]];
const POLITICAS = [
  { id: "prazo0", nome: "Não piorar o prazo", desc: "A maior economia sem aumentar o prazo médio de hoje.", limite: 0, rec: true },
  { id: "prazo02", nome: "Aceitar até +0,2 dia", desc: "Mais economia, tolerando até 0,2 dia útil a mais no prazo médio.", limite: 0.2 },
  { id: "max", nome: "Máxima economia", desc: "A banda que mais economiza, mesmo que o prazo piore.", limite: Infinity },
  { id: "manual", nome: "Escolher à mão", desc: "Sem sugestão automática: você escolhe a banda de cada regra.", limite: null },
];
// cores categóricas (paleta Okabe-Ito, segura para daltônicos) — cor só para identificar a transportadora
const COR = { "Correios": "#E69F00", "Acerta": "#56B4E9", "VIP": "#009E73", "Quality": "#CC79A7", "Sul Cargo": "#0072B2", "TGT": "#D55E00" };
const nf = (v, d) => v.toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtR = v => (v < 0 ? "−" : "") + "R$ " + nf(Math.abs(v), 0);
const fmtP = v => nf(v * 100, 1) + "%";
const fmtD = v => (v > 0.005 ? "+" : v < -0.005 ? "−" : "") + nf(Math.abs(v), 2) + " d";
const fmtB = b => "+" + nf(b, 1) + " d";
const igual = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-9;
const UFS_NOME = {AC:"Acre",AL:"Alagoas",AM:"Amazonas",AP:"Amapá",BA:"Bahia",CE:"Ceará",DF:"Distrito Federal",ES:"Espírito Santo",
  GO:"Goiás",MA:"Maranhão",MG:"Minas Gerais",MS:"Mato Grosso do Sul",MT:"Mato Grosso",PA:"Pará",PB:"Paraíba",PE:"Pernambuco",
  PI:"Piauí",PR:"Paraná",RJ:"Rio de Janeiro",RN:"Rio Grande do Norte",RO:"Rondônia",RR:"Roraima",RS:"Rio Grande do Sul",
  SC:"Santa Catarina",SE:"Sergipe",SP:"São Paulo",TO:"Tocantins"};

const CSS = `
.bm{--bm-ac:var(--brand);--bm-sup:color-mix(in srgb,var(--ink) 4%,var(--card));--bm-pos:var(--at,#059669);--bm-neg:var(--bq,#dc2626)}
.bm h3{margin:0 0 4px;font-size:16px;letter-spacing:-.01em}
.bm .bm-sub{margin:0 0 16px;color:var(--soft);font-size:13.5px;line-height:1.55;max-width:80ch}
.bm-passo{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin:0 0 14px}
.bm-passo > h4{margin:0 0 2px;font-size:14.5px;display:flex;gap:8px;align-items:center}
.bm-num{display:inline-grid;place-items:center;inline-size:22px;block-size:22px;border-radius:50%;font-size:12px;font-weight:800;
  background:var(--bm-ac);color:var(--p1)}
.bm-ajuda{margin:0 0 12px;color:var(--soft);font-size:12.5px;line-height:1.5}
.bm fieldset{border:0;margin:0;padding:0;min-inline-size:0}
.bm legend{padding:0}
.bm-pols{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
.bm-pol{position:relative;display:block;border:1px solid var(--line);border-radius:12px;padding:12px 14px;cursor:pointer;background:var(--bm-sup)}
.bm-pol input{position:absolute;opacity:0;inset:0;cursor:pointer}
.bm-pol b{display:block;font-size:13.5px} .bm-pol span{display:block;font-size:12px;color:var(--soft);margin-top:3px;line-height:1.4}
.bm-pol:has(input:checked){border-color:var(--bm-ac);box-shadow:inset 0 0 0 1px var(--bm-ac)}
.bm-pol:has(input:focus-visible){outline:2px solid var(--bm-ac);outline-offset:2px}
.bm-pol .bm-rec{font-size:10.5px;font-weight:700;color:var(--bm-ac);margin-left:6px}
.bm-opts{display:flex;flex-wrap:wrap;gap:8px 18px;margin:12px 0 0;font-size:13px}
.bm-opts label{display:flex;gap:7px;align-items:center;cursor:pointer}
.bm-tot{margin:14px 0 0}
.bm-cmp{overflow-x:auto;border:1px solid var(--line);border-radius:12px}
.bm-cmp table{inline-size:100%;border-collapse:collapse;font-size:13px;min-inline-size:520px}
.bm-cmp caption{text-align:left;padding:8px 12px 0;margin:0}
.bm-cmp th,.bm-cmp td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--line)}
.bm-cmp thead th{color:var(--soft);font-weight:600;font-size:11.5px}
.bm-cmp tbody tr:last-child th,.bm-cmp tbody tr:last-child td{border-bottom:0}
.bm-cmp tbody th{font-weight:600;font-size:12.5px}
.bm-cmp tr.dest{background:color-mix(in srgb,var(--bm-ac) 8%,transparent)}
.bm-cmp b{font-size:15px} .bm-cmp small{color:var(--soft)} .bm-cmp .pos{color:var(--bm-pos)} .bm-cmp .neg{color:var(--bm-neg)}
.bm-acoes{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:12px 0 0}
.bm-grade{overflow-x:auto;border:1px solid var(--line);border-radius:12px}
.bm-grade table{inline-size:100%;border-collapse:collapse;font-size:12.5px;min-inline-size:520px}
.bm-grade th,.bm-grade td{padding:5px 8px;border-bottom:1px solid var(--line);text-align:left}
.bm-grade th{color:var(--soft);font-weight:600;font-size:11.5px}
.bm-grade tr:last-child td{border-bottom:0}
.bm-grade tr.bm-atual{background:color-mix(in srgb,var(--bm-ac) 9%,transparent)}
.bm-cel{inline-size:100%;text-align:left;border:1px solid transparent;background:transparent;border-radius:8px;padding:4px 8px;cursor:pointer;font-size:12.5px}
.bm-cel:hover{border-color:var(--line)}
.bm-cel:focus-visible{outline:2px solid var(--bm-ac);outline-offset:1px}
.bm-cel.pend{border:1px dashed var(--bm-ac);color:var(--bm-ac);font-weight:700}
.bm-cel .bm-dif{color:var(--alerta);font-size:11px;margin-left:4px}
.bm-cel.vazio{color:var(--soft)}
.bm-leg{display:flex;flex-wrap:wrap;gap:14px;font-size:11.5px;color:var(--soft);margin:8px 0 0}
.bm-ufbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 12px}
.bm-ufbar select{background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:8px 10px}
.bm-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:12px}
.bm-card{border:1px solid var(--line);border-radius:12px;padding:14px;background:var(--bm-sup);min-inline-size:0}
.bm-card h5{margin:0;font-size:14px} .bm-card h5 span{color:var(--soft);font-weight:400;font-size:12px}
.bm-hoje{margin:4px 0 8px;color:var(--soft);font-size:12px;line-height:1.45}
.bm-graf svg{inline-size:100%;block-size:auto;display:block}
.bm-graf text{font:10px 'Montserrat',system-ui,sans-serif;fill:var(--soft)}
.bm-graf .eixo{stroke:var(--line);stroke-width:1}
.bm-graf .zero{stroke:color-mix(in srgb,var(--ink) 35%,transparent);stroke-width:1;stroke-dasharray:3 3}
.bm-graf .pt{fill:var(--card);stroke:color-mix(in srgb,var(--ink) 55%,transparent);stroke-width:1.5;cursor:pointer}
.bm-graf .pt.sug{stroke:var(--alerta);stroke-width:2.5}
.bm-graf .pt.sel{fill:var(--bm-ac);stroke:var(--bm-ac)}
.bm-graf .rot{fill:var(--ink);font-weight:700}
.bm-pills{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 0}
.bm-pill{position:relative}
.bm-pill input{position:absolute;opacity:0;inset:0;cursor:pointer;margin:0}
.bm-pill span{display:inline-block;border:1px solid var(--line);border-radius:9999px;padding:4px 10px;font-size:12px;font-weight:600;background:var(--card)}
.bm-pill input:checked + span{background:var(--bm-ac);border-color:var(--bm-ac);color:var(--p1)}
.bm-pill input:focus-visible + span{outline:2px solid var(--bm-ac);outline-offset:2px}
.bm-pill.sug span::after{content:" ★";color:var(--alerta)}
.bm-pill input:checked + span::after{color:inherit}
.bm-res{margin:10px 0 0;font-size:12.5px;line-height:1.55}
.bm-res b.pos{color:var(--bm-pos)} .bm-res b.neg{color:var(--bm-neg)}
.bm-mix{display:flex;block-size:10px;border-radius:6px;overflow:hidden;margin:8px 0 4px;background:var(--line)}
.bm-mix i{display:block;block-size:100%}
.bm-mixleg{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:11px;color:var(--soft)}
.bm-mixleg i{display:inline-block;inline-size:9px;block-size:9px;border-radius:2px;margin-right:4px;vertical-align:-1px}
.bm-alerta{margin:8px 0 0;font-size:12px;color:var(--alerta)}
.bm details{margin:10px 0 0;font-size:12px}
.bm summary{cursor:pointer;color:var(--soft)}
.bm-tab{overflow-x:auto;margin:8px 0 0}
.bm-tab table{border-collapse:collapse;min-inline-size:460px;inline-size:100%;font-size:11.5px}
.bm-tab th,.bm-tab td{padding:4px 6px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
.bm-tab th:first-child,.bm-tab td:first-child{text-align:left}
.bm-tab tr.sel{background:color-mix(in srgb,var(--bm-ac) 14%,transparent)}
.bm-bar{position:sticky;inset-block-end:0;z-index:20;background:var(--card);border:2px solid var(--bm-ac);border-radius:12px;padding:12px 16px;
  display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:6px 0 18px}
.bm-bar[hidden]{display:none}
.bm-st{flex:1;min-inline-size:220px;font-size:13.5px;line-height:1.45} .bm-r{color:var(--alerta)}
.bm-bar input{background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:8px 10px;min-inline-size:280px;flex:1}
.bm-carreg{color:var(--soft);font-size:12.5px}
@media (prefers-reduced-motion:no-preference){.bm-pill span,.bm-pol,.bm-cel{transition:background .15s,border-color .15s}}
@media (max-width:640px){.bm-bar input{min-inline-size:0}}
`;

let montado = false;

function montar(raiz, ctx){
  if(montado) return;
  montado = true;
  const { api, toast, msgErro } = ctx;
  if(!document.getElementById("bm-css")){ const st = document.createElement("style"); st.id = "bm-css"; st.textContent = CSS; document.head.appendChild(st); }
  const $ = s => raiz.querySelector(s);

  let est = null, base = new Map(), des = new Map(), uf = "SP", vez = 0;
  let dados = {};                       // UF -> resposta do /impacto
  let pol = "prazo0", optPoucos = true, optEstimado = true;
  const chave = (u, s) => u + "|" + s;
  const salvo = (u, s) => { const b = base.get(chave(u, s)); return b === undefined ? null : b; };
  const desejado = (u, s) => { const k = chave(u, s); return des.has(k) ? des.get(k) : salvo(u, s); };
  const pendentes = () => [...des.keys()].filter(k => (des.get(k) ?? null) !== (base.get(k) ?? null));
  const quadro = (u, s) => (dados[u] && dados[u].segmentos && dados[u].segmentos[s]) || null;
  const linha = (q, b) => q && b != null ? q.bandas.find(x => igual(x.banda, b)) : null;

  // ---------- critério -> banda sugerida de uma regra ----------
  function sugerir(q, p){
    const P = POLITICAS.find(x => x.id === p);
    if(!q || !P || P.limite === null) return { banda: null, motivo: "sem dados" };
    if(optPoucos && q.poucos) return { banda: null, motivo: "poucos pedidos" };
    let c = q.bandas.filter(b => b.economia_rs > 0.5 && b.delta_prazo <= P.limite + 1e-9);
    if(!c.length) return { banda: null, motivo: P.limite === Infinity ? "nenhuma banda economiza" : "nenhuma banda economiza sem passar do limite de prazo" };
    if(optEstimado){
      const medidas = c.filter(b => (b.pct_estimado || 0) <= 0.5);
      if(!medidas.length) return { banda: null, motivo: "as bandas que economizam levam a maioria dos pedidos para transportadora sem entrega medida aqui (prazo só estimado)" };
      c = medidas;
    }
    const m = Math.max(...c.map(b => b.economia_rs));
    return { banda: Math.min(...c.filter(b => Math.abs(b.economia_rs - m) < 0.5).map(b => b.banda)), motivo: "" };
  }
  // totais (estimados) de um conjunto de escolhas: f(u, s) -> banda | null
  function totais(f){
    let mes = 0, n = 0, dp = 0, com = 0, sem = 0, frete = 0;
    for(const u of est.ufs) for(const [s] of SEG){
      const q = quadro(u, s); if(!q) continue;
      const b = f(u, s), l = linha(q, b), k = q.hoje.pedidos;
      n += k; frete += q.hoje.frete;
      if(l){ com++; mes += l.economia_mes; dp += l.delta_prazo * k; } else sem++;
    }
    return { mes, pct: frete ? (mes * 9) / frete : 0, dprazo: n ? dp / n : 0, com, sem };
  }

  raiz.innerHTML =
    '<div class="bm"><h3>Banda do M3</h3>' +
    '<p class="bm-sub">A banda diz até quantos dias úteis a mais que a transportadora mais rápida a escolha aceita em troca de frete mais barato. ' +
    'Cada estado tem três regras (<b>Capital</b>, <b>Interior</b> e <b>Distribuidor</b>). Onde não há banda salva, vale a <b>Ponderada</b> (mais abaixo).</p>' +
    '<div class="aviso" id="bm-aviso" role="status" hidden></div>' +
    '<section class="bm-passo" aria-labelledby="bm-p1"><h4 id="bm-p1"><span class="bm-num">1</span>Escolha o critério</h4>' +
    '<p class="bm-ajuda">Em vez de escolher a banda regra por regra, diga o que importa e a tela calcula a banda de cada regra nos 27 estados.</p>' +
    '<fieldset><legend class="bm-ajuda" style="margin:0 0 8px">Critério da sugestão</legend><div class="bm-pols" id="bm-pols"></div></fieldset>' +
    '<div class="bm-opts"><label><input type="checkbox" id="bm-op-poucos" checked> Manter a Ponderada onde há poucos pedidos (menos de 30)</label>' +
    '<label><input type="checkbox" id="bm-op-est" checked> Não sugerir banda em que mais da metade do prazo é estimado (sem entrega medida)</label></div>' +
    '<div class="bm-tot" id="bm-tot" aria-live="polite"></div>' +
    '<div class="bm-acoes"><button type="button" class="btn pri" id="bm-aplicar">Aplicar o critério aos 27 estados</button>' +
    '<span class="bm-carreg" id="bm-carreg"></span></div></section>' +
    '<section class="bm-passo" aria-labelledby="bm-p2"><h4 id="bm-p2"><span class="bm-num">2</span>Visão Brasil</h4>' +
    '<p class="bm-ajuda">Banda de cada regra (o que vale ao salvar). Clique numa célula para abrir o estado.</p>' +
    '<div class="bm-grade" id="bm-grade"></div>' +
    '<div class="bm-leg"><span><b style="color:var(--brand)">+0,3 d</b> tracejado = alteração não salva</span><span>— = sem banda (Ponderada)</span>' +
    '<span><span style="color:var(--alerta)">●</span> = difere da sugestão do critério</span></div></section>' +
    '<section class="bm-passo" aria-labelledby="bm-p3" id="bm-sec-uf"><h4 id="bm-p3"><span class="bm-num">3</span>Ajuste por estado</h4>' +
    '<div class="bm-ufbar"><label for="bm-uf"><b>Estado</b></label><select id="bm-uf"></select><span class="bm-carreg" id="bm-info"></span></div>' +
    '<div class="bm-cards" id="bm-cards"><div class="vazio">carregando…</div></div></section>' +
    '<div class="bm-bar" id="bm-bar" hidden><div class="bm-st" id="bm-st" aria-live="polite"></div>' +
    '<input type="text" id="bm-motivo" placeholder="Motivo da alteração (obrigatório, mín. 10 letras)" aria-label="Motivo da alteração">' +
    '<button type="button" class="btn" id="bm-desfazer">Desfazer</button>' +
    '<button type="button" class="btn pri" id="bm-salvar" disabled>Salvar</button></div></div>';

  $("#bm-pols").innerHTML = POLITICAS.map(p =>
    '<label class="bm-pol"><input type="radio" name="bm-pol" value="' + p.id + '"' + (p.id === pol ? " checked" : "") + '>' +
    "<b>" + esc(p.nome) + (p.rec ? '<span class="bm-rec">recomendado</span>' : "") + "</b><span>" + esc(p.desc) + "</span></label>").join("");
  raiz.querySelectorAll('input[name="bm-pol"]').forEach(r => r.onchange = () => { pol = r.value; atualizarTudo(); });
  $("#bm-op-poucos").onchange = e => { optPoucos = e.target.checked; atualizarTudo(); };
  $("#bm-op-est").onchange = e => { optEstimado = e.target.checked; atualizarTudo(); };

  // ---------- carga ----------
  async function carregarTudo(){
    est = await api("GET", "/v1/cobertura/banda");
    base = new Map(); for(const r of est.regras) base.set(chave(r.uf, r.segmento), r.banda);
    des = new Map();
    const sel = $("#bm-uf");
    if(!sel.options.length){
      sel.innerHTML = est.ufs.map(u => '<option value="' + u + '">' + u + " · " + esc(UFS_NOME[u] || u) + "</option>").join("");
      sel.onchange = () => { uf = sel.value; desenharUF(); desenharGrade(); };
    }
    sel.value = uf;
    const fila = est.ufs.filter(u => !dados[u]); let feitos = est.ufs.length - fila.length;
    const passo = async () => { while(fila.length){ const u = fila.shift(); dados[u] = await api("GET", "/v1/cobertura/banda/impacto?uf=" + encodeURIComponent(u));
      feitos++; $("#bm-carreg").textContent = feitos < est.ufs.length ? "carregando estados… " + feitos + "/" + est.ufs.length : ""; } };
    await Promise.all(Array.from({ length: 6 }, passo));
    atualizarTudo();
  }

  function atualizarTudo(){ desenharTotais(); desenharGrade(); desenharUF(); barra(); }

  // ---------- passo 1: totais do critério ----------
  function desenharTotais(){
    const P = POLITICAS.find(x => x.id === pol);
    $("#bm-aplicar").disabled = P.limite === null;
    const linhas = [];
    if(P.limite !== null) linhas.push(["Se aplicar “" + P.nome + "”", totais((u, s) => sugerir(quadro(u, s), pol).banda), true]);
    linhas.push(["Escolhido agora (com o que não foi salvo)", totais(desejado), false]);
    $("#bm-tot").innerHTML = (P.limite === null ? '<p class="bm-ajuda" style="margin:0 0 8px">Modo manual: escolha a banda de cada regra no passo 3.</p>' : "") +
      '<div class="bm-cmp"><table><caption class="bm-ajuda">Estimativa sobre jan–set/2026 (todos os estados)</caption><thead><tr><th scope="col"></th>' +
      '<th scope="col">Economia por mês</th><th scope="col">Prazo médio vs hoje</th><th scope="col">Regras com banda</th></tr></thead><tbody>' +
      linhas.map(([n, t, dest]) => '<tr class="' + (dest ? "dest" : "") + '"><th scope="row">' + esc(n) + "</th><td><b>" + fmtR(t.mes) + "</b> <small>(" + fmtP(t.pct) +
        ")</small></td><td><b class=\"" + (t.dprazo > 0.005 ? "neg" : "pos") + "\">" + fmtD(t.dprazo) + "</b></td><td><b>" + t.com + "</b> <small>de " + (t.com + t.sem) + " (o resto na Ponderada)</small></td></tr>").join("") +
      "</tbody></table></div>";
  }
  $("#bm-aplicar").onclick = () => {
    let n = 0;
    for(const u of est.ufs) for(const [s] of SEG){
      if(!quadro(u, s)) continue;
      const b = sugerir(quadro(u, s), pol).banda, k = chave(u, s);
      if((b ?? null) !== (salvo(u, s) ?? null) || des.has(k)) { des.set(k, b); n++; }
    }
    const P = POLITICAS.find(x => x.id === pol);
    if(!$("#bm-motivo").value.trim()) $("#bm-motivo").value = "Critério “" + P.nome + "” aplicado aos 27 estados" + (optPoucos ? ", Ponderada onde há poucos pedidos" : "");
    atualizarTudo();
    toast(pendentes().length ? "Critério aplicado: " + pendentes().length + " regra(s) mudam. Confira e salve." : "Nada muda: o que está salvo já segue esse critério.");
  };

  // ---------- passo 2: grade Brasil ----------
  function desenharGrade(){
    if(!est) return;
    let h = "<table><thead><tr><th scope=\"col\">Estado</th>" + SEG.map(([, n]) => '<th scope="col">' + n + "</th>").join("") + "</tr></thead><tbody>";
    for(const u of est.ufs){
      h += '<tr class="' + (u === uf ? "bm-atual" : "") + '"><th scope="row">' + u + "</th>";
      for(const [s, nome] of SEG){
        const q = quadro(u, s);
        if(!q){ h += '<td><span class="bm-cel vazio" title="Sem pedidos desta regra na base">sem dados</span></td>'; continue; }
        const d = desejado(u, s), pend = (d ?? null) !== (salvo(u, s) ?? null);
        const sg = POLITICAS.find(x => x.id === pol).limite === null ? undefined : sugerir(q, pol).banda;
        const dif = sg !== undefined && (sg ?? null) !== (d ?? null);
        const tit = u + " " + nome + ": " + (d == null ? "sem banda (Ponderada)" : fmtB(d)) + (pend ? " — não salvo" : "") +
          (dif ? " — o critério sugere " + (sg == null ? "sem banda" : fmtB(sg)) : "");
        h += '<td><button type="button" class="bm-cel' + (pend ? " pend" : "") + (d == null ? " vazio" : "") + '" data-uf="' + u + '" title="' + esc(tit) + '" aria-label="' + esc(tit) + '">' +
             (d == null ? "—" : fmtB(d)) + (dif ? '<span class="bm-dif" aria-hidden="true">●</span>' : "") + "</button></td>";
      }
      h += "</tr>";
    }
    $("#bm-grade").innerHTML = h + "</tbody></table>";
    raiz.querySelectorAll(".bm-cel[data-uf]").forEach(b => b.onclick = () => {
      uf = b.dataset.uf; $("#bm-uf").value = uf; desenharGrade(); desenharUF();
      $("#bm-sec-uf").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    });
  }

  // ---------- passo 3: estado ----------
  function desenharUF(){
    const q = dados[uf];
    if(!q){ $("#bm-cards").innerHTML = '<div class="vazio">carregando…</div>'; return; }
    $("#bm-info").textContent = q.fonte === "recalculo" ? "Números recalculados com a cobertura atual." : "Números da planilha de 23/10 (jan–set/2026, sem bloqueios).";
    const desat = est.ufs.filter(u => dados[u] && dados[u].desatualizado);
    $("#bm-aviso").hidden = !desat.length;
    $("#bm-aviso").textContent = desat.length ? "Há bloqueio de transportadora em " + desat.join(", ") + ": a planilha não considera bloqueio, então os números desses estados podem estar desatualizados." : "";
    $("#bm-cards").innerHTML = SEG.map(([s, nome, desc]) => card(s, nome, desc)).join("");
    raiz.querySelectorAll('.bm-card input[type="radio"]').forEach(r => r.onchange = () => escolher(r.name.slice(3), r.value === "" ? null : Number(r.value)));
    raiz.querySelectorAll(".bm-graf [data-b]").forEach(p => p.onclick = () => escolher(p.closest(".bm-card").dataset.s, Number(p.dataset.b)));
  }
  function escolher(s, b){ des.set(chave(uf, s), b); atualizarTudo();
    const r = raiz.querySelector('.bm-card[data-s="' + s + '"] input[value="' + (b == null ? "" : b) + '"]'); if(r) r.focus(); }

  function card(s, nome, desc){
    const q = quadro(uf, s);
    let h = '<article class="bm-card" data-s="' + s + '"><h5>' + nome + " <span>· " + esc(desc) + "</span></h5>";
    if(!q) return h + '<p class="bm-hoje">Sem pedidos desta regra em ' + uf + ' na base: não há como medir o impacto. Fica na Ponderada.</p></article>';
    const d = desejado(uf, s), P = POLITICAS.find(x => x.id === pol), sg = P.limite === null ? null : sugerir(q, pol);
    const lev = Object.entries(q.hoje.quem_levou || {}).slice(0, 3).map(([t, n]) => esc(t) + " " + n).join(", ");
    h += '<p class="bm-hoje">Hoje: ' + q.hoje.pedidos + " pedidos · frete " + fmtR(q.hoje.frete) + " · prazo " + nf(q.hoje.prazo_real, 2) + " d úteis" +
         (lev ? " · levaram: " + lev : "") + (q.poucos ? ' · <b style="color:var(--alerta)">poucos pedidos</b>' : "") + "</p>";
    h += '<div class="bm-graf">' + grafico(q, d, sg && sg.banda) + "</div>";
    h += '<fieldset><legend class="bm-ajuda" style="margin:8px 0 0">Banda de ' + nome + " em " + uf + "</legend><div class=\"bm-pills\">";
    h += pill(s, "", "Sem banda", d == null, false);
    for(const b of q.bandas) h += pill(s, b.banda, fmtB(b.banda), igual(d, b.banda), sg && igual(sg.banda, b.banda));
    h += "</div></fieldset>";
    if(sg) h += '<p class="bm-hoje" style="margin-top:6px">Critério “' + esc(P.nome) + "” sugere: <b>" + (sg.banda == null ? "sem banda" : fmtB(sg.banda)) + "</b>" + (sg.motivo ? " (" + esc(sg.motivo) + ")" : "") + "</p>";
    h += resumo(q, d);
    h += "<details><summary>Ver as 10 bandas em tabela</summary>" + tabela(q, d) + "</details>";
    return h + "</article>";
  }
  function pill(s, v, rot, marcado, sug){
    return '<label class="bm-pill' + (sug ? " sug" : "") + '"><input type="radio" name="bm-' + s + '" value="' + v + '"' + (marcado ? " checked" : "") + "><span>" + rot + "</span></label>";
  }
  function resumo(q, d){
    const l = linha(q, d);
    if(!l) return '<p class="bm-res">Sem banda: vale a <b>Ponderada</b> 25/60/15 (sem estimativa de impacto nesta tela).</p>';
    const mix = Object.entries(l.mix).filter(([, v]) => v >= 0.005).sort((a, b) => b[1] - a[1]);
    let h = '<p class="bm-res">Com <b>' + fmtB(l.banda) + "</b>: economia <b class=\"" + (l.economia_rs >= 0 ? "pos" : "neg") + "\">" + fmtR(l.economia_mes) + "/mês</b> (" + fmtP(l.economia_pct) +
      ") · prazo médio " + nf(l.prazo, 2) + " d (<b class=\"" + (l.delta_prazo > 0.005 ? "neg" : "pos") + "\">" + fmtD(l.delta_prazo) + "</b> vs hoje) · prometido " + nf(l.prazo_prometido, 1) + " d</p>";
    h += '<div class="bm-mix" role="img" aria-label="Mix de transportadoras: ' + esc(mix.map(([t, v]) => t + " " + fmtP(v)).join(", ")) + '">' +
         mix.map(([t, v]) => '<i style="inline-size:' + (v * 100).toFixed(2) + "%;background:" + (COR[t] || "#888") + '"></i>').join("") + "</div>";
    h += '<div class="bm-mixleg">' + mix.map(([t, v]) => '<span><i style="background:' + (COR[t] || "#888") + '"></i>' + esc(t) + " " + fmtP(v) + "</span>").join("") + "</div>";
    if((l.pct_estimado || 0) > 0.5) h += '<p class="bm-alerta">' + fmtP(l.pct_estimado) + " dos pedidos vão para transportadora sem entrega medida aqui: o prazo é estimado pela tabela. Confirme com a operação.</p>";
    return h;
  }
  // gráfico de dispersão: x = Δ prazo (d), y = economia (%); um ponto por resultado distinto (bandas que dão o mesmo resultado viram um ponto só)
  function grafico(q, d, sug){
    const grupos = [];
    for(const b of q.bandas){
      const g = grupos.find(x => Math.abs(x.e - b.economia_pct) < 1e-6 && Math.abs(x.p - b.delta_prazo) < 1e-6);
      if(g) g.bs.push(b.banda); else grupos.push({ e: b.economia_pct, p: b.delta_prazo, bs: [b.banda] });
    }
    const W = 320, H = 170, L = 40, R = 12, T = 12, B = 30;
    const xs = grupos.map(g => g.p).concat(0), ys = grupos.map(g => g.e).concat(0);
    let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    if(x1 - x0 < 0.2){ x0 -= 0.1; x1 += 0.1; } if(y1 - y0 < 0.05){ y1 += 0.05; }
    const px = (x1 - x0) * 0.08, py = (y1 - y0) * 0.1; x0 -= px; x1 += px; y1 += py; if(y0 < 0) y0 -= py;
    const X = v => L + (v - x0) / (x1 - x0) * (W - L - R), Y = v => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
    const desc = "Economia versus mudança de prazo para cada banda de " + q.segmento;
    let s = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc(desc) + '">';
    s += '<line class="eixo" x1="' + L + '" y1="' + (H - B) + '" x2="' + (W - R) + '" y2="' + (H - B) + '"/>';
    s += '<line class="eixo" x1="' + L + '" y1="' + T + '" x2="' + L + '" y2="' + (H - B) + '"/>';
    if(x0 < 0 && x1 > 0) s += '<line class="zero" x1="' + X(0) + '" y1="' + T + '" x2="' + X(0) + '" y2="' + (H - B) + '"/>';
    if(y0 < 0) s += '<line class="zero" x1="' + L + '" y1="' + Y(0) + '" x2="' + (W - R) + '" y2="' + Y(0) + '"/>';
    s += '<text x="' + (L - 4) + '" y="' + (T + 8) + '" text-anchor="end">' + nf(y1 * 100, 0) + "%</text>";
    s += '<text x="' + (L - 4) + '" y="' + Y(Math.max(y0, 0)) + '" text-anchor="end">' + nf(Math.max(y0, 0) * 100, 0) + "%</text>";
    s += '<text x="' + L + '" y="' + (H - B + 13) + '">' + fmtD(x0) + "</text>";
    s += '<text x="' + (W - R) + '" y="' + (H - B + 13) + '" text-anchor="end">' + fmtD(x1) + "</text>";
    s += '<text x="' + ((L + W - R) / 2) + '" y="' + (H - 4) + '" text-anchor="middle">prazo vs hoje (← mais rápido · mais lento →)</text>';
    s += '<text x="12" y="' + ((T + H - B) / 2) + '" text-anchor="middle" transform="rotate(-90 12 ' + ((T + H - B) / 2) + ')">economia</text>';
    // caixas já ocupadas (todos os pontos + rótulos já postos): o rótulo novo procura um lugar livre
    const usados = grupos.map(g => ({ x: X(g.p) - 7, y: Y(g.e) - 7, w: 14, h: 14 }));
    const colide = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    for(const g of [...grupos].sort((a, b) => a.p - b.p || b.e - a.e)){
      const sel = g.bs.some(b => igual(b, d)), sg = g.bs.some(b => igual(b, sug));
      const rot = g.bs.length > 1 ? nf(g.bs[0], 1) + "–" + nf(g.bs[g.bs.length - 1], 1) : nf(g.bs[0], 1);
      const cx = X(g.p), cy = Y(g.e), w = rot.length * 5.6 + 2;
      const esq = cx + 9 + w > W - 2;          // perto da borda direita: rótulo à esquerda do ponto
      let cand = { x: esq ? cx - 9 - w : cx + 9, y: cy - 4, w, h: 11 };
      for(const dy of [0, -12, 12, -24, 24, -36, 36]){
        const c = { x: cand.x, y: cy - 4 + dy, w, h: 11 };
        if(!usados.some(u => colide(u, c)) && c.y > 0 && c.y + 11 < H - B + 4){ cand = c; break; }
      }
      usados.push(cand);
      s += '<g data-b="' + g.bs[0] + '"><title>' + esc("Banda " + rot + " d: economia " + fmtP(g.e) + ", prazo " + fmtD(g.p)) + "</title>" +
           '<circle class="pt' + (sel ? " sel" : "") + (sg ? " sug" : "") + '" cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="' + (sel ? 7 : 5.5) + '"/>' +
           '<text class="' + (sel ? "rot" : "") + '" x="' + cand.x.toFixed(1) + '" y="' + (cand.y + 8.5).toFixed(1) + '">' + rot + "</text></g>";
    }
    return s + "</svg>";
  }
  function tabela(q, d){
    let h = '<div class="bm-tab"><table><thead><tr><th scope="col">Banda</th><th scope="col">Economia</th><th scope="col">R$/mês</th><th scope="col">Prazo</th><th scope="col">Δ prazo</th><th scope="col">Prometido</th><th scope="col">% estimado</th></tr></thead><tbody>';
    for(const b of q.bandas) h += '<tr class="' + (igual(d, b.banda) ? "sel" : "") + '"><td>' + fmtB(b.banda) + "</td><td>" + fmtP(b.economia_pct) + "</td><td>" + fmtR(b.economia_mes) +
      "</td><td>" + nf(b.prazo, 2) + " d</td><td>" + fmtD(b.delta_prazo) + "</td><td>" + nf(b.prazo_prometido, 1) + " d</td><td>" + fmtP(b.pct_estimado || 0) + "</td></tr>";
    return h + "</tbody></table></div>";
  }

  // ---------- salvar ----------
  function itens(){
    const out = [];
    for(const u of est.ufs) for(const [s] of SEG){ const b = desejado(u, s); if(b != null) out.push({ uf: u, segmento: s, banda: b, motivo: "" }); }
    return out;
  }
  async function barra(){
    const ks = pendentes(), bar = $("#bm-bar"), id = ++vez;
    bar.hidden = !ks.length;
    if(!ks.length) return;
    $("#bm-st").innerHTML = "<b>" + ks.length + (ks.length === 1 ? " alteração pendente" : " alterações pendentes") + "</b> · conferindo…";
    $("#bm-salvar").disabled = true;
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
    $("#bm-salvar").disabled = true;
    try{
      const r = await api("PUT", "/v1/cobertura/banda", { regras: itens(), base_versao: est.versao, motivo });
      toast("Bandas salvas (" + (r.mudancas || []).length + " mudança(s)).");
      $("#bm-motivo").value = ""; await carregarTudo();
    }catch(e){
      if(e.status === 409){ toast("As bandas mudaram enquanto você editava. Recarreguei.", { erro: true }); await carregarTudo(); }
      else { toast(msgErro(e), { erro: true }); barra(); }
    }
  }
  $("#bm-desfazer").onclick = () => { des = new Map(); $("#bm-motivo").value = ""; atualizarTudo(); };
  $("#bm-salvar").onclick = salvar;

  carregarTudo().catch(e => {
    montado = false;
    raiz.innerHTML = '<div class="aviso">Não consegui carregar as bandas agora. ' + esc(msgErro(e)) + ' <button type="button" class="btn" id="bm-tentar">Tentar de novo</button></div>';
    const t = raiz.querySelector("#bm-tentar"); if(t) t.onclick = () => montar(raiz, ctx);
  });
}

window.BandasM3 = { montar };
})();
