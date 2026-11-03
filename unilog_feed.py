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

ESTADO = os.getenv("PORTAL_UNILOG_ESTADO", "").strip()
# Pedido parado na mesma situação há mais que isto vira travada (mesmo default do robô).
HORAS_PARADO = float(os.getenv("PORTAL_UNILOG_HORAS_PARADO", os.getenv("UNILOG_HORAS_PARADO", "24")))
# Alerta do robô conta como ativo se foi repetido até X horas antes da última gravação do arquivo.
HORAS_ALERTA = float(os.getenv("PORTAL_UNILOG_HORAS_ALERTA", "3"))
# Arquivo sem gravação há mais que isto = robô parado (o robô roda em dias úteis, 08–14h).
HORAS_ARQUIVO_VELHO = float(os.getenv("PORTAL_UNILOG_HORAS_ARQUIVO", "72"))

STATUS = {
    "1": "PENDING", "2": "INTEGRATED", "3": "PENDING_CONFIRMATION", "4": "CONFIRMED",
    "5": "INTEGRATED_WITH_ERRORS", "21": "CANCELLED", "22": "SHIPPED",
}

# tipo de alerta do robô (robo_saida.alertar) -> categoria do portal
_CAT_ALERTA = {
    "SEM_EAN": "CADASTRO", "EAN_ALTERADO": "CADASTRO", "SEM_CADASTRO": "CADASTRO",
    "CADASTRO_PENDENTE": "CADASTRO", "CADASTRO_ERRO": "CADASTRO",
    "SEM_SALDO": "ESTOQUE", "PEDIDO_SEM_SALDO": "ESTOQUE",
    "ETIQUETA_FALHOU": "CORREIOS", "ETIQUETA_PENDENTE": "CORREIOS",
    "SEM_VOLUMES": "FATURAMENTO", "DOC_SEM_REGISTRO": "FATURAMENTO",
    "NF_CANCELADA_SAP": "CANCELAMENTO", "CANCELAMENTO_MANUAL_PENDENTE": "CANCELAMENTO",
}

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
NOME_SITUACAO = {
    "": "Enviada", "1": "Pendente", "2": "Integrada", "3": "Em conferência", "4": "Conferida",
    "5": "Erro na integração", "21": "Cancelada", "22": "Embarcada",
}


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
            nome = "Recusada"
        else:
            nome = NOME_SITUACAO.get(code, reg.get("status_desc") or code)
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
        "travada_desde": _iso(desde), "grupo": "UNILOG",
    }


def coletar_unilog() -> list:
    """Travadas de envio na Unilog, no formato do hub. Uma por NF (a 1ª causa vira o código)."""
    if not ligado():
        return []
    agora = time.time()
    dados, mtime = _ler()
    if dados is None:
        return [_ev("Unilog", "ESTADO", "UNILOG_SEM_ESTADO", "UNILOG",
                    f"Estado do robô da Unilog não encontrado ou ilegível ({ESTADO}) — o portal não vê os envios",
                    None)]

    por_nf: dict = {}

    def add(filial, nf, cod, cat, desc, desde):
        k = (filial, nf)
        if k in por_nf:
            por_nf[k]["problema_descricao"] += " + " + desc
        else:
            por_nf[k] = _ev(filial, nf, cod, cat, desc, desde)

    finais = set()
    for reg in dados.get("nfs", {}).values():
        filial, nf = reg.get("filial"), _limpar(reg.get("serial"))
        code = str(reg.get("status_code") or "")
        etapa = str(reg.get("etapa") or "")
        desde = reg.get("status_desde") or reg.get("enviado_em")
        if code in ("21", "22"):
            finais.add((filial, nf))
            continue
        if etapa == "RECUSADO":
            add(filial, nf, "UNILOG_RECUSADO", "UNILOG",
                f"Unilog recusou o pedido: {str(reg.get('erro') or '')[:200]}".rstrip(": "), reg.get("enviado_em"))
        elif etapa == "POST_INCERTO":
            add(filial, nf, "UNILOG_POST_INCERTO", "UNILOG",
                "Envio à Unilog sem confirmação — o robô reconcilia pela busca", reg.get("enviado_em"))
        elif code == "5":
            add(filial, nf, "UNILOG_ERRO_INTEGRACAO", "UNILOG",
                "Unilog integrou com erro (situação 5)", desde)
        else:
            h = _horas_desde(desde, agora)
            if h is not None and h >= HORAS_PARADO:
                nome = reg.get("status_desc") or STATUS.get(code, "sem situação")
                cod = "UNILOG_AGUARDA_EMBARQUE" if code in ("3", "4") else "UNILOG_PARADO"
                add(filial, nf, cod, "UNILOG", f"Parada na Unilog em {code or '—'} {nome} há {h:.0f} h", desde)

    # alertas que o robô repetiu no último ciclo (os antigos já foram resolvidos)
    corte = mtime - HORAS_ALERTA * 3600
    for a in dados.get("alertas", {}).values():
        visto = _iso(a.get("ultimo"))
        if not visto or datetime.fromisoformat(visto).timestamp() < corte:
            continue
        filial, nf = a.get("filial"), _limpar(a.get("serial"))
        if (filial, nf) in finais and a.get("tipo") != "CANCELAMENTO_MANUAL_PENDENTE":
            continue
        tipo = str(a.get("tipo") or "")
        add(filial, nf, f"UNILOG_{tipo}", _CAT_ALERTA.get(tipo, "UNILOG"),
            str(a.get("mensagem") or tipo)[:300], a.get("primeiro"))

    out = list(por_nf.values())
    idade_h = (agora - mtime) / 3600
    if idade_h >= HORAS_ARQUIVO_VELHO:
        out.append(_ev("Unilog", "ESTADO", "UNILOG_ESTADO_VELHO", "UNILOG",
                       f"O robô da Unilog não grava o estado há {idade_h:.0f} h — conferir a tarefa no servidor",
                       datetime.fromtimestamp(mtime).isoformat(timespec="seconds")))
    return out
