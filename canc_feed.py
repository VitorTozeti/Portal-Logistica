"""
canc_feed.py — diagnóstico de CANCELAMENTOS que precisam de ação manual.

100% LEITURA. Replica só a parte de DETECÇÃO de `cancelamento.processar_cancelamentos`
(cancelamento.py:252-327) que gera os itens de "atenção" — NUNCA a parte que
cancela na B4You (DELETE) nem a que grava CANCELADO no log.

Regra: NF cancelada no SAP (CANCELED='Y') que ainda não está marcada CANCELADO no
log e precisa de olho humano:
  - consta ENVIADA no log mas não aparece na B4You  -> "verificar manual" (ex.: NF 268)
  - está na B4You e JÁ EXPEDIDA (Status 7)          -> "cancelar manual"
  - está na B4You e cancelável (nem 7 nem 8)         -> "pendente de cancelamento" (o robô trata)

Credenciais/coned HANA e B4You: reusa o sap_feed.
"""
from datetime import date, timedelta

import sap_feed

DIAS_CANCELAMENTO = 7   # janela SAP (cancelamento.py:38)
BPL = {"Varejo": 3, "Atacado": 4}

QUERY_CANCELADAS = """
SELECT A."NF", MAX(A."Tipo") AS "Tipo" FROM (
  SELECT B."Serial" AS "NF", 'NF' AS "Tipo" FROM "SBOPHARMAESTHETICS"."OINV" B
  WHERE B."CANCELED"='Y' AND B."BPLId"=? AND B."DocDate">=ADD_DAYS(CURRENT_DATE,-?)
  UNION ALL
  SELECT B."Serial" AS "NF", 'Remessa' AS "Tipo" FROM "SBOPHARMAESTHETICS"."ODLN" B
  WHERE B."CANCELED"='Y' AND B."BPLId"=? AND B."DocDate">=ADD_DAYS(CURRENT_DATE,-?)
) AS A GROUP BY A."NF"
"""


def _consultar_b4you(filial: str, nfs_alvo: set) -> dict:
    """GET /v1/pedido/listar (read-only) → {num_limpo: {"status":...}} (cancelamento.py:67)."""
    import base64
    import requests
    import carrier
    # No modo UNILOG não há API /pedido/listar — o cancelamento Unilog é POR DOCUMENTO
    # (montar_cancelamento, Cenário 1/2). Sem esse diagnóstico fino por ora: retorna vazio
    # (as notas canceladas no SAP seguem visíveis pela auditoria, sem falso "cancelar manual").
    if carrier.IS_UNILOG:
        return {}
    if not nfs_alvo or not sap_feed.B4YOU["url"]:
        return {}
    user, pw = sap_feed.B4YOU[filial]
    if not pw:
        return {}
    hoje = date.today()
    tok = base64.b64encode(f"{user}:{pw}".encode()).decode()
    mapa = {}
    try:
        resp = requests.get(
            f"{sap_feed.B4YOU['url']}/v1/pedido/listar",
            headers={"Authorization": f"Basic {tok}", "Content-Type": "application/json"},
            params={"RetornaItens": "false", "PedidosStatus": "0",
                    "DataInicial": (hoje - timedelta(days=30)).strftime("%Y-%m-%d"),
                    "DataFinal": hoje.strftime("%Y-%m-%d")},
            timeout=30,
        )
        if resp.status_code != 200:
            return {}
        for p in resp.json():
            d = p.get("Dados", {}).get("Pedido", {})
            idl = sap_feed._limpar(str(d.get("NumPedido", "") or ""))
            nfl = sap_feed._limpar(str(d.get("NotaFiscal", "") or ""))
            reg = {"status": str(d.get("Status", ""))}
            if idl in nfs_alvo or nfl in nfs_alvo:
                if idl:
                    mapa[idl] = reg
                if nfl:
                    mapa[nfl] = reg
    except Exception as e:
        print(f"  [CANC_FEED] B4You {filial}: {e}")
    return mapa


def coletar_cancelamentos(log_index: dict) -> list:
    """
    log_index = { filial: { nf_limpo: {"status": Envio_B4You_NF, "carrier": Carrier} } }.
    POR FILIAL porque o nº da NF colide entre Varejo/Atacado. Cada filial é cruzada só com
    o log dela — exatamente como o robô (status_por_nf é por job).
    Devolve só os itens de atenção (ação manual), no formato do hub.
    """
    try:
        from hdbcli import dbapi
    except ImportError:
        return []
    if not sap_feed.HANA["user"]:
        return []
    try:
        conn = dbapi.connect(address=sap_feed.HANA["address"], port=sap_feed.HANA["port"],
                             user=sap_feed.HANA["user"], password=sap_feed.HANA["password"])
    except Exception as e:
        print(f"  [CANC_FEED] HANA: {e}")
        return []

    out = []
    try:
        for filial, bpl in BPL.items():
            log_f = log_index.get(filial, {})  # só o log DESTA filial (sem colisão de NF)
            cur = conn.cursor()
            cur.execute(QUERY_CANCELADAS, (bpl, DIAS_CANCELAMENTO, bpl, DIAS_CANCELAMENTO))
            canceladas = {sap_feed._limpar(str(r[0])) for r in cur.fetchall() if r[0]}
            canceladas.discard("")
            # candidatos = cancelada no SAP + está no log DA FILIAL + ainda não CANCELADO
            candidatos = sorted(
                nf for nf in canceladas
                if nf in log_f and log_f[nf]["status"] != "CANCELADO"
            )
            if not candidatos:
                continue
            mapa = _consultar_b4you(filial, set(candidatos))
            for nf in candidatos:
                carrier = log_f[nf]["carrier"]
                enviada = log_f[nf]["status"] == "OK"
                info = mapa.get(nf)
                cod = desc = None
                if info is None:
                    if enviada:
                        cod = "CANC_ENVIADA_NAO_LOCALIZADA"
                        desc = "Cancelada no SAP e consta ENVIADA, mas não localizada na B4You (verificar manual)"
                    else:
                        continue  # nunca subiu → o robô bloqueia sozinho, não é ação manual
                elif info["status"] == "8":
                    continue  # já cancelada na B4You → reconciliação automática
                elif info["status"] == "7":
                    cod = "CANC_JA_EXPEDIDA"
                    desc = "Cancelada no SAP, mas JÁ EXPEDIDA na B4You (cancelar manual)"
                else:
                    cod = "CANC_PENDENTE_B4YOU"
                    desc = f"Cancelada no SAP, pendente de cancelamento na B4You (status B4You: {info['status']})"
                import feed as _feed
                nome_carrier = _feed._nome_transp(carrier) if carrier and carrier.startswith("F") else (carrier or filial.upper())
                out.append({
                    "nf": nf, "filial": filial, "estado": "travada",
                    "transportadora": nome_carrier,
                    "problema_codigo": cod, "problema_categoria": "CANCELAMENTO",
                    "problema_descricao": desc,
                    "travada_desde": None, "grupo": "CANCELAMENTO",
                })
    finally:
        conn.close()
    return out
