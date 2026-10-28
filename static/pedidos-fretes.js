/* Pedidos e fretes — aba do Custo de Frete (custo.html).
   Uso: PedidosFretes.montar(elementoRaiz, { api, toast, msgErro })
     api(metodo, caminho) -> Promise (já com o login do Portal), toast(msg, {erro}), msgErro(e) -> texto.
   Rota da Azure (mesmo acesso do Custo de Frete, SÓ LEITURA): GET /v1/portal/pedidos?desde&ate&teste&uf&transportadora&q&situacao&limite
   Mostra o que a Azure escolheu para cada pedido (frete SIMULADO), os pedidos de TESTE e o frete REAL cobrado
   (SAP, quando o coletor já gravou). Diferença = real − simulado, já na mesma base de imposto (ver portal_pedidos.py).
   Sem polling: busca ao abrir a aba e ao clicar em Atualizar. */
(function(){
"use strict";
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const nf = (v, d) => Number(v).toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });
const R = v => v == null ? "—" : "R$ " + nf(v, 2);
const DIF = (v, p) => v == null ? "—" : (v > 0 ? "+" : v < 0 ? "−" : "") + "R$ " + nf(Math.abs(v), 2) + (p == null ? "" : " (" + (p > 0 ? "+" : p < 0 ? "−" : "") + nf(Math.abs(p), 1) + "%)");
const dataBR = iso => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); };
const nfNum = chave => chave && chave.length === 44 ? String(parseInt(chave.slice(25, 34), 10)) : "";
const SITUACOES = { teste: ["Teste", "pf-teste"], sem_chave: ["Sem chave da NF", "pf-aviso"], aguardando_real: ["Aguardando real", "pf-espera"],
  ok: ["Dentro do esperado", "pf-ok"], divergente: ["Divergente", "pf-erro"] };
const BASE = { com_imposto: "simulado com imposto × real", sem_imposto: "simulado × real", sem_imposto_aprox: "simulado × real sem ICMS (≈ 12%)" };

const CSS = `
.pf-filtros{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin:12px 0}
.pf-filtros label{display:flex;flex-direction:column;gap:3px;font-size:12px;font-weight:700;color:var(--soft)}
.pf-filtros select,.pf-filtros input{font:inherit;font-size:14px;padding:7px 9px;border-radius:9px;border:1px solid var(--line);background:var(--card);color:var(--ink);min-width:110px}
.pf-resumo{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:8px 0 14px}
.pf-resumo .card{padding:12px 14px}
.pf-resumo .n{font-size:22px;font-weight:800;line-height:1.2}
.pf-resumo .l{font-size:12px;color:var(--soft);font-weight:700}
.pf-resumo .s{font-size:12.5px;color:var(--soft);margin-top:2px}
.pf-aviso-faixa{padding:10px 14px;border-radius:10px;border:1px solid var(--line);background:color-mix(in srgb,var(--bl,#f4a72c) 12%,transparent);font-size:13.5px;margin:8px 0}
.pf-tab{overflow-x:auto;border:1px solid var(--line);border-radius:12px}
.pf-tab table{width:100%;border-collapse:collapse;font-size:13.5px}
.pf-tab th{position:sticky;top:0;background:var(--card);text-align:left;padding:9px 10px;border-bottom:2px solid var(--line);font-size:12px;color:var(--soft);white-space:nowrap}
.pf-tab td{padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
.pf-tab td.num,.pf-tab th.num{text-align:right;font-variant-numeric:tabular-nums}
.pf-tab tr.pf-t td{opacity:.78}
.pf-badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:12px;font-weight:800}
.pf-teste{background:color-mix(in srgb,var(--brand) 18%,transparent);color:var(--brand)}
.pf-ok{background:color-mix(in srgb,var(--at,#34d399) 18%,transparent);color:var(--at,#34d399)}
.pf-erro{background:color-mix(in srgb,var(--bq,#f87171) 18%,transparent);color:var(--bq,#f87171)}
.pf-aviso{background:color-mix(in srgb,var(--bl,#f4a72c) 20%,transparent);color:var(--bl,#f4a72c)}
:root[data-theme="light"] .pf-aviso{color:#92400e}
.pf-espera{background:color-mix(in srgb,var(--soft) 18%,transparent);color:var(--soft)}
.pf-pos{color:var(--bq,#f87171);font-weight:700} .pf-neg{color:var(--at,#34d399);font-weight:700}
.pf-rod{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:10px;font-size:13px;color:var(--soft)}
@media (max-width:640px){.pf-filtros label{flex:1 1 140px}}
`;

