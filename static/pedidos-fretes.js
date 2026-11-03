/* Pedidos e fretes — ferramenta de Administração (pedidos.html). Só ADMINISTRAÇÃO (permissão `pedidos_ver`; TI sempre).
   Uso: PedidosFretes.montar(elementoRaiz, { api, toast, msgErro, podeExcluir })
     api(metodo, caminho, corpo) -> Promise (login do Portal), toast(msg, {erro}), msgErro(e) -> texto,
     podeExcluir = permissão `pedidos_excluir` (TI): mostra as caixinhas e o botão Excluir.
   Rotas da Azure: GET /v1/portal/pedidos (só leitura; sem `desde` = desde segunda 00h de Brasília) e
   POST /v1/portal/pedidos/excluir {ids, motivo} (vai antes para a tabela de excluídos — dá para recuperar).
   Só os pedidos DESTA SEMANA (pedido do usuário, 28/10); os totais são só dos pedidos que estão na tela.
   Diferença = real − simulado, na mesma base de imposto (portal_pedidos.py). Sem polling: busca ao abrir e em Atualizar. */
(function(){
"use strict";
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const nf = (v, d) => Number(v).toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });
const R = v => v == null ? "—" : "R$ " + nf(v, 2);
const sinal = v => v > 0 ? "+" : v < 0 ? "−" : "";
const DIF = (v, p) => v == null ? "—" : sinal(v) + "R$ " + nf(Math.abs(v), 2) + (p == null ? "" : " (" + sinal(p) + nf(Math.abs(p), 1) + "%)");
const diaHora = iso => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); };
const dia = d => d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
const nfNum = chave => chave && chave.length === 44 && /^\d+$/.test(chave) ? String(parseInt(chave.slice(25, 34), 10)) : "";
// o SAP passou a mandar a CHAVE DO PEDIDO no campo da NF (03/11/2026): chave de 44 dígitos = NF (mostra o nº da NF); outra = pedido (mostra a chave)
const refPedido = chave => nfNum(chave) || chave || "";
const rotChave = p => p.chave_tipo === "pedido" ? "Pedido" : p.chave_tipo === "nf" ? "NF" : "";
const SIT = { teste: ["Teste", "pf-teste"], sem_chave: ["Sem chave", "pf-aviso"], aguardando_real: ["Aguardando real", "pf-espera"],
  ok: ["No esperado", "pf-ok"], divergente: ["Divergente", "pf-erro"] };
const BASE = { com_imposto: "simulado com imposto × real", sem_imposto: "simulado × real", sem_imposto_aprox: "simulado × real sem ICMS (≈ 12%)" };

