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
const igual = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-9;

const CSS = `
.bm{--bm-verde:var(--at,#059669)}
.bm-topo h3{margin:0 0 4px;font-size:16px}
.bm-esq{position:sticky;top:12px;display:grid;gap:8px;min-inline-size:0}
.bm-esq .ufs{position:static;max-height:calc(100dvh - 300px);min-height:260px}
.bm-esq input[type=search]{inline-size:100%;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;font-size:13.5px}
.bm-esq input[type=search]:focus-visible{outline:2px solid var(--brand);outline-offset:1px}
.bm-vazio-uf{padding:14px 12px;color:var(--soft);font-size:13px}
.bm-cabuf{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:baseline;margin:0 0 10px}
.bm-cabuf h3{margin:0;font-size:20px} .bm-cabuf .bm-info{font-size:12.5px}
.bm-info,.bm-mudo{color:var(--soft);font-size:12.5px}
.bm-card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin:0 0 14px}
.bm-card h4{margin:0 0 4px;font-size:15px;color:var(--brand)}
.bm-esc{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:10px 0}
.bm-esc .bm-atual{font-size:13px}
.bm-esc .bm-atual b{color:var(--bm-verde)}
.bm-tab{overflow-x:auto;border:1px solid var(--line);border-radius:10px;margin:8px 0 6px}
.bm-tab table{inline-size:100%;border-collapse:collapse;min-inline-size:660px;font-size:12.5px}
.bm-tab th,.bm-tab td{text-align:right;white-space:nowrap;padding:8px 10px;border-bottom:1px solid var(--line)}
.bm-tab th{color:var(--soft);font-size:12px;font-weight:600}
.bm-tab th:first-child,.bm-tab td:first-child{text-align:left}
.bm-tab tbody tr{cursor:pointer}
.bm-tab tbody tr:hover{background:color-mix(in srgb,var(--bm-verde) 7%,transparent)}
.bm-tab tbody tr:last-child td{border-bottom:0}
.bm-tab td:first-child label{display:inline-flex;gap:8px;align-items:center;cursor:pointer;font-weight:700}
.bm-tab input[type=radio]{accent-color:var(--bm-verde);inline-size:16px;block-size:16px;margin:0;cursor:pointer}
.bm-tab input[type=radio]:focus-visible{outline:2px solid var(--bm-verde);outline-offset:2px}
.bm-tab tr.bm-sel{background:color-mix(in srgb,var(--bm-verde) 20%,transparent);box-shadow:inset 4px 0 0 var(--bm-verde)}
.bm-tab tr.bm-sel td{border-bottom-color:color-mix(in srgb,var(--bm-verde) 40%,transparent)}
.bm-tab tr.bm-sel td:first-child label{color:var(--bm-verde)}
.bm-tab tr.bm-sel td:first-child label::after{content:"✓ escolhida";font-size:11px;font-weight:700;margin-left:4px}
.bm-tab tr.bm-estr:not(.bm-rec) td:first-child label span::after{content:" ★";color:var(--alerta)}
.bm-tab tr.bm-rec td{border-bottom:2px solid var(--line)}
.bm-tab tr.bm-rec td:first-child label span{white-space:nowrap}
.bm-tab tr.bm-rec .bm-sub{display:block;font-size:11px;font-weight:400;color:var(--soft)}
.bm-tab tr.bm-rec.bm-sel .bm-sub{color:var(--ink)}
.bm-pos{color:var(--at)} .bm-neg{color:var(--bq)}
.bm-tab td.bm-mix{white-space:normal;text-align:left;min-width:160px;font-size:11.5px;color:var(--soft)}
.bm-tag{display:inline-block;font-size:11px;font-weight:700;border-radius:20px;padding:1px 9px;background:color-mix(in srgb,var(--bq) 18%,transparent);color:var(--bq)}
.bm-bar{position:sticky;bottom:0;z-index:20;background:var(--card);border:2px solid var(--brand);border-radius:12px;padding:12px 16px;
  display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:6px 0 18px}
.bm-bar[hidden]{display:none}
.bm-st{flex:1;min-width:220px;font-size:13.5px;line-height:1.45} .bm-r{color:var(--bl)}
.bm-bar input{background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:8px 10px;min-width:260px}
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
    '<div class="bm"><p class="sub bm-topo">Cada estado tem três regras: <b>Capital</b>, <b>Interior</b> e <b>Distribuidor</b> (cliente distribuidor, em qualquer cidade). ' +
    'A banda diz até quantos dias úteis a mais que a transportadora mais rápida a escolha aceita em troca de frete mais barato. ' +
    '<b>Clique na linha</b> para escolher: a escolhida fica <b style="color:var(--at)">verde</b>. Sem banda salva, a API usa a <b>★ Recomendada</b> (1ª linha).</p>' +
    '<div class="aviso" id="bm-aviso" hidden></div>' +
    '<div class="exp"><div class="bm-esq"><input type="search" id="bm-q" placeholder="Filtrar estado…" aria-label="Filtrar estado por nome ou sigla">' +
    '<div class="ufs" id="bm-ufs" role="listbox" aria-label="Estados"></div></div>' +
    '<div class="painel-uf" id="bm-painel"><div class="vazio">carregando…</div></div></div>' +
    '<div class="bm-bar" id="bm-bar" hidden><div class="bm-st" id="bm-st" aria-live="polite"></div>' +
    '<input type="text" id="bm-motivo" placeholder="Motivo da alteração (obrigatório, mín. 10 letras)" aria-label="Motivo">' +
    '<button type="button" class="btn" id="bm-desfazer">Desfazer</button>' +
    '<button type="button" class="btn pri" id="bm-salvar" disabled>Salvar</button></div></div>';

  let est = null, base = new Map(), des = new Map(), uf = "SP", cache = {}, vez = 0, q = "";
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
    const aq = est.modo_sem_banda === "ponderada"
      ? "Atenção: a reserva <b>ESCOLHA_SEM_BANDA=ponderada</b> está ligada na Azure — regra sem banda salva usa o método antigo, não a recomendada. " : "";
    let d;
    try{ d = await impacto(uf); }
    catch(e){ aviso(aq); $("#bm-painel").innerHTML = '<div class="aviso">Não consegui carregar ' + esc(nomeUF(uf)) + ". " + esc(msgErro(e)) + "</div>"; return; }
    aviso(aq + (d.desatualizado ? "Há bloqueio de transportadora em " + esc(uf) + " e a planilha não considera bloqueio: os números abaixo podem estar desatualizados." : ""));
    let h = '<select class="uf-mob" id="bm-mob" aria-label="Estado">' + est.ufs.map(u => '<option value="' + u + '"' + (u === uf ? " selected" : "") + ">" + esc(nomeUF(u)) + "</option>").join("") + "</select>";
    h += '<div class="bm-cabuf"><h3>' + esc(nomeUF(uf)) + '</h3><span class="bm-info">' + (d.fonte === "recalculo" ? "Números recalculados com a cobertura atual." : "Números da planilha de 23/10 (jan–set/2026, calculada sem bloqueios).") + "</span></div>";
    h += SEG.map(([s, nome, desc]) => cardRegra(d, s, nome, desc)).join("");
    $("#bm-painel").innerHTML = h;
    const mob = $("#bm-mob"); if(mob) mob.onchange = () => { uf = mob.value; desenhar(); };
    for(const [s] of SEG){
      raiz.querySelectorAll('input[name="bm-' + s + '"]').forEach(r => r.onchange = () => escolher(s, r.value === "" ? null : Number(r.value)));
      // clicar em qualquer ponto da linha escolhe a banda dela
      raiz.querySelectorAll('tr[data-seg="' + s + '"]').forEach(tr => tr.onclick = ev => {
        if(ev.target.closest("input,label")) return;          // o próprio radio/label já tratam
        escolher(s, tr.dataset.b === "" ? null : Number(tr.dataset.b));
      });
    }
    barra();
  }
  $("#bm-q").oninput = e => { q = e.target.value; desenharLista(); };
  function escolher(s, b){
    des.set(chave(uf, s), b);
    desenhar().then(() => { const r = raiz.querySelector('input[name="bm-' + s + '"][value="' + (b == null ? "" : b) + '"]'); if(r) r.focus(); });
  }

  function cardRegra(d, s, nome, desc){
    const quadro = d.segmentos[s], salva = desejado(uf, s), pad = padraoDe(uf, s);
    let h = '<section class="bm-card"><h4>' + nome + ' <span class="bm-mudo">· ' + esc(desc) + "</span></h4>";
    const rotEf = salva != null ? "+" + fmtB(salva) + " d (banda salva)" : (pad > 0 ? "★ Recomendada +" + fmtB(pad) + " d (padrão)" : "★ Recomendada: só a mais rápida (padrão)");
    if(!quadro){
      return h + '<p class="bm-mudo">Sem pedidos desta regra em ' + esc(nomeUF(uf)) + ' na base: não há como medir o impacto de uma banda aqui.</p>' +
        '<div class="bm-esc"><span class="bm-atual">Escolhida: <b>' + esc(rotEf) + "</b></span></div></section>";
    }
    const h0 = quadro.hoje;
    h += '<p class="bm-mudo">Hoje: ' + h0.pedidos + " pedidos · frete " + fmtR(h0.frete) + " · prazo realizado " + fmtB(h0.prazo_real) +
         " d úteis" + (quadro.poucos ? ' · <span class="bm-tag">poucos pedidos: use com cautela</span>' : "") + "</p>";
    h += '<div class="bm-esc"><span class="bm-atual">Escolhida: <b>' + esc(rotEf) + "</b></span></div>";
    h += '<div class="bm-tab"><table><caption class="bm-mudo" style="text-align:left;padding:6px 10px">Clique na linha para escolher a banda de ' + nome + " em " + esc(nomeUF(uf)) + "</caption>" +
         '<thead><tr><th scope="col">Banda</th><th scope="col">Economia</th><th scope="col">R$ (9 meses)</th><th scope="col">Prazo médio</th><th scope="col">Δ prazo vs hoje</th><th scope="col">Prazo prometido</th><th scope="col">Mix de transportadoras</th></tr></thead><tbody>';
    // 1ª linha: ★ Recomendada (padrão) = nenhuma banda salva; mostra os números da banda recomendada
    const lr = pad > 0 ? quadro.bandas.find(x => igual(x.banda, pad)) : null;
    const col = b => '<td class="' + (b.economia_rs >= 0 ? "bm-pos" : "bm-neg") + '">' + fmtP(b.economia_pct) + "</td>" +
           '<td class="' + (b.economia_rs >= 0 ? "bm-pos" : "bm-neg") + '">' + fmtR(b.economia_rs) + "</td>" +
           "<td>" + fmtB(b.prazo) + " d</td>" +
           '<td class="' + (b.delta_prazo > 1e-9 ? "bm-neg" : "bm-pos") + '">' + fmtD(b.delta_prazo) + "</td>" +
           "<td>" + fmtB(b.prazo_prometido) + " d</td>";
    const mixDe = b => Object.entries(b.mix).filter(([, v]) => v >= 0.005).sort((a, c) => c[1] - a[1]).map(([t, v]) => esc(t) + " " + fmtP(v)).join(" · ");
    h += '<tr data-seg="' + s + '" data-b="" class="bm-rec' + (salva == null ? " bm-sel" : "") + '"><td><label><input type="radio" name="bm-' + s + '" value=""' + (salva == null ? " checked" : "") +
         '><span>★ Recomendada<span class="bm-sub">' + (pad > 0 ? "+" + fmtB(pad) + " d · padrão da API" : "só a mais rápida · padrão da API") + "</span></span></label></td>" +
         (lr ? col(lr) + '<td class="bm-mix">' + mixDe(lr) + "</td>" : '<td colspan="6" style="text-align:left;color:var(--soft)">' + (pad > 0 ? "Sem números para esta banda." : "Nenhuma banda economiza sem piorar o prazo aqui: usa só a transportadora mais rápida.") + "</td>") + "</tr>";
    for(const b of quadro.bandas){
      const sel = igual(salva, b.banda);
      h += '<tr data-seg="' + s + '" data-b="' + b.banda + '" class="' + (sel ? "bm-sel " : "") + (igual(pad, b.banda) ? "bm-estr" : "") + '">' +
           '<td><label><input type="radio" name="bm-' + s + '" value="' + b.banda + '"' + (sel ? " checked" : "") + "><span>+" + fmtB(b.banda) + " d</span></label></td>" +
           col(b) + '<td class="bm-mix">' + mixDe(b) + "</td></tr>";
    }
    return h + '</tbody></table></div><p class="bm-mudo">★ = banda recomendada: maior economia sem aumentar o prazo. Economia contra quem levou de fato em jan–set/2026. Escolher a linha ★ Recomendada remove a banda salva e volta ao padrão.</p></section>';
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
