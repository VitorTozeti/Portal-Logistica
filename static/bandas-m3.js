/* Banda do M3 — editor montado dentro de "Regras da escolha" (custo.html).
   Uso: BandasM3.montar(elementoRaiz, { api, toast, msgErro })
     api(metodo, caminho, corpo) -> Promise (já com login Firebase), toast(msg, {erro}), msgErro(e) -> texto.
   Rotas da Azure (mesmo login do Custo de Frete): GET /v1/cobertura/banda, GET .../banda/impacto?uf=,
   POST .../banda/validar, PUT .../banda. Regras do motor em banda.py / escolha.py (Azure). */
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
let montado = false;

function montar(raiz, ctx){
  if(montado) return;
  montado = true;
  const { api, toast, msgErro } = ctx;
  const $ = s => raiz.querySelector(s);
  raiz.innerHTML =
    '<div class="bm-topo"><h3>Banda do M3 por estado</h3>' +
    '<p class="sub">Para cada estado há três regras: <b>Capital</b> (pedido para a capital), <b>Interior</b> (demais cidades) e ' +
    '<b>Distribuidor</b> (cliente distribuidor, em qualquer cidade). A banda diz até quantos dias úteis a mais que a transportadora ' +
    'mais rápida a escolha aceita em troca de frete mais barato. <b>Sem banda cadastrada, vale a Ponderada</b> (mais abaixo).</p></div>' +
    '<div class="aviso" id="bm-aviso" hidden></div>' +
    '<div class="bm-uf"><label for="bm-uf"><b>Estado</b></label><select id="bm-uf"></select><span class="bm-info" id="bm-info"></span></div>' +
    '<div id="bm-regras"><div class="vazio">carregando…</div></div>' +
    '<div class="bm-bar" id="bm-bar" hidden><div class="bm-st" id="bm-st"></div>' +
    '<input type="text" id="bm-motivo" placeholder="Motivo da alteração (obrigatório, mín. 10 letras)" aria-label="Motivo">' +
    '<button type="button" class="btn" id="bm-desfazer">Desfazer</button>' +
    '<button type="button" class="btn pri" id="bm-salvar" disabled>Salvar</button></div>';

  let est = null, base = new Map(), des = new Map(), uf = "SP", cache = {}, vez = 0;
  const chave = (u, s) => u + "|" + s;
  const salvo = (u, s) => { const b = base.get(chave(u, s)); return b === undefined ? null : b; };
  const desejado = (u, s) => { const k = chave(u, s); return des.has(k) ? des.get(k) : salvo(u, s); };
  const pendentes = () => [...des.keys()].filter(k => (des.get(k) ?? null) !== (base.get(k) ?? null));
  const aviso = html => { const a = $("#bm-aviso"); a.hidden = !html; a.innerHTML = html || ""; };
  function itens(){
    const out = [];
    for(const u of est.ufs) for(const [s] of SEG){ const b = desejado(u, s); if(b !== null && b !== undefined) out.push({ uf: u, segmento: s, banda: b, motivo: "" }); }
    return out;
  }

  async function carregarEstado(){
    est = await api("GET", "/v1/cobertura/banda");
    base = new Map(); for(const r of est.regras) base.set(chave(r.uf, r.segmento), r.banda);
    des = new Map();
    const sel = $("#bm-uf");
    if(!sel.options.length){
      sel.innerHTML = est.ufs.map(u => '<option value="' + u + '">' + u + "</option>").join("");
      sel.onchange = () => { uf = sel.value; desenhar(); };
    }
    sel.value = uf;
    await desenhar();
  }
  const limparCache = () => { cache = {}; };
  async function impacto(u){ if(!cache[u]) cache[u] = await api("GET", "/v1/cobertura/banda/impacto?uf=" + encodeURIComponent(u)); return cache[u]; }

  async function desenhar(){
    const q = await impacto(uf);
    $("#bm-info").textContent = q.fonte === "recalculo" ? "Números recalculados com a cobertura atual." : "Números da planilha de 23/10 (calculada sem bloqueios).";
    aviso(q.desatualizado ? "Há bloqueio de transportadora em " + esc(uf) + " e a planilha não considera bloqueio: os números abaixo podem estar desatualizados." : "");
    $("#bm-regras").innerHTML = SEG.map(([s, nome, desc]) => cardRegra(q, s, nome, desc)).join("");
    for(const [s] of SEG){
      const sel = raiz.querySelector('select[data-banda="' + s + '"]');
      if(sel) sel.onchange = () => { des.set(chave(uf, s), sel.value === "" ? null : Number(sel.value)); desenhar(); };
      const btn = raiz.querySelector('button[data-usar="' + s + '"]');
      if(btn) btn.onclick = () => { des.set(chave(uf, s), Number(btn.dataset.v)); desenhar(); };
    }
    barra();
  }

  function cardRegra(q, s, nome, desc){
    const quadro = q.segmentos[s], d = desejado(uf, s), sug = quadro ? quadro.sugestao : null;
    let h = '<section class="bm-card"><h4>' + nome + ' <span class="bm-mudo">· ' + esc(desc) + "</span></h4>";
    if(!quadro) return h + '<p class="bm-mudo">Sem pedidos desta regra em ' + esc(uf) + ' na base: não há como medir o impacto de uma banda aqui.</p></section>';
    const h0 = quadro.hoje;
    h += '<p class="bm-mudo">Hoje: ' + h0.pedidos + " pedidos · frete " + fmtR(h0.frete) + " · prazo realizado " + fmtB(h0.prazo_real) +
         " d úteis" + (quadro.poucos ? ' · <span class="bm-tag">poucos pedidos: use com cautela</span>' : "") + "</p>";
    h += '<div class="bm-esc"><label><b>Banda escolhida</b> <select data-banda="' + s + '"><option value="">Sem banda (usa a Ponderada)</option>' +
         quadro.bandas.map(b => '<option value="' + b.banda + '"' + (d != null && Math.abs(d - b.banda) < 1e-9 ? " selected" : "") + ">+" + fmtB(b.banda) + " d</option>").join("") + "</select></label>";
    if(sug != null) h += ' <button type="button" class="btn" data-usar="' + s + '" data-v="' + sug + '">Usar ★ +' + fmtB(sug) + " d</button>";
    h += '</div><div class="bm-tab"><table class="lt"><thead><tr><th>Banda</th><th>Economia</th><th>R$ (9 meses)</th><th>Prazo médio</th><th>Δ prazo vs hoje</th><th>Prazo prometido</th><th>Mix de transportadoras</th></tr></thead><tbody>';
    for(const b of quadro.bandas){
      const sel = d != null && Math.abs(d - b.banda) < 1e-9, estr = sug != null && Math.abs(sug - b.banda) < 1e-9;
      const mix = Object.entries(b.mix).filter(([, v]) => v >= 0.005).sort((a, c) => c[1] - a[1]).map(([t, v]) => esc(t) + " " + fmtP(v)).join(" · ");
      h += '<tr class="' + (sel ? "bm-sel " : "") + (estr ? "bm-estr" : "") + '"><td>+' + fmtB(b.banda) + " d</td>" +
           '<td class="' + (b.economia_rs >= 0 ? "bm-pos" : "bm-neg") + '">' + fmtP(b.economia_pct) + "</td>" +
           '<td class="' + (b.economia_rs >= 0 ? "bm-pos" : "bm-neg") + '">' + fmtR(b.economia_rs) + "</td>" +
           "<td>" + fmtB(b.prazo) + " d</td>" +
           '<td class="' + (b.delta_prazo > 1e-9 ? "bm-neg" : "bm-pos") + '">' + fmtD(b.delta_prazo) + "</td>" +
           "<td>" + fmtB(b.prazo_prometido) + ' d</td><td class="bm-mix">' + mix + "</td></tr>";
    }
    return h + '</tbody></table></div><p class="bm-mudo">★ = maior economia sem aumentar o prazo (— se nenhuma banda faz isso). Economia contra quem levou de fato em jan–set/2026.</p></section>';
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
    if(motivo.length < 10){ toast("Escreva o motivo (pelo menos 10 letras).", { erro: true }); return; }
    try{
      const r = await api("PUT", "/v1/cobertura/banda", { regras: itens(), base_versao: est.versao, motivo });
      toast("Bandas salvas (" + (r.mudancas || []).length + " mudança(s)).");
      limparCache(); $("#bm-motivo").value = ""; await carregarEstado();
    }catch(e){
      if(e.status === 409){ toast("As bandas mudaram enquanto você editava. Recarreguei.", { erro: true }); limparCache(); await carregarEstado(); }
      else toast(msgErro(e), { erro: true });
    }
  }
  $("#bm-desfazer").onclick = () => { des = new Map(); desenhar(); };
  $("#bm-salvar").onclick = salvar;

  carregarEstado().catch(e => {
    montado = false;
    $("#bm-regras").innerHTML = '<div class="aviso">Não consegui carregar as bandas agora. ' + esc(msgErro(e)) + ' <button type="button" class="btn" id="bm-tentar">Tentar de novo</button></div>';
    const t = $("#bm-tentar"); if(t) t.onclick = () => montar(raiz, ctx);
  });
}

window.BandasM3 = { montar, pendentes: () => 0 };
})();
