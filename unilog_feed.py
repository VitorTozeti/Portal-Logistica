"""
unilog_feed.py — estado de ENVIO das NFs que o robô de expedição manda à UNILOG.

Fonte: o arquivo de estado do robô de saída (`unilog/estado_saida_{AMBIENTE}.json` do
`logistica_pharma`, gravado por `unilog/saida_estado.py`): NF+filial -> requestId,
`status_code`, `status_desde`, `etapa` e os alertas do robô. 100% LEITURA — o arquivo é
aberto só para leitura, sem pegar o `.lock` do robô (o robô troca o arquivo inteiro via
`.json.tmp` + `os.replace`, então a leitura vê sempre uma versão completa).

Liga só quando `PORTAL_UNILOG_ESTADO` aponta para o JSON. Sem a variável o portal fica
igual ao modo B4You (nenhuma NF é tratada como Unilog).

A decisão B4You × Unilog é POR NF: NF que está no estado do robô é da Unilog (a família
`Envio_B4You_*` do log mestre fica PENDENTE para ela e não pode virar alerta); o resto
segue a regra da B4You. Isso cobre o período misto da virada sem flag.

Situações da Unilog (as do robô, já traduzidas de nome para código):
1 PENDING · 2 INTEGRATED · 3 PENDING_CONFIRMATION · 4 CONFIRMED ·
5 INTEGRATED_WITH_ERRORS · 21 CANCELLED · 22 SHIPPED (embarcado — fim do ciclo).
"""
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import alertas_texto   # categoria, frase e "o que fazer" de cada alerta -- os mesmos do e-mail de pendencias

ESTADO = os.getenv("PORTAL_UNILOG_ESTADO", "").strip()
# Pedido parado na mesma situação há mais que isto vira travada (mesmo default do robô).
HORAS_PARADO = float(os.getenv("PORTAL_UNILOG_HORAS_PARADO", os.getenv("UNILOG_HORAS_PARADO", "168")))
# Só para estado sem a seção `ciclo` (robô de antes de 11/11): alerta ativo se repetido até X horas antes da última
# gravação do arquivo. Com a seção, vale o último ciclo (_corte_alertas).
HORAS_ALERTA = float(os.getenv("PORTAL_UNILOG_HORAS_ALERTA", "3"))
# Arquivo sem gravação há mais que isto = robô parado (o robô roda em dias úteis, 08–14h).
HORAS_ARQUIVO_VELHO = float(os.getenv("PORTAL_UNILOG_HORAS_ARQUIVO", "72"))

STATUS = {
    "1": "PENDING", "2": "INTEGRATED", "3": "PENDING_CONFIRMATION", "4": "CONFIRMED",
    "5": "INTEGRATED_WITH_ERRORS", "21": "CANCELLED", "22": "SHIPPED",
}

# tipo de alerta do robô -> categoria do portal: alertas_texto.categoria (11/11/2026: sem a categoria "UNILOG" -- tudo é
# Unilog desde a virada; a categoria diz o assunto e quem age, igual ao e-mail)
# Estes continuam valendo com a NF em status final (21 ou 22): pedem ação de alguém mesmo sem o robô ler a Unilog.
_ALERTAS_DEPOIS_DO_FIM = {"CANCELAMENTO_MANUAL_PENDENTE", "NF_CANCELADA_SAP", "CANCELADA_SO_NA_UNILOG",
                          "ENTRADA_DE_NF_CANCELADA"}

_cache = {"mtime": None, "dados": None}


def ligado() -> bool:
    return bool(ESTADO)


def _iso(ts) -> str | None:
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(str(ts))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.astimezone()  # o robô grava hora local sem fuso
    return dt.astimezone(timezone.utc).isoformat()


def _horas_desde(ts, agora: float) -> float | None:
    iso = _iso(ts)
    if not iso:
        return None
    return (agora - datetime.fromisoformat(iso).timestamp()) / 3600


def _ler():
    """(dados, mtime) do JSON, ou (None, None) se não existe/não lê. Cache pelo mtime."""
    p = Path(ESTADO)
    try:
        mtime = p.stat().st_mtime
    except OSError:
        return None, None
    if _cache["mtime"] == mtime:
        return _cache["dados"], mtime
    try:
        dados = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        print(f"  [UNILOG_FEED] erro lendo {p}: {e}", flush=True)
        return None, None
    _cache.update(mtime=mtime, dados=dados)
    return dados, mtime


def _limpar(nf) -> str:
    try:
        return str(int(str(nf).strip()))
    except ValueError:
        return str(nf or "").strip().lstrip("0")


def nfs_unilog() -> dict:
    """{filial: {nf_limpo}} das NFs que o robô mandou (ou tentou mandar) à Unilog."""
    if not ligado():
        return {}
    dados, _ = _ler()
    out: dict = {}
    for reg in (dados or {}).get("nfs", {}).values():
        out.setdefault(reg.get("filial"), set()).add(_limpar(reg.get("serial")))
    return out


