"""
faturamento.py — data de FATURAMENTO da NF (SAP `DocDate`) para toda NF do portal.

Pedido do Diego (logística, 06/10): o "tempo aberto" tem que contar do faturamento,
não da última tentativa do robô — assim medimos o delta entre FATURAR e INTEGRAR na B4You.
100% LEITURA no HANA (OINV + ODLN, mesma fonte dos outros motores).

Uma query só, com cache (TTL) — o feed roda a cada 20s e não precisa bater no HANA toda vez.
Falha de conexão -> devolve o último cache (ou vazio): o portal nunca cai por causa disto.
"""
import time
from datetime import datetime, timezone

from sap_feed import HANA, _limpar

BPLID = {"Varejo": 3, "Atacado": 4, "Matriz": 1}
JANELA_DIAS = int(__import__("os").getenv("PORTAL_FATURAMENTO_DIAS", "400"))
TTL = int(__import__("os").getenv("PORTAL_FATURAMENTO_TTL", "1800"))  # s

QUERY = """
SELECT "BPLId", "Serial", MIN("DocDate") FROM (
  SELECT "BPLId", "Serial", "DocDate" FROM "SBOPHARMAESTHETICS"."OINV"
   WHERE "CANCELED"='N' AND "BPLId" IN (1,3,4) AND "DocDate">=ADD_DAYS(CURRENT_DATE,-?)
  UNION ALL
  SELECT "BPLId", "Serial", "DocDate" FROM "SBOPHARMAESTHETICS"."ODLN"
   WHERE "CANCELED"='N' AND "BPLId" IN (1,3,4) AND "DocDate">=ADD_DAYS(CURRENT_DATE,-?)
) GROUP BY "BPLId", "Serial"
"""

_cache: dict = {"quando": 0.0, "mapa": {}}


def _iso(d) -> str:
    if isinstance(d, datetime):
        return d.replace(tzinfo=timezone.utc).isoformat()
    return datetime.strptime(str(d)[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc).isoformat()


def _carregar() -> dict:
    from hdbcli import dbapi
    conn = dbapi.connect(address=HANA["address"], port=HANA["port"],
                         user=HANA["user"], password=HANA["password"])
    try:
        cur = conn.cursor()
        cur.execute(QUERY, (JANELA_DIAS, JANELA_DIAS))
        return {(int(b), _limpar(str(s))): _iso(d) for b, s, d in cur.fetchall() if s and d}
    finally:
        conn.close()


def _mapa() -> dict:
    if _cache["mapa"] and time.time() - _cache["quando"] < TTL:
        return _cache["mapa"]
    try:
        if HANA["user"] and HANA["password"]:
            _cache["mapa"], _cache["quando"] = _carregar(), time.time()
    except Exception as e:
        print(f"  [FATURAMENTO] não consegui ler o DocDate ({e}) — mantendo o último cache.", flush=True)
    return _cache["mapa"]


def enriquecer(eventos: list[dict]) -> None:
    """Põe `data_faturamento` em cada evento (se achar no SAP). Nas TRAVADAS também
    passa a contar o "travada há" do faturamento (`travada_desde`), mantendo a data
    original em `ultima_tentativa` quando ela for diferente."""
    mapa = _mapa()
    if not mapa:
        return
    for ev in eventos:
        b = BPLID.get(ev.get("filial"))
        fat = mapa.get((b, _limpar(str(ev.get("nf", ""))))) if b else None
        if not fat:
            continue
        ev["data_faturamento"] = fat
        if ev.get("estado") == "travada":
            if ev.get("travada_desde") and ev["travada_desde"] != fat:
                ev["ultima_tentativa"] = ev["travada_desde"]
            ev["travada_desde"] = fat
