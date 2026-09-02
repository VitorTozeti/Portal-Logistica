"""
unilog_feed.py — FONTE do estado de ENVIO das NFs no modo UNILOG.

Substitui a "família B4YOU_*" do feed.py quando `PORTAL_CARRIER=UNILOG`. Como o
robô ainda NÃO grava status Unilog no log mestre (o pacote `unilog/` é standalone,
não entra no main.py), a fonte aqui são os CSVs que o próprio pacote `unilog/`
persiste em disco (só-leitura), no repo logistica_pharma:

  inbounds_enviados_{filial}_{amb}.csv    NF→requestId do POST de entrada/transferência
  inbounds_confirmados_{amb}.csv          status lido + PATCH (code 4) por NF
  etiquetas_correios_{filial}_{amb}.csv   etiqueta Correios→ZPL por NF (codigoObjeto)
  envio_catalogo_{amb}.csv                cadastro de produto (requestId/erro)
  produtos_sem_ean.csv                    produtos sem EAN (não cadastráveis no WMS)

⚠️ Estado sem pedidos: se os CSVs não existem, devolve VAZIO (sem ruído). Vai
"acender" sozinho quando houver expedição real na Unilog.

Estados de problema derivados AGORA (só do que está persistido em disco):
  UNILOG_SEM_REQUESTID · UNILOG_AGUARDA_CONFIRMACAO · UNILOG_ERRO_INTEGRACAO ·
  UNILOG_DESCARTADO · UNILOG_ETIQUETA_FALHA · UNILOG_SEM_EAN.
Os estados que exigem consulta AO VIVO à API (`GET /v2/outbounds/deliveries?id=`)
— UNILOG_LOTE_MISMATCH (trava em INTEGRATED 2 por lote), UNILOG_AGUARDA_SHIPPED
(22 SHIPPED → WhatsApp), UNILOG_CANC_RETORNO, UNILOG_BILLING_FALHA — ficam como
gancho para quando houver pedidos (ver `coletar_unilog_online`, hoje desligado).

Detalhe dos 11 estados: nota portal-logistica-nfs-problema no vault.
"""
import csv
import glob
import os
from datetime import datetime, timezone
from pathlib import Path

import carrier

_DIR = Path(carrier.UNILOG_DIR)
_AMB = carrier.UNILOG_AMBIENTE

# status_lido (confirmar_inbounds / verificar_inbound STATUS_NOMES) → (codigo, descricao)
# 1 PENDING · 2 INTEGRATED · 3 PENDING_CONFIRMATION · 4 CONFIRMED · 5 INTEGRATED_WITH_ERRORS · 6 DISREGARDED
_STATUS_PROBLEMA = {
    "3": ("UNILOG_AGUARDA_CONFIRMACAO", "Entrada liberada pela Unilog, aguardando nossa confirmação (PATCH code 4)"),
    "5": ("UNILOG_ERRO_INTEGRACAO", "Integração com erros no WMS (INTEGRATED_WITH_ERRORS) — revisar log de erro"),
    "6": ("UNILOG_DESCARTADO", "Pedido descartado pelo WMS (DISREGARDED)"),
}


def _iso(v: str) -> str:
    v = (v or "").strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(v[:19], fmt).replace(tzinfo=timezone.utc).isoformat()
        except ValueError:
            continue
    return datetime.now(timezone.utc).isoformat()


def _limpar_nf(v) -> str:
    try:
        return str(int(v))
    except (ValueError, TypeError):
        return str(v or "").strip().lstrip("0")


def _ler_csv(caminho: Path) -> list[dict]:
    if not caminho.exists():
        return []
    for enc in ("utf-8-sig", "latin-1"):
        try:
            with caminho.open("r", encoding=enc, newline="") as f:
                return list(csv.DictReader(f))
        except (UnicodeDecodeError, UnicodeError):
            continue
        except Exception as e:
            print(f"  [UNILOG_FEED] erro lendo {caminho.name}: {e}", flush=True)
            return []
    return []


def _glob(padrao: str) -> list[Path]:
    """Casa por padrão para não depender do casing exato de filial/ambiente."""
    if not _DIR.exists():
        return []
    return [Path(p) for p in glob.glob(str(_DIR / padrao))]


def _filial_do_nome(nome: str) -> str:
    n = nome.lower()
    if "varejo" in n:
        return "Varejo"
    if "atacado" in n:
        return "Atacado"
    return ""