# nome que a logística entende para cada situação (o robô guarda o nome da Unilog em status_desc)
NOME_SITUACAO = alertas_texto.NOME_SITUACAO


# Etapa da Unilog (nome que ela manda em status_desc) -> nome que a logística entende. É o que o Portal mostra
# no selo da NF e nas colunas do "Detalhar". A ordem do fluxo fica no monitor.html (FLUXO_UNILOG).
ETAPA_SIMPLES = {
    "": "Enviada à Unilog",
    "IMPORTADO": "Pedido recebido", "CRIADO": "Pedido recebido",
    "AGUARDANDO_PRODUCAO": "Na fila de separação",
    "EM_PRODUCAO_ONDA": "Em separação",
    "PEDIDO_SEM_SALDO": "Sem estoque na Unilog",
    "CHECK_OUT_FINALIZADO": "Separação conferida",
    "AGUARDANDO_ROTEIRIZACAO": "Aguardando rota", "REIMPRESSAO_ETIQUETA": "Aguardando rota",
    "AGUARDANDO_EMBARQUE": "Pronto para coleta",
    "EMBARCADO": "Embarcada", "CANCELADO": "Cancelada",
}


def etapa_simples(code, desc) -> str:
    """Nome simples da etapa. `desc` é o nome da Unilog (ex.: AGUARDANDO_PRODUCAO; no embarque pela planilha vem
    "EMBARCADO (planilha da Unilog)"). Sem nome conhecido cai na situação pelo código; nunca devolve vazio."""
    d = str(desc or "").strip().upper()
    if d.startswith("EMBARCADO"):
        d = "EMBARCADO"
    if d and d in ETAPA_SIMPLES:
        return ETAPA_SIMPLES[d]
    code = str(code or "")
    if not code:
        return str(desc or "").strip() or ETAPA_SIMPLES[""]
    return NOME_SITUACAO.get(code, str(desc or code))


def situacoes() -> dict:
    """{filial: {nf_limpo: {...}}} com a situação atual de cada NF na Unilog e o histórico
    de etapas (para o card e o painel de detalhe das notas que subiram)."""
    if not ligado():
        return {}
    dados, _ = _ler()
    out: dict = {}
    for reg in (dados or {}).get("nfs", {}).values():
        code = str(reg.get("status_code") or "")
        if reg.get("etapa") == "RECUSADO":
            nome = "Cancelada no SAP" if reg.get("cancelada_sap") else "Recusada"
        else:
            nome = etapa_simples(code, reg.get("status_desc"))
        hist = [{"em": _iso(h.get("ts")), "evento": str(h.get("evento") or "")}
                for h in reg.get("historico") or [] if h.get("ts")]
        out.setdefault(reg.get("filial"), {})[_limpar(reg.get("serial"))] = {
            "code": code, "nome": nome, "desde": _iso(reg.get("status_desde")),
            "request_id": reg.get("request_id") or "", "historico": hist[-15:],
        }
    return out


def _ev(filial, nf, cod, cat, desc, desde):
    return {
        "nf": nf, "filial": filial, "estado": "travada", "transportadora": "Unilog",
        "problema_codigo": cod, "problema_categoria": cat, "problema_descricao": desc,
        "travada_desde": _iso(desde), "grupo": "UNILOG", "operador": "Unilog",
    }


def _corte_alertas(dados, mtime) -> float:
    """Desde quando um alerta conta como ativo (timestamp). Igual ao e-mail: o que o robô repetiu no último ciclo.

    Até 11/11/2026 era uma janela fixa de 3 h: o aviso de algo já resolvido ficava até 3 h no Portal (as entradas da
    Matriz enviadas às 19:05 seguiam como pendentes). Ciclo inteiro e sem falha -> início dele; ciclo em andamento,
    interrompido ou com etapa sem Unilog/SAP -> início do último ciclo inteiro (`anterior`), para o alerta não sumir
    e voltar; sem marca de ciclo (estado antigo) -> a janela de HORAS_ALERTA."""
    c = dados.get("ciclo") or {}
    inicio = c.get("inicio") if c.get("fim") and not c.get("parcial") else c.get("anterior")
    iso = _iso(inicio)
    if iso:
        return datetime.fromisoformat(iso).timestamp()
    return mtime - HORAS_ALERTA * 3600