const CSS = `
.pf-topo{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 14px;margin:2px 0 14px}
.pf-semana{font-size:14px;font-weight:700;color:var(--soft)}
.pf-barra{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:14px}
.pf-seg{display:inline-flex;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.pf-seg button{font:inherit;font-size:13.5px;font-weight:700;padding:7px 12px;border:0;background:transparent;color:var(--soft);cursor:pointer}
.pf-seg button[aria-pressed="true"]{background:var(--brand);color:var(--card)}
.pf-barra select,.pf-barra input{font:inherit;font-size:13.5px;padding:7px 10px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink)}
.pf-barra input{flex:1 1 200px;min-width:160px}
.pf-barra .esp{flex:1 1 0}
.pf-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;margin-bottom:14px}
.pf-kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px}
.pf-kpi .l{font-size:12px;color:var(--soft);font-weight:700;text-transform:uppercase;letter-spacing:.03em}
.pf-kpi .n{font-size:24px;font-weight:800;line-height:1.25;margin-top:2px;font-variant-numeric:tabular-nums}
.pf-kpi .s{font-size:12.5px;color:var(--soft);margin-top:2px}
.pf-faixa{padding:10px 14px;border-radius:10px;border:1px solid color-mix(in srgb,var(--bl,#f4a72c) 45%,var(--line));background:color-mix(in srgb,var(--bl,#f4a72c) 10%,transparent);font-size:13.5px;margin:0 0 12px}
.pf-sel{display:flex;align-items:center;gap:10px;padding:8px 12px;margin-bottom:8px;border-radius:10px;background:color-mix(in srgb,var(--bq,#f87171) 12%,transparent);font-size:13.5px;font-weight:700}
.pf-tab{overflow-x:auto;border:1px solid var(--line);border-radius:14px;background:var(--card)}
.pf-tab table{width:100%;border-collapse:collapse;font-size:13.5px}
.pf-tab th{position:sticky;top:0;background:var(--card);text-align:left;padding:10px;border-bottom:1px solid var(--line);font-size:11.5px;text-transform:uppercase;letter-spacing:.03em;color:var(--soft);white-space:nowrap}
.pf-tab td{padding:9px 10px;border-bottom:1px solid color-mix(in srgb,var(--line) 70%,transparent);white-space:nowrap;vertical-align:middle}
.pf-tab tbody tr:last-child td{border-bottom:0}
.pf-tab tbody tr:hover td{background:color-mix(in srgb,var(--brand) 6%,transparent)}
.pf-tab td.num,.pf-tab th.num{text-align:right;font-variant-numeric:tabular-nums}
.pf-tab td.ck,.pf-tab th.ck{width:34px;text-align:center}
.pf-tab .sub2{display:block;font-size:12px;color:var(--soft)}
.pf-tab tr.pf-t td{background:color-mix(in srgb,var(--brand) 4%,transparent)}
.pf-badge{display:inline-block;padding:2px 9px;border-radius:20px;font-size:12px;font-weight:800;white-space:nowrap}
.pf-teste{background:color-mix(in srgb,var(--brand) 18%,transparent);color:var(--brand)}
.pf-ok{background:color-mix(in srgb,var(--at,#34d399) 18%,transparent);color:var(--at,#34d399)}
.pf-erro{background:color-mix(in srgb,var(--bq,#f87171) 18%,transparent);color:var(--bq,#f87171)}
.pf-aviso{background:color-mix(in srgb,var(--bl,#f4a72c) 20%,transparent);color:var(--bl,#f4a72c)}
:root[data-theme="light"] .pf-aviso{color:#92400e}
.pf-espera{background:color-mix(in srgb,var(--soft) 16%,transparent);color:var(--soft)}
.pf-pos{color:var(--bq,#f87171);font-weight:700} .pf-neg{color:var(--at,#34d399);font-weight:700}
.pf-rod{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:10px;font-size:12.5px;color:var(--soft)}
.pf-hist{margin-bottom:10px}
.pf-hist:empty{display:none}
.pf-k-hist{border-color:color-mix(in srgb,var(--brand) 35%,var(--line))}
.pf-k-hist .n{color:var(--brand)}
@media (max-width:900px){.pf-barra input{flex:1 1 100%} .pf-barra select{flex:1 1 150px;min-width:0}}
@media (max-width:640px){
  .pf-barra .esp{display:none}
  .pf-seg{width:100%} .pf-seg button{flex:1}
  .pf-barra .btn{flex:1 1 calc(50% - 4px)}
  .pf-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}
  .pf-kpi{padding:10px 12px} .pf-kpi .n{font-size:19px;overflow-wrap:anywhere} .pf-kpi .l{font-size:11px}
  .pf-tab{border:0;background:transparent;overflow:visible}
  .pf-tab table,.pf-tab thead,.pf-tab tbody,.pf-tab tr,.pf-tab td{display:block;width:100%}
  .pf-tab thead{position:absolute;left:-9999px}
  .pf-tab tr{background:var(--card);border:1px solid var(--line);border-radius:12px;margin:0 0 10px;padding:6px 12px}
  .pf-tab td{display:flex;justify-content:space-between;align-items:center;gap:12px;white-space:normal;text-align:right;border-bottom:1px solid color-mix(in srgb,var(--line) 60%,transparent);padding:7px 0}
  .pf-tab td:last-child{border-bottom:0}
  .pf-tab td[data-l]::before{content:attr(data-l);color:var(--soft);font-size:12px;font-weight:700;text-align:left;flex:none}
  .pf-tab td.ck{justify-content:flex-start;width:auto}
  .pf-tab .sub2{display:inline;margin-left:6px}
  .pf-rod{flex-direction:column}
}
`;

