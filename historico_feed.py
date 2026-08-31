"""
historico_feed.py — HISTÓRICO completo de notas "subidas" (faturadas) no SAP.

Fonte = a MESMA do projeto análise-custo (query estilo ORÁCULO): UNION de OINV
(NF Saída) e ODLN (Remessa) por BPLId, 100% LEITURA. Cobre as DUAS eras da empresa:
  - schema atual   `SBOPHARMAESTHETICS`            → Varejo=BPLId 3, Atacado=4
  - schema legado  `PHARMAESTHETICS_LEGADO_2026FEV`→ Varejo=BPLId 4, Atacado=5
(remapeamento de BPLId confirmado em referencias/sap-pharmaesthetics.md — por isso o
mapa filial↔BPLId é POR SCHEMA, nunca cruzando eras).

Credenciais: empresta o mesmo `.env` do robô que o `sap_feed.py` já usa. Read-only:
nunca grava nada. Se `hdbcli` faltar ou não houver SAP_USER/SAP_PASS, devolve vazio
com aviso (sem quebrar o portal).
"""
import os
from pathlib import Path

from dotenv import load_dotenv

# mesmas credenciais do sap_feed (empresta o .env do robô)
_ROBOT_ENV = os.getenv(
    "PORTAL_ROBOT_ENV",
    r"C:\Users\v.tozeti\Desktop\Vitor\Logistica\logistica_pharma\.env",
)
load_dotenv()
if Path(_ROBOT_ENV).exists():
    load_dotenv(_ROBOT_ENV, override=False)

HANA = {
    "address": os.getenv("SAP_ADDRESS", "10.124.179.26"),
    "port": int(os.getenv("SAP_PORT", "30015")),
    "user": os.getenv("SAP_USER"),
    "password": os.getenv("SAP_PASS"),
}

# filial ↔ BPLId POR SCHEMA (não cruzar eras — o BPLId foi remapeado na migração).
# Matriz = BPLId 1 nas DUAS eras (CNPJ 0102, Pinhais-PR; trata marketing/bonificação) — ver
# referencias/sap-pharmaesthetics.md. Varejo/Atacado foram remapeados; a Matriz não.
ERAS = [
    {"schema": "SBOPHARMAESTHETICS",             "filiais": {1: "Matriz", 3: "Varejo", 4: "Atacado"}},
    {"schema": "PHARMAESTHETICS_LEGADO_2026FEV", "filiais": {1: "Matriz", 4: "Varejo", 5: "Atacado"}},
]


def _query(schema: str, bplids: list[int]) -> str:
    """UNION OINV (Saída) + ODLN (Remessa) do schema, filtrado por BPLId e período."""
    ids = ",".join(str(i) for i in bplids)
    return f"""
SELECT B."Serial" AS "NF", B."BPLId" AS "BPLID", B."DocDate" AS "DATA", 'Saída' AS "TIPO",
    MAX(T."CardName") AS "TRANSP"
FROM "{schema}"."OINV" B
LEFT JOIN "{schema}"."INV12" X ON B."DocEntry"=X."DocEntry"
LEFT JOIN "{schema}"."OCRD" T ON T."CardCode"=X."Carrier"
WHERE B."CANCELED"='N' AND B."BPLId" IN ({ids}) AND B."DocDate" BETWEEN ? AND ?
GROUP BY B."Serial", B."BPLId", B."DocDate"
UNION ALL
SELECT B."Serial", B."BPLId", B."DocDate", 'Remessa',
    MAX(T."CardName")
FROM "{schema}"."ODLN" B
LEFT JOIN "{schema}"."DLN12" X ON B."DocEntry"=X."DocEntry"
LEFT JOIN "{schema}"."OCRD" T ON T."CardCode"=X."Carrier"
WHERE B."CANCELED"='N' AND B."BPLId" IN ({ids}) AND B."DocDate" BETWEEN ? AND ?
GROUP BY B."Serial", B."BPLId", B."DocDate"
"""


def _nf(v) -> str:
    try:
        return str(int(v))
    except (ValueError, TypeError):
        return str(v or "").strip()


def _data(v) -> str:
    return str(v)[:10] if v else ""


