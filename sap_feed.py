"""
sap_feed.py — MOTOR 1: notas barradas no SAP (não desceram para a logística).

Replica, 100% LEITURA, a `auditoria.buscar_notas_barradas_sap()` do robô
(auditoria.py): mesma query HANA, mesmos filtros (silenciador uso 71,
transferências 106/107/108 via B4You, SEFAZ/chave/uso/depósito).

⚠️ DIFERENÇA PROPOSITAL: a versão do robô GRAVA `transferencias.csv` no fim.
Aqui NÃO gravamos nada — o portal é read-only e não mexe no estado do robô.

Credenciais: por padrão empresta o `.env` do robô (mesma máquina), então o
portal não depende do robô *rodar* — só das mesmas fontes (SAP/B4You). Override
por `PORTAL_ROBOT_ENV` (caminho do .env) ou por um `.env` na pasta do portal.
"""
import base64
import os
from datetime import datetime, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv

# credenciais: .env do portal (se existir) + fallback no .env do robô
_ROBOT_ENV = os.getenv(
    "PORTAL_ROBOT_ENV",
    r"C:\Users\v.tozeti\Desktop\Vitor\Logistica\logistica_pharma\.env",
)
load_dotenv()  # .env do portal, se houver
if Path(_ROBOT_ENV).exists():
    load_dotenv(_ROBOT_ENV, override=False)  # completa o que faltar

HANA = {
    "address": os.getenv("SAP_ADDRESS", "10.124.179.26"),
    "port": int(os.getenv("SAP_PORT", "30015")),
    "user": os.getenv("SAP_USER"),
    "password": os.getenv("SAP_PASS"),
}

# B4You PROD (para validar transferências atrasadas). user fixo por filial (config.py:285,306).
B4YOU = {
    "url": os.getenv("B4YOU_URL_P") or os.getenv("B4YOU_URL"),
    "Varejo":  ("pharmaestheticsvarejo", os.getenv("B4YOU_PASS_VAREJO_P") or os.getenv("B4YOU_PASS_VAREJO")),
    "Atacado": ("pharmaesthetics",       os.getenv("B4YOU_PASS_ATACADO_P") or os.getenv("B4YOU_PASS_ATACADO")),
}

# mesma query da auditoria (auditoria.py:81-125) + DocDate para o "travada_desde".
QUERY = """
SELECT B."Serial" AS "NF", B."BPLId", 'Nota Fiscal' AS "Tipo",
    MAX(L."MainUsage") AS "MainUsage", MAX(U."Usage") AS "DescricaoUso",
    MAX(E."U_inStatus") AS "inStatus", MAX(E."U_cdErro") AS "cdErro",
    MAX(ITM."WhsCode") AS "WhsCode", MAX(E."U_ChaveAcesso") AS "Chave",
    MAX(B."DocDate") AS "DocDate"
FROM "SBOPHARMAESTHETICS"."OINV" B
LEFT JOIN "SBOPHARMAESTHETICS"."INV12" L ON B."DocEntry"=L."DocEntry"
LEFT JOIN "SBOPHARMAESTHETICS"."OUSG" U ON L."MainUsage"=U."ID"
LEFT JOIN "SBOPHARMAESTHETICS"."@SKL25NFE" E ON E."U_DocEntry"=B."DocEntry" AND E."U_tipoDocumento"='NS'
LEFT JOIN "SBOPHARMAESTHETICS"."INV1" ITM ON B."DocEntry"=ITM."DocEntry"
WHERE B."CANCELED"='N' AND B."BPLId" IN (3,4) AND B."DocDate">=ADD_DAYS(CURRENT_DATE,-7)
GROUP BY B."DocEntry", B."Serial", B."BPLId"
UNION ALL
SELECT B."Serial" AS "NF", B."BPLId", 'Remessa' AS "Tipo",
    MAX(L."MainUsage"), MAX(U."Usage"), MAX(E."U_inStatus"), MAX(E."U_cdErro"),
    MAX(ITM."WhsCode"), MAX(E."U_ChaveAcesso"), MAX(B."DocDate")
FROM "SBOPHARMAESTHETICS"."ODLN" B
LEFT JOIN "SBOPHARMAESTHETICS"."DLN12" L ON B."DocEntry"=L."DocEntry"
LEFT JOIN "SBOPHARMAESTHETICS"."OUSG" U ON L."MainUsage"=U."ID"
LEFT JOIN "SBOPHARMAESTHETICS"."@SKL25NFE" E ON E."U_DocEntry"=B."DocEntry" AND E."U_tipoDocumento"='EM'
LEFT JOIN "SBOPHARMAESTHETICS"."DLN1" ITM ON B."DocEntry"=ITM."DocEntry"
WHERE B."CANCELED"='N' AND B."BPLId" IN (3,4) AND B."DocDate">=ADD_DAYS(CURRENT_DATE,-7)
GROUP BY B."DocEntry", B."Serial", B."BPLId"
"""

_cache_b4you: dict[str, set] = {}


def _limpar(v) -> str:
    if not v:
        return ""
    try:
        return str(int(v))
    except (ValueError, TypeError):
        return str(v).strip().lstrip("0")