def coletar_unilog() -> list:
    """Travadas de envio na Unilog, no formato do hub. Uma por NF (a 1ª causa vira o código)."""
    if not ligado():
        return []
    agora = time.time()
    dados, mtime = _ler()
    if dados is None:
        return [_ev("Unilog", "ESTADO", "UNILOG_SEM_ESTADO", alertas_texto.categoria("SEM_ESTADO"),
                    alertas_texto.descricao([("SEM_ESTADO", [(f"arquivo {ESTADO} não encontrado ou ilegível", "")])]),
                    None)]

    por_nf: dict = {}

    def add(filial, nf, cod, tipo, mensagem, desde, detalhe=""):
        """Uma travada por NF: a 1ª causa dá o código e a categoria; cada tipo vira um bloco do texto (alertas_texto:
        o que aconteceu, um tópico por item, o que fazer). O texto é montado no fim, com todos os alertas da NF."""
        k = (filial, nf)
        if k not in por_nf:
            por_nf[k] = {"ev": _ev(filial, nf, cod, alertas_texto.categoria(tipo, detalhe), "", desde), "blocos": {}}
        bloco = por_nf[k]["blocos"].setdefault(alertas_texto.canonico(tipo), (tipo, []))
        if (mensagem, detalhe) not in bloco[1]:
            bloco[1].append((mensagem, detalhe))

    finais = set()
    faturadas = set()      # billing OK: o alerta de arquivo faltando para a fatura ja foi resolvido
    # "Ignorar no robo" do Portal (secao `ignoradas` do estado): sai da lista na hora
    ignoradas = {(i.get("filial"), _limpar(i.get("serial"))) for i in (dados.get("ignoradas") or {}).values()}
    # entrada da Matriz ja enviada: o aviso ENTRADA_MATRIZ_PENDENTE do ciclo anterior ficava ate 3 h (49671, 11/11)
    matriz_enviada = {(r.get("filial"), _limpar(r.get("nf"))) for r in (dados.get("entradas_matriz") or {}).values()
                      if r.get("request_id")}
    for reg in dados.get("nfs", {}).values():
        filial, nf = reg.get("filial"), _limpar(reg.get("serial"))
        if (filial, nf) in ignoradas:
            continue
        if (reg.get("billing") or {}).get("ok"):
            faturadas.add((filial, nf))
        code = str(reg.get("status_code") or "")
        etapa = str(reg.get("etapa") or "")
        desde = reg.get("status_desde") or reg.get("enviado_em")
        if code in ("21", "22"):
            finais.add((filial, nf))
            continue
        if etapa == "RECUSADO" and reg.get("cancelada_sap"):    # o pedido nao nasceu e a NF foi cancelada no SAP
            finais.add((filial, nf))
            continue
        if etapa == "RECUSADO":
            add(filial, nf, "UNILOG_RECUSADO", "RECUSADO", str(reg.get("erro") or ""), reg.get("enviado_em"))
        elif etapa == "POST_INCERTO":
            add(filial, nf, "UNILOG_POST_INCERTO", "POST_INCERTO", "", reg.get("enviado_em"))
        elif code == "5":
            add(filial, nf, "UNILOG_ERRO_INTEGRACAO", "ERRO_INTEGRACAO",
                f"situação 5 na Unilog ({reg.get('status_desc') or STATUS['5']})", desde)
        else:
            h = _horas_desde(desde, agora)
            if h is not None and h >= HORAS_PARADO:
                nome = etapa_simples(code, reg.get("status_desc"))
                cod, tipo = ("UNILOG_AGUARDA_EMBARQUE", "AGUARDA_EMBARQUE") if code in ("3", "4") else ("UNILOG_PARADO", "PARADO")
                add(filial, nf, cod, tipo, f'Na etapa "{nome}" há {h:.0f}h', desde)

    # alertas que o robô repetiu no último ciclo (os antigos já foram resolvidos)
    corte = _corte_alertas(dados, mtime)
    for a in dados.get("alertas", {}).values():
        visto = _iso(a.get("ultimo"))
        if not visto or datetime.fromisoformat(visto).timestamp() < corte:
            continue
        filial, nf = a.get("filial"), _limpar(a.get("serial"))
        if (filial, nf) in finais and a.get("tipo") not in _ALERTAS_DEPOIS_DO_FIM:
            continue
        if (filial, nf) in ignoradas:
            continue
        tipo = str(a.get("tipo") or "")
        if tipo == "ENTRADA_MATRIZ_PENDENTE" and (filial, nf) in matriz_enviada:
            continue
        # 11/11/2026: a fatura subiu depois do ultimo aviso -- sem isto a NF ficava ate 3 h no Portal (47 de uma vez),
        # enquanto o e-mail (alertas do ciclo) ja nao a mostrava
        if tipo == "BILLING_SEM_ARQUIVO" and (filial, nf) in faturadas:
            continue
        # categoria pelo tipo (BILLING_SEM_ARQUIVO: detalhe = o que falta no share; só boleto = Financeiro)
        add(filial, nf, f"UNILOG_{tipo}", tipo, str(a.get("mensagem") or ""), a.get("primeiro"), str(a.get("detalhe") or ""))

    out = []
    for item in por_nf.values():
        item["ev"]["problema_descricao"] = alertas_texto.descricao(list(item["blocos"].values()))
        out.append(item["ev"])
    idade_h = (agora - mtime) / 3600
    if idade_h >= HORAS_ARQUIVO_VELHO:
        out.append(_ev("Unilog", "ESTADO", "UNILOG_ESTADO_VELHO", alertas_texto.categoria("ESTADO_VELHO"),
                       alertas_texto.descricao([("ESTADO_VELHO", [(f"sem gravar o estado há {idade_h:.0f}h", "")])]),
                       datetime.fromtimestamp(mtime).isoformat(timespec="seconds")))
    return out