function montar(raiz, ctx){
  if(!document.getElementById("pf-css")){ const s = document.createElement("style"); s.id = "pf-css"; s.textContent = CSS; document.head.appendChild(s); }
  if(raiz.dataset.pf === "1"){ if(raiz._pfAtualizar) raiz._pfAtualizar(); return; }
  raiz.dataset.pf = "1";
  let dados = null, carregando = false;
  raiz.innerHTML = `
    <p class="sub">O que a Azure escolheu para cada pedido (frete simulado), os pedidos de teste e o frete real cobrado. Só leitura.</p>
    <div class="pf-filtros">
      <label>Período<select id="pf-dias"><option value="7">Últimos 7 dias</option><option value="30" selected>Últimos 30 dias</option><option value="90">Últimos 90 dias</option><option value="365">Último ano</option></select></label>
      <label>Tipo<select id="pf-teste"><option value="todos">Produção e teste</option><option value="nao">Só produção</option><option value="sim">Só teste</option></select></label>
      <label>Situação<select id="pf-sit"><option value="">Todas</option><option value="ok">Dentro do esperado</option><option value="divergente">Divergente</option><option value="aguardando_real">Aguardando real</option><option value="sem_chave">Sem chave da NF</option></select></label>
      <label>UF<input id="pf-uf" maxlength="2" placeholder="Ex.: SP" size="4"></label>
      <label>Transportadora<select id="pf-transp"><option value="">Todas</option></select></label>
      <label>Buscar<input id="pf-q" placeholder="Chave, cidade ou CEP"></label>
      <button class="btn pri" id="pf-ok" type="button">Atualizar</button>
      <button class="btn" id="pf-xls" type="button">⬇ Excel</button>
    </div>
    <div id="pf-faixa"></div><div class="pf-resumo" id="pf-resumo"></div>
    <div class="pf-tab" id="pf-tab"><div class="vazio">carregando…</div></div><div class="pf-rod" id="pf-rod"></div>`;
  const $ = s => raiz.querySelector(s);

  function consulta(){
    const dias = Number($("#pf-dias").value), desde = new Date(Date.now() - dias * 864e5).toISOString();
    const p = new URLSearchParams({ desde, teste: $("#pf-teste").value, limite: "500" });
    if($("#pf-sit").value) p.set("situacao", $("#pf-sit").value);
    if($("#pf-uf").value.trim()) p.set("uf", $("#pf-uf").value.trim());
    if($("#pf-transp").value) p.set("transportadora", $("#pf-transp").value);
    if($("#pf-q").value.trim()) p.set("q", $("#pf-q").value.trim());
    return "/v1/portal/pedidos?" + p.toString();
  }

  let pendente = false;   // filtro mudou durante uma busca: refaz ao terminar (senão a mudança se perde)
  async function atualizar(){
    if(carregando){ pendente = true; return; }
    carregando = true; pendente = false; $("#pf-ok").disabled = true; $("#pf-tab").innerHTML = '<div class="vazio">carregando…</div>';
    let erro = null;
    try{ dados = await ctx.api("GET", consulta()); }catch(e){ erro = e; }
    carregando = false; $("#pf-ok").disabled = false;
    if(pendente) return atualizar();
    if(erro) $("#pf-tab").innerHTML = '<div class="vazio">' + esc(ctx.msgErro(erro)) + "</div>"; else render();
  }
  raiz._pfAtualizar = atualizar;

  function render(){
    const d = dados, rs = d.resumo || {};
    let faixa = "";
    if(d.storage === false) faixa += '<div class="pf-aviso-faixa">A Azure ainda não está guardando os pedidos (armazenamento desligado). Nada para mostrar.</div>';
    else if(d.erro) faixa += '<div class="pf-aviso-faixa">' + esc(d.erro) + "</div>";
    if(d.storage !== false && d.tem_real === false) faixa += '<div class="pf-aviso-faixa">O frete real cobrado ainda não está disponível — só o simulado aparece.</div>';
    else if(d.storage !== false && rs.producao && !rs.com_real) faixa += '<div class="pf-aviso-faixa">Ainda não há frete real gravado para estes pedidos. O CT-e costuma chegar dias depois da NF.</div>';
    $("#pf-faixa").innerHTML = faixa;
    const dif = rs.diferenca, cls = dif > 0 ? "pf-pos" : dif < 0 ? "pf-neg" : "";
    $("#pf-resumo").innerHTML =
      `<div class="card"><div class="l">Pedidos</div><div class="n">${nf(rs.pedidos || 0, 0)}</div><div class="s">${nf(rs.producao || 0, 0)} produção · ${nf(rs.testes || 0, 0)} teste</div></div>` +
      `<div class="card"><div class="l">Frete simulado (produção)</div><div class="n">${R(rs.simulado_producao || 0)}</div><div class="s">sem imposto, como a Azure cotou</div></div>` +
      `<div class="card"><div class="l">Simulado × real</div><div class="n">${rs.com_real ? DIF(dif, rs.diferenca_pct) : "—"}</div><div class="s">${rs.com_real ? nf(rs.com_real, 0) + " pedidos com real · simulado " + R(rs.simulado_com_real) + " · real " + R(rs.real_comparavel) : "sem real ainda"}</div></div>` +
      `<div class="card"><div class="l">Atenção</div><div class="n">${nf((rs.divergentes || 0) + (rs.sem_chave || 0), 0)}</div><div class="s">${nf(rs.divergentes || 0, 0)} divergentes · ${nf(rs.sem_chave || 0, 0)} sem chave · ${nf(rs.aguardando_real || 0, 0)} aguardando real</div></div>`;
    // transportadoras do que veio (mantém a escolhida)
    const sel = $("#pf-transp"), atual = sel.value, nomes = [...new Set((d.pedidos || []).map(p => p.transportadora).filter(Boolean))].sort();
    if(nomes.length || !atual){ sel.innerHTML = '<option value="">Todas</option>' + nomes.map(n => `<option ${n === atual ? "selected" : ""}>${esc(n)}</option>`).join(""); if(atual && !nomes.includes(atual)) sel.insertAdjacentHTML("beforeend", `<option selected>${esc(atual)}</option>`); }
    if(!(d.pedidos || []).length){ $("#pf-tab").innerHTML = '<div class="vazio">Nenhum pedido neste filtro.</div>'; $("#pf-rod").textContent = ""; return; }
    $("#pf-tab").innerHTML = '<table><thead><tr><th>Data</th><th>NF</th><th>Destino</th><th class="num">Vol.</th><th class="num">Peso (kg)</th><th>Transportadora</th>' +
      '<th class="num">Simulado</th><th class="num">Real cobrado</th><th class="num">Diferença</th><th>Situação</th></tr></thead><tbody>' +
      d.pedidos.map(p => {
        const s = SITUACOES[p.situacao] || [p.situacao, "pf-espera"], c = p.diferenca > 0 ? "pf-pos" : p.diferenca < 0 ? "pf-neg" : "";
        const nfn = nfNum(p.chave_nf);
        return `<tr class="${p.teste ? "pf-t" : ""}"><td>${esc(dataBR(p.criado_em))}</td>` +
          `<td title="${esc(p.chave_nf || "sem chave")}">${nfn ? esc(nfn) : "—"}</td>` +
          `<td>${esc(p.cidade)}${p.uf ? " / " + esc(p.uf) : ""}</td><td class="num">${p.volumes || ""}</td><td class="num">${p.peso == null ? "" : nf(p.peso, 1)}</td>` +
          `<td>${esc(p.transportadora)}${p.transportadora_real && p.transportadora_real !== p.transportadora ? ' <span title="quem levou de fato">→ ' + esc(p.transportadora_real) + "</span>" : ""}</td>` +
          `<td class="num" title="${p.simulado_com_imposto ? "com imposto: " + R(p.simulado_com_imposto) : "sem imposto"}">${R(p.simulado)}</td>` +
          `<td class="num" title="${p.real_compartilhado ? "CT-e dividido entre várias NFs (valor rateado)" : ""}">${R(p.real)}${p.real_compartilhado ? " ⧉" : ""}</td>` +
          `<td class="num ${c}" title="${esc(BASE[p.base_comparacao] || "")}">${DIF(p.diferenca, p.diferenca_pct)}</td>` +
          `<td><span class="pf-badge ${s[1]}">${esc(s[0])}</span></td></tr>`;
      }).join("") + "</tbody></table>";
    $("#pf-rod").innerHTML = `<span>Mostrando ${nf(d.pedidos.length, 0)} de ${nf(d.total, 0)}${d.truncado ? " — refine os filtros para ver o restante" : ""}</span>` +
      `<span>Diferença = real − simulado, na mesma base de imposto. ⧉ = CT-e dividido entre NFs.</span>`;
  }

  function exportar(){
    if(!dados || !(dados.pedidos || []).length){ ctx.toast("Nada para exportar neste filtro.", { erro: true }); return; }
    const cab = ["Data", "Teste", "NF", "Chave", "UF", "Cidade", "Volumes", "Peso kg", "Transportadora", "Quem levou", "Simulado (sem imposto)", "Simulado (com imposto)", "Real cobrado", "Real comparável", "Diferença R$", "Diferença %", "Base", "Situação"];
    const linhas = dados.pedidos.map(p => [p.criado_em, p.teste ? "Sim" : "Não", nfNum(p.chave_nf), p.chave_nf, p.uf, p.cidade, p.volumes, p.peso, p.transportadora, p.transportadora_real,
      p.simulado, p.simulado_com_imposto, p.real, p.real_comparavel, p.diferenca, p.diferenca_pct, BASE[p.base_comparacao] || "", (SITUACOES[p.situacao] || [p.situacao])[0]]);
    if(typeof XLSX !== "undefined"){
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([cab].concat(linhas)), "Pedidos e fretes");
      XLSX.writeFile(wb, "pedidos-e-fretes.xlsx"); return;
    }
    const csv = [cab].concat(linhas).map(l => l.map(v => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"').join(";")).join("\r\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" })); a.download = "pedidos-e-fretes.csv"; a.click();
  }

  $("#pf-ok").onclick = atualizar; $("#pf-xls").onclick = exportar;
  raiz.querySelectorAll("select").forEach(s => s.addEventListener("change", atualizar));
  raiz.querySelectorAll("input").forEach(i => i.addEventListener("keydown", e => { if(e.key === "Enter") atualizar(); }));
  atualizar();
}
window.PedidosFretes = { montar };
})();