def _iso(docdate) -> str:
    try:
        if isinstance(docdate, (datetime,)):
            return docdate.replace(tzinfo=timezone.utc).isoformat()
        return datetime.strptime(str(docdate)[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc).isoformat()
    except Exception:
        return datetime.now(timezone.utc).isoformat()


def _nfs_b4you(filial: str) -> set:
    """GET read-only /v1/pedido/listar (15 dias). Igual a obter_nfs_b4you_em_cache (auditoria.py:33)."""
    if filial in _cache_b4you:
        return _cache_b4you[filial]
    user, pw = B4YOU[filial]
    achadas: set = set()
    if not B4YOU["url"] or not pw:
        _cache_b4you[filial] = achadas
        return achadas
    from datetime import date, timedelta
    hoje = date.today()
    tok = base64.b64encode(f"{user}:{pw}".encode()).decode()
    try:
        resp = requests.get(
            f"{B4YOU['url']}/v1/pedido/listar",
            headers={"Authorization": f"Basic {tok}", "Content-Type": "application/json"},
            params={"RetornaItens": "false", "PedidosStatus": "0",
                    "DataInicial": (hoje - timedelta(days=15)).strftime("%Y-%m-%d"),
                    "DataFinal": hoje.strftime("%Y-%m-%d")},
            timeout=30,
        )
        if resp.status_code == 200:
            for p in resp.json():
                d = p.get("Dados", {}).get("Pedido", {})
                for k in ("NotaFiscal", "NumPedido"):
                    v = _limpar(d.get(k, ""))
                    if v:
                        achadas.add(v)
    except Exception as e:
        print(f"  [SAP_FEED] B4You {filial}: {e}")
    _cache_b4you[filial] = achadas
    return achadas


def coletar_barradas(nfs_no_log: set) -> list[dict]:
    """Roda a auditoria (read-only) e devolve as barradas já no formato do hub.
    `nfs_no_log` = NFs que já constam no log mestre (excluídas, iguais à auditoria)."""
    try:
        from hdbcli import dbapi
    except ImportError:
        print("  [SAP_FEED] hdbcli não instalado — pulando Motor 1")
        return []
    if not HANA["user"] or not HANA["password"]:
        print("  [SAP_FEED] sem SAP_USER/SAP_PASS no .env — pulando Motor 1")
        return []

    try:
        conn = dbapi.connect(address=HANA["address"], port=HANA["port"],
                             user=HANA["user"], password=HANA["password"])
    except Exception as e:
        print(f"  [SAP_FEED] falha ao conectar HANA: {e}")
        return []

    try:
        cur = conn.cursor()
        cur.execute(QUERY)
        linhas = cur.fetchall()
    finally:
        conn.close()

    _cache_b4you.clear()  # revalida a cada ciclo
    out = []
    for r in linhas:
        nf = _limpar(str(r[0]))
        if not nf or nf in nfs_no_log:
            continue
        bplid, tipo, uso = r[1], r[2], r[3]
        desc_uso = str(r[4]) if r[4] else "Não preenchido"
        in_status, cd_erro, whs, chave, docdate = r[5], r[6], r[7], r[8], r[9]
        filial = "Varejo" if bplid == 3 else "Atacado"

        if uso == 71:  # silenciador absoluto
            continue

        if uso in (106, 107, 108):  # transferências internas
            if nf in _nfs_b4you(filial):
                continue  # já apareceu na B4You → ok, silencia
            out.append({
                "nf": nf, "filial": filial, "estado": "travada",
                "transportadora": filial.upper(),
                "problema_codigo": "TRANSFERENCIA_ATRASADA", "problema_categoria": "TRANSFERENCIA",
                "problema_descricao": f"Transferência Atrasada - B4You ({tipo}) · Utilização {uso} ({desc_uso})",
                "travada_desde": _iso(docdate), "grupo": "BARRADAS_SAP",
            })
            continue

        motivos, cod = [], None
        if not chave:
            motivos.append("Falta Chave de Acesso"); cod = cod or "FALTA_CHAVE"
        elif in_status != 3 or cd_erro not in (100, 150):
            motivos.append(f"Barrada na SEFAZ (Status: {in_status}, Erro: {cd_erro})"); cod = cod or "SEFAZ_BARRADA"
        if uso not in (35, 61, 73, 86, 98):
            motivos.append(f"Utilização ignorada: {uso} ({desc_uso})"); cod = cod or "USO_IGNORADO"
        if whs in ("03.05", "04.05"):
            motivos.append(f"Depósito bloqueado ({whs})"); cod = cod or "DEPOSITO_BLOQUEADO"
        if not motivos:
            continue

        out.append({
            "nf": nf, "filial": filial, "estado": "travada",
            "transportadora": filial.upper(),
            "problema_codigo": cod, "problema_categoria": "FATURAMENTO" if cod in ("FALTA_CHAVE", "SEFAZ_BARRADA") else "AUDITORIA",
            "problema_descricao": f"Barrada nos filtros do SAP ({tipo}): " + " + ".join(motivos),
            "travada_desde": _iso(docdate), "grupo": "BARRADAS_SAP",
        })
    return out