function montar(raiz, ctx){
  if(!document.getElementById("pf-css")){ const s = document.createElement("style"); s.id = "pf-css"; s.textContent = CSS; document.head.appendChild(s); }
  if(raiz.dataset.pf === "1"){ if(raiz._pfAtualizar) raiz._pfAtualizar(); return; }
  raiz.dataset.pf = "1";
  const podeExcluir = !!ctx.podeExcluir;
  let dados = null, carregando = false, pendente = false, tipo = "nao";
  let pagina = 0, acabou = false, vazias = 0, ini0 = null;   // rolagem infinita: 1 semana por vez, da atual para trás
  const MAX_SEMANAS = 52, MAX_VAZIAS = 4;   // sem "Todos": produção ou teste, nunca misturados
  const sel = new Set();
  raiz.innerHTML = `
    <div class="pf-topo"><span class="pf-semana" id="pf-semana">Pedidos desta semana</span></div>
    <div class="pf-barra">
      <div class="pf-seg" role="group" aria-label="Tipo de pedido">
        <button type="button" data-tipo="nao" aria-pressed="true">Produção</button>
        <button type="button" data-tipo="sim" aria-pressed="false">Teste</button>
      </div>
      <select id="pf-sit" aria-label="Situação"><option value="">Todas as situações</option><option value="ok">No esperado</option><option value="divergente">Divergente</option><option value="aguardando_real">Aguardando real</option><option value="sem_chave">Sem chave da NF</option></select>
      <select id="pf-transp" aria-label="Transportadora"><option value="">Todas as transportadoras</option></select>
      <input id="pf-q" placeholder="Buscar NF, pedido, chave, cidade ou CEP" aria-label="Buscar">
      <span class="esp"></span>
      <button class="btn" id="pf-ok" type="button">↻ Atualizar</button>
      <button class="btn" id="pf-xls" type="button">⬇ Excel</button>
    </div>
    <div id="pf-faixa"></div>
    <div class="pf-kpis pf-hist" id="pf-hist" aria-label="Todo o histórico guardado"></div>
    <div class="pf-kpis" id="pf-kpis"></div>
    <div id="pf-selbar"></div>
    <div class="pf-tab" id="pf-tab"><div class="vazio">carregando…</div></div>
    <div id="pf-mais" style="text-align:center;color:var(--soft);font-size:13.5px;padding:10px 0"></div>
    <div class="pf-rod" id="pf-rod"></div>
    <div class="mdl" id="pf-mdl" hidden><div class="box" role="dialog" aria-modal="true" aria-labelledby="pf-mt">
      <h3 id="pf-mt">Excluir pedidos</h3><div id="pf-mres"></div>
      <label style="display:block;margin-top:12px;font-size:13px;font-weight:600">Motivo (obrigatório)
        <textarea id="pf-mot" rows="2" maxlength="300" placeholder="Ex.: pedido de teste da consultoria"></textarea></label>
      <p class="sub" style="margin:10px 0 0">Os pedidos saem da lista e ficam guardados na tabela de excluídos, com o seu e-mail e o motivo.</p>
      <div class="acoes"><button class="btn" id="pf-mno" type="button">Cancelar</button><button class="btn pri" id="pf-msim" type="button">Excluir</button></div>
    </div></div>`;
  const $ = s => raiz.querySelector(s);

  function consulta(pg){
    const p = new URLSearchParams({ teste: tipo, limite: "1000" });   // pg 0 sem `desde`: a Azure usa segunda 00h (Brasília)
    if(pg > 0){ p.set("desde", new Date(ini0 - 7 * 864e5 * pg).toISOString()); p.set("ate", new Date(ini0 - 7 * 864e5 * (pg - 1) - 1).toISOString()); }
    if($("#pf-sit").value) p.set("situacao", $("#pf-sit").value);
    if($("#pf-transp").value) p.set("transportadora", $("#pf-transp").value);
    if($("#pf-q").value.trim()) p.set("q", $("#pf-q").value.trim());   // nº da NF está dentro da chave: a busca por trecho acha
    return "/v1/portal/pedidos?" + p.toString();
  }

  // filtro mudou durante uma busca: refaz ao terminar (senão a mudança se perde)
  async function atualizar(){
    if(carregando){ pendente = true; return; }
    carregando = true; pendente = false; $("#pf-ok").disabled = true;
    if(!dados) $("#pf-tab").innerHTML = '<div class="vazio">carregando…</div>';
    let erro = null;
    try{ dados = await ctx.api("GET", consulta(0)); }catch(e){ erro = e; }
    carregando = false; $("#pf-ok").disabled = false;
    pagina = 0; vazias = 0; acabou = true;
    if(!erro && dados.janela && dados.janela.desde){ ini0 = new Date(dados.janela.desde).getTime(); acabou = false; }
    if(pendente) return atualizar();
    if(erro){ $("#pf-tab").innerHTML = '<div class="vazio">' + esc(ctx.msgErro(erro)) + "</div>"; return; }
    for(const id of [...sel]) if(!dados.pedidos.some(p => p.id === id)) sel.delete(id);
    render();
    carregarResumo();
  }
  raiz._pfAtualizar = atualizar;

  // Total de TODOS os pedidos já feitos e do frete simulado: vem pronto da Azure (soma de dias guardados), não recalculado aqui.
  let resumoHist = null, resumoEm = 0;
  async function carregarResumo(){
    if(Date.now() - resumoEm < 60000 && resumoHist) { pintarHist(); return; }
    try{ resumoHist = await ctx.api("GET", "/v1/portal/pedidos/resumo"); resumoEm = Date.now(); }catch(e){ resumoHist = { erro: true }; }
    pintarHist();
  }
  function pintarHist(){
    const h = resumoHist, box = $("#pf-hist");
    if(!box) return;
    if(!h || h.erro || h.storage === false){ box.innerHTML = ""; return; }
    const desde = h.desde ? new Date(h.desde + "T12:00:00").toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" }) : "";
    const porMes = (h.meses || []).map(m => m.mes.slice(5) + "/" + m.mes.slice(2, 4) + ": " + nf(m.pedidos, 0) + " pedidos · " + R(m.simulado)).join("\n");
    box.innerHTML =
      `<div class="pf-kpi pf-k-hist" title="${esc(porMes)}"><div class="l">Pedidos feitos (total)</div><div class="n">${nf(h.pedidos || 0, 0)}</div><div class="s">produção, sem cliques repetidos${desde ? " · desde " + desde : ""}</div></div>` +
      `<div class="pf-kpi pf-k-hist" title="${esc(porMes)}"><div class="l">Frete simulado (total)</div><div class="n">${R(h.simulado || 0)}</div><div class="s">soma de todos os fretes escolhidos${h.dias ? " · " + nf(h.dias, 0) + " dias guardados" : ""}</div></div>`;
  }

  // soma o resumo no navegador (mesma conta de portal_pedidos._resumo na Azure) porque as semanas chegam em páginas
  function resumir(ls){
    const prod = ls.filter(l => !l.teste), cr = prod.filter(l => l.real_comparavel != null);
    const sim = cr.reduce((a, l) => a + (l.simulado_com_imposto || l.simulado), 0), real = cr.reduce((a, l) => a + l.real_comparavel, 0);
    return { pedidos: ls.length, testes: ls.length - prod.length, producao: prod.length, simulado_producao: prod.reduce((a, l) => a + l.simulado, 0),
      com_real: cr.length, sem_chave: prod.filter(l => l.situacao === "sem_chave").length, aguardando_real: prod.filter(l => l.situacao === "aguardando_real").length,
      divergentes: prod.filter(l => l.situacao === "divergente").length, simulado_com_real: sim, real_comparavel: real, diferenca: real - sim,
      diferenca_pct: sim ? Math.round((real - sim) / sim * 1000) / 10 : null };
  }
  async function carregarMais(){
    if(carregando || acabou || !dados) return;
    carregando = true; const pg = pagina + 1, tipoAntes = tipo;
    $("#pf-mais").textContent = "carregando semanas anteriores…";
    let r = null;
    try{ r = await ctx.api("GET", consulta(pg)); }catch(e){ carregando = false; $("#pf-mais").innerHTML = '<button class="btn" type="button" id="pf-mais-bt">Não consegui carregar — tentar de novo</button>'; $("#pf-mais-bt").onclick = carregarMais; return; }
    carregando = false;
    if(tipoAntes !== tipo || pendente){ if(pendente) atualizar(); return; }   // filtro mudou no meio: a lista nova já recomeçou
    pagina = pg; const novos = r.pedidos || [];
    vazias = novos.length ? 0 : vazias + 1;
    if(pagina >= MAX_SEMANAS || vazias >= MAX_VAZIAS || r.erro) acabou = true;
    dados.pedidos = dados.pedidos.concat(novos); dados.total += r.total || 0; dados.truncado = dados.truncado || !!r.truncado; dados.repetidas_ocultas = (dados.repetidas_ocultas || 0) + (r.repetidas_ocultas || 0);
    dados.resumo = resumir(dados.pedidos); dados.janela.desde = new Date(ini0 - 7 * 864e5 * pagina).toISOString();
    render();
  }
  const olho = new IntersectionObserver(es => { if(es.some(e => e.isIntersecting)) carregarMais(); }, { rootMargin: "400px" });
  const dica = () => { $("#pf-mais").textContent = acabou ? (pagina ? "Chegou ao fim do histórico." : "") : "role para carregar as semanas anteriores"; olho.disconnect(); if(!acabou) olho.observe($("#pf-mais")); };

  function render(){
    const d = dados, rs = d.resumo || {};
    if(d.janela && d.janela.desde){ const ini = pagina && d.pedidos.length ? new Date(d.pedidos[d.pedidos.length - 1].criado_em) : new Date(d.janela.desde), fim = new Date(ini0 + 6 * 864e5);
      $("#pf-semana").textContent = (pagina ? "De " : "Semana de ") + dia(ini) + " a " + dia(fim) + " · " + nf(d.total || 0, 0) + " pedido" + (d.total === 1 ? "" : "s"); }
    let faixa = "";
    if(d.storage === false) faixa = "A Azure não está guardando os pedidos agora (armazenamento desligado).";
    else if(d.erro) faixa = d.erro;
    else if(rs.producao && !rs.com_real) faixa = "O frete real ainda não chegou para os pedidos desta semana — o CT-e costuma vir dias depois da NF.";
    $("#pf-faixa").innerHTML = faixa ? '<div class="pf-faixa">' + esc(faixa) + "</div>" : "";
    const dif = rs.diferenca, cDif = dif > 0 ? "pf-pos" : dif < 0 ? "pf-neg" : "";
    $("#pf-kpis").innerHTML =
      `<div class="pf-kpi"><div class="l">Pedidos na tela</div><div class="n">${nf(rs.pedidos || 0, 0)}</div><div class="s">${nf(rs.producao || 0, 0)} produção · ${nf(rs.testes || 0, 0)} teste</div></div>` +
      `<div class="pf-kpi"><div class="l">Frete simulado</div><div class="n">${R(rs.simulado_producao || 0)}</div><div class="s">dos pedidos de produção na tela · sem imposto</div></div>` +
      `<div class="pf-kpi"><div class="l">Simulado × real</div><div class="n ${cDif}">${rs.com_real ? DIF(dif, rs.diferenca_pct) : "—"}</div><div class="s">${rs.com_real ? nf(rs.com_real, 0) + " com real · " + R(rs.simulado_com_real) + " → " + R(rs.real_comparavel) : "nenhum pedido com real ainda"}</div></div>` +
      `<div class="pf-kpi"><div class="l">Atenção</div><div class="n">${nf((rs.divergentes || 0) + (rs.sem_chave || 0), 0)}</div><div class="s">${nf(rs.divergentes || 0, 0)} divergentes · ${nf(rs.sem_chave || 0, 0)} sem chave · ${nf(rs.aguardando_real || 0, 0)} aguardando</div></div>`;
    const tsel = $("#pf-transp"), atual = tsel.value, nomes = [...new Set((d.pedidos || []).map(p => p.transportadora).filter(Boolean))].sort();
    if(atual && !nomes.includes(atual)) nomes.push(atual);
    tsel.innerHTML = '<option value="">Todas as transportadoras</option>' + nomes.map(n => `<option ${n === atual ? "selected" : ""}>${esc(n)}</option>`).join("");
    renderSel();
    if(!(d.pedidos || []).length){ $("#pf-tab").innerHTML = '<div class="vazio">Nenhum pedido nesta semana com estes filtros.</div>'; $("#pf-rod").textContent = ""; dica(); return; }
    const todos = d.pedidos.every(p => sel.has(p.id));
    $("#pf-tab").innerHTML = '<table><thead><tr>' + (podeExcluir ? `<th class="ck"><input type="checkbox" id="pf-all" aria-label="Selecionar todos" ${todos ? "checked" : ""}></th>` : "") +
      '<th>Data</th><th>NF / Pedido</th><th>Destino</th><th class="num">Vol.</th><th>Transportadora</th>' +
      '<th class="num">Simulado</th><th class="num">Real cobrado</th><th class="num">Diferença</th><th>Situação</th></tr></thead><tbody>' +
      d.pedidos.map(p => {
        const s = SIT[p.situacao] || [p.situacao, "pf-espera"], c = p.diferenca > 0 ? "pf-pos" : p.diferenca < 0 ? "pf-neg" : "", n = refPedido(p.chave_nf);
        return `<tr class="${p.teste ? "pf-t" : ""}">` + (podeExcluir ? `<td class="ck"><input type="checkbox" data-id="${esc(p.id)}" aria-label="Selecionar" ${sel.has(p.id) ? "checked" : ""}></td>` : "") +
          `<td data-l="Data">${esc(diaHora(p.criado_em))}${p.repeticoes ? ` <span class="sub2" title="${p.repeticoes} clique${p.repeticoes > 1 ? "s" : ""} anterior${p.repeticoes > 1 ? "es" : ""} do mesmo pedido (${p.agrupado_por === "nf" ? "mesma NF ou pedido" : p.agrupado_por === "impressao" ? "mesmos itens, valor e destino" : "mesmo valor, CEP, peso e dia"}) — vale o mais recente">×${p.repeticoes + 1}</span>` : ""}</td>` +
          `<td data-l="NF / Pedido" title="${esc(p.chave_nf || "sem chave")}">${n ? esc(n) + (rotChave(p) === "Pedido" ? '<span class="sub2">pedido</span>' : "") : '<span class="sub2">—</span>'}</td>` +
          `<td data-l="Destino">${esc(p.cidade)}${p.uf ? " / " + esc(p.uf) : ""}</td><td class="num" data-l="Volumes">${p.volumes || ""}</td>` +
          `<td data-l="Transportadora">${esc(p.transportadora)}${p.transportadora_real && p.transportadora_real !== p.transportadora ? '<span class="sub2">levou: ' + esc(p.transportadora_real) + "</span>" : ""}</td>` +
          `<td class="num" data-l="Simulado" title="${p.simulado_com_imposto ? "com imposto: " + R(p.simulado_com_imposto) : "sem imposto"}">${R(p.simulado)}</td>` +
          `<td class="num" data-l="Real cobrado" title="${p.real_compartilhado ? "CT-e dividido entre várias NFs (valor rateado)" : ""}">${R(p.real)}${p.real_compartilhado ? " ⧉" : ""}</td>` +
          `<td class="num ${c}" data-l="Diferença" title="${esc(BASE[p.base_comparacao] || "")}">${DIF(p.diferenca, p.diferenca_pct)}</td>` +
          `<td data-l="Situação"><span class="pf-badge ${s[1]}">${esc(s[0])}</span></td></tr>`;
      }).join("") + "</tbody></table>";
    dica();
    $("#pf-rod").innerHTML = `<span>${nf(d.pedidos.length, 0)} de ${nf(d.total, 0)} pedidos${d.truncado ? " — refine a busca para ver o restante" : ""}</span>` +
      `<span>Diferença = real − simulado, na mesma base de imposto. ⧉ = CT-e dividido entre NFs.${dados.repetidas_ocultas ? " ×N = pedido clicado N vezes (conta uma só); " + nf(dados.repetidas_ocultas, 0) + " repetida" + (dados.repetidas_ocultas > 1 ? "s" : "") + " oculta" + (dados.repetidas_ocultas > 1 ? "s" : "") + "." : ""}</span>`;
  }

  function renderSel(){
    $("#pf-selbar").innerHTML = podeExcluir && sel.size
      ? `<div class="pf-sel">${sel.size} selecionado${sel.size > 1 ? "s" : ""}<span style="flex:1"></span><button class="btn" type="button" id="pf-limpa">Limpar</button><button class="btn pri" type="button" id="pf-exc">Excluir…</button></div>` : "";
    if(!sel.size) return;
    $("#pf-limpa").onclick = () => { sel.clear(); render(); };
    $("#pf-exc").onclick = abrirExcluir;
  }

  function abrirExcluir(){
    const n = sel.size, lista = dados.pedidos.filter(p => sel.has(p.id));
    const prod = lista.filter(p => !p.teste).length;
    $("#pf-mres").innerHTML = `<p style="margin:0">Excluir <b>${n}</b> pedido${n > 1 ? "s" : ""} da lista` + (prod ? ` — <b>${prod}</b> de produção` : " (todos de teste)") + ".</p>";
    $("#pf-mot").value = ""; $("#pf-mdl").hidden = false; $("#pf-mot").focus();
  }
  $("#pf-mno").onclick = () => { $("#pf-mdl").hidden = true; };
  $("#pf-msim").onclick = async () => {
    const motivo = $("#pf-mot").value.trim();
    if(motivo.length < 3){ ctx.toast("Escreva o motivo da exclusão.", { erro: true }); return; }
    const bt = $("#pf-msim"); bt.disabled = true;
    try{
      const todos = new Set(sel); for(const p of dados.pedidos) if(sel.has(p.id)) (p.ids_repetidos || []).forEach(i => todos.add(i));   // as repetidas saem junto, senão a mais antiga reapareceria
      const r = await ctx.api("POST", "/v1/portal/pedidos/excluir", { ids: [...todos].slice(0, 200), motivo });
      ctx.toast(r.excluidos + " pedido" + (r.excluidos === 1 ? "" : "s") + " excluído" + (r.excluidos === 1 ? "" : "s") + (r.falhas ? " · " + r.falhas + " não deu" : "") + ".", { erro: !!r.falhas && !r.excluidos });
      sel.clear(); $("#pf-mdl").hidden = true; atualizar();
    }catch(e){ ctx.toast(ctx.msgErro(e), { erro: true }); }
    bt.disabled = false;
  };

  $("#pf-tab").addEventListener("change", e => {
    const t = e.target;
    if(t.id === "pf-all"){ for(const p of dados.pedidos) t.checked ? sel.add(p.id) : sel.delete(p.id); render(); return; }
    if(t.dataset && t.dataset.id){ t.checked ? sel.add(t.dataset.id) : sel.delete(t.dataset.id); renderSel();
      const all = $("#pf-all"); if(all) all.checked = dados.pedidos.every(p => sel.has(p.id)); }
  });

  function exportar(){
    if(!dados || !(dados.pedidos || []).length){ ctx.toast("Nada para exportar.", { erro: true }); return; }
    const cab = ["Data", "Teste", "NF / Pedido", "Chave", "UF", "Cidade", "Volumes", "Peso kg", "Transportadora", "Quem levou", "Simulado (sem imposto)", "Simulado (com imposto)", "Real cobrado", "Real comparável", "Diferença R$", "Diferença %", "Base", "Situação"];
    const linhas = dados.pedidos.map(p => [p.criado_em, p.teste ? "Sim" : "Não", refPedido(p.chave_nf), p.chave_nf, p.uf, p.cidade, p.volumes, p.peso, p.transportadora, p.transportadora_real,
      p.simulado, p.simulado_com_imposto, p.real, p.real_comparavel, p.diferenca, p.diferenca_pct, BASE[p.base_comparacao] || "", (SIT[p.situacao] || [p.situacao])[0]]);
    if(typeof XLSX !== "undefined"){
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([cab].concat(linhas)), "Pedidos");
      XLSX.writeFile(wb, "pedidos-e-fretes.xlsx"); return;
    }
    const csv = [cab].concat(linhas).map(l => l.map(v => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"').join(";")).join("\r\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" })); a.download = "pedidos-e-fretes.csv"; a.click();
  }

  raiz.querySelectorAll(".pf-seg button").forEach(b => b.onclick = () => {
    tipo = b.dataset.tipo; raiz.querySelectorAll(".pf-seg button").forEach(x => x.setAttribute("aria-pressed", String(x === b))); atualizar(); });
  $("#pf-ok").onclick = atualizar; $("#pf-xls").onclick = exportar;
  $("#pf-sit").addEventListener("change", atualizar); $("#pf-transp").addEventListener("change", atualizar);
  let tq = null; $("#pf-q").addEventListener("input", () => { clearTimeout(tq); tq = setTimeout(atualizar, 450); });
  atualizar();
}
window.PedidosFretes = { montar };
})();