def nfs_inbound(filial: str) -> set:
    """NFs já enviadas/confirmadas como INBOUND na Unilog (para silenciar a
    'transferência atrasada' do sap_feed — o análogo Unilog do /pedido/listar).
    Só as com POST aceito (http 200/202) contam como 'já subiu'."""
    achadas: set = set()
    for arq in _glob(f"inbounds_enviados_*{_AMB}.csv") + _glob("inbounds_confirmados_*.csv"):
        for r in _ler_csv(arq):
            fil = (r.get("filial") or _filial_do_nome(arq.name) or "").strip()
            if filial and fil and fil != filial:
                continue
            http = str(r.get("http") or r.get("http_patch") or "").strip()
            nf = _limpar_nf(r.get("nf"))
            if nf and (http in ("200", "202", "") or not http):
                achadas.add(nf)
    return achadas


def _evento(nf, filial, cod, desc, quando=None):
    return {
        "nf": str(nf), "filial": filial or "—",
        "transportadora": "Unilog", "estado": "travada",
        "problema_codigo": cod, "problema_categoria": "UNILOG",
        "problema_descricao": desc,
        "travada_desde": _iso(quando) if quando else None,
        "grupo": "UNILOG",
    }


def coletar_unilog() -> list[dict]:
    """Estados de problema de ENVIO na Unilog, derivados dos CSVs do pacote unilog/.
    Read-only; devolve [] se não houver nada persistido (sem pedidos ainda)."""
    out: list[dict] = []
    vistos: set = set()  # (filial, nf) para não duplicar entre CSVs

    # 1) INBOUND: POST sem requestId (status ilegível) + status lido problemático
    confirmados: dict[tuple, dict] = {}
    for arq in _glob("inbounds_confirmados_*.csv"):
        for r in _ler_csv(arq):
            fil = (r.get("filial") or _filial_do_nome(arq.name) or "").strip()
            confirmados[(fil, _limpar_nf(r.get("nf")))] = r

    for arq in _glob(f"inbounds_enviados_*{_AMB}.csv"):
        for r in _ler_csv(arq):
            fil = (r.get("filial") or _filial_do_nome(arq.name) or "").strip()
            nf = _limpar_nf(r.get("nf"))
            if not nf:
                continue
            http = str(r.get("http") or "").strip()
            req = str(r.get("requestId") or "").strip()
            chave = (fil, nf)
            if http not in ("200", "202") or not req:
                out.append(_evento(nf, fil, "UNILOG_SEM_REQUESTID",
                                   f"POST do inbound não aceito (http {http or '—'}) — status fica ilegível sem requestId",
                                   r.get("enviado_em")))
                vistos.add(chave)
                continue
            conf = confirmados.get(chave)
            if conf:
                status = str(conf.get("status_lido") or "").strip()
                if status in _STATUS_PROBLEMA:
                    cod, desc = _STATUS_PROBLEMA[status]
                    out.append(_evento(nf, fil, cod, desc, conf.get("quando")))
                    vistos.add(chave)

    # 2) ETIQUETA Correios→ZPL: sem codigoObjeto ou http != 200/201
    for arq in _glob(f"etiquetas_correios_*{_AMB}.csv"):
        for r in _ler_csv(arq):
            fil = (r.get("filial") or _filial_do_nome(arq.name) or "").strip()
            nf = _limpar_nf(r.get("nf"))
            if not nf:
                continue
            http = str(r.get("http") or "").strip()
            cod_obj = str(r.get("codigoObjeto") or "").strip()
            if http not in ("200", "201") or not cod_obj:
                if (fil, nf) not in vistos:
                    out.append(_evento(nf, fil, "UNILOG_ETIQUETA_FALHA",
                                       f"Etiqueta Correios→ZPL não gerada (http {http or '—'})",
                                       r.get("gerado_em")))
                    vistos.add((fil, nf))

    # 3) CADASTRO: produtos sem EAN (não cadastráveis no WMS) — nível item, não NF
    for arq in _glob("produtos_sem_ean.csv"):
        for r in _ler_csv(arq):
            item = str(r.get("item_code") or "").strip()
            if not item:
                continue
            out.append({
                "nf": item, "filial": "—", "transportadora": "Unilog",
                "estado": "travada", "problema_codigo": "UNILOG_SEM_EAN",
                "problema_categoria": "UNILOG",
                "problema_descricao": f"Produto {item} ({r.get('nome','')}) sem EAN no SAP — não cadastrável no WMS Unilog",
                "travada_desde": None, "grupo": "UNILOG",
            })

    return out


def coletar_unilog_online() -> list[dict]:
    """GANCHO (desligado): estados que exigem consulta AO VIVO à API Unilog
    (`GET /v2/outbounds/deliveries?id={requestId}`) — LOTE_MISMATCH (trava em
    INTEGRATED 2), AGUARDA_SHIPPED (22 → WhatsApp), CANC_RETORNO, BILLING_FALHA.
    Só faz sentido com pedidos reais; hoje devolve [] (sem pedidos)."""
    return []