def consultar_historico(de: str, ate: str, filial: str = "todas",
                        pagina: int = 1, por_pagina: int = 100,
                        nf: str = "", transp: str = "", ignoradas: str = "todas",
                        ignorados: str = "") -> dict:
    """Devolve {itens, total, pagina, paginas, transportadoras} das notas faturadas no período.
    `de`/`ate` = "YYYY-MM-DD"; `filial` = "todas"|"Varejo"|"Atacado".
    Filtros extras (aplicados sobre o período/filial, ANTES da paginação, então valem no
    histórico inteiro e não só na página visível):
      - `nf`        : substring do número da NF ("" = sem filtro).
      - `transp`    : nome exato da transportadora ("todas"/"" = sem filtro).
      - `ignoradas` : "todas" | "so" (só ignoradas) | "sem" (oculta ignoradas).
      - `ignorados` : lista "Filial:NF,Filial:NF,…" das notas ignoradas (o SAP não sabe
                      quais são; o portal manda o conjunto conhecido p/ marcar/filtrar).
    Também devolve `transportadoras` = as transportadoras distintas do período/filial (p/ o
    dropdown do front), calculadas antes do filtro de transportadora."""
    try:
        from hdbcli import dbapi
    except ImportError:
        return {"erro": "hdbcli não instalado no servidor — histórico SAP indisponível.",
                "itens": [], "total": 0, "pagina": 1, "paginas": 1}
    if not HANA["user"] or not HANA["password"]:
        return {"erro": "sem SAP_USER/SAP_PASS no .env — histórico SAP indisponível.",
                "itens": [], "total": 0, "pagina": 1, "paginas": 1}

    try:
        conn = dbapi.connect(address=HANA["address"], port=HANA["port"],
                             user=HANA["user"], password=HANA["password"])
    except Exception as e:
        return {"erro": f"falha ao conectar ao SAP (VPN?): {e}",
                "itens": [], "total": 0, "pagina": 1, "paginas": 1}

    linhas: list[dict] = []
    try:
        cur = conn.cursor()
        for era in ERAS:
            mapa = era["filiais"]
            bplids = [b for b, nome in mapa.items() if filial == "todas" or nome == filial]
            if not bplids:
                continue
            try:
                cur.execute(_query(era["schema"], bplids), (de, ate, de, ate))
                for r in cur.fetchall():
                    linhas.append({
                        "nf": _nf(r[0]),
                        "filial": mapa.get(r[1], "?"),
                        "data_nota": _data(r[2]),
                        "tipo": str(r[3] or ""),
                        "transportadora": str(r[4] or "—"),
                        "ignorada": False,
                    })
            except Exception as e:
                # schema legado pode não existir em todos os ambientes — não derruba a busca
                print(f"  [HISTORICO] schema {era['schema']}: {e}", flush=True)
    finally:
        conn.close()

    linhas.sort(key=lambda x: (x["data_nota"], x["nf"]), reverse=True)

    # marca ignoradas a partir do conjunto que o portal conhece ("Filial:NF")
    ign_set = {p.strip() for p in ignorados.split(",") if p.strip()}
    if ign_set:
        for x in linhas:
            if f"{x['filial']}:{x['nf']}" in ign_set:
                x["ignorada"] = True

    # transportadoras distintas do período/filial (p/ o dropdown) — antes de filtrar por transp
    transportadoras = sorted({x["transportadora"] for x in linhas if x["transportadora"] and x["transportadora"] != "—"})

    # filtros extras (histórico inteiro, antes da paginação)
    nf = (nf or "").strip()
    if nf:
        linhas = [x for x in linhas if nf in x["nf"]]
    if transp and transp != "todas":
        linhas = [x for x in linhas if x["transportadora"] == transp]
    if ignoradas == "so":
        linhas = [x for x in linhas if x["ignorada"]]
    elif ignoradas == "sem":
        linhas = [x for x in linhas if not x["ignorada"]]

    total = len(linhas)
    por_pagina = max(1, min(por_pagina, 500))
    paginas = max(1, (total + por_pagina - 1) // por_pagina)
    pagina = max(1, min(pagina, paginas))
    ini = (pagina - 1) * por_pagina
    return {"itens": linhas[ini:ini + por_pagina], "total": total,
            "pagina": pagina, "paginas": paginas, "transportadoras": transportadoras}
