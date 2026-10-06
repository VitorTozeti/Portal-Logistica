"""
marketing_feed.py — falhas de etiqueta Correios do robô de MARKETING (uso 127).

100% LEITURA: lê o CSV que o robô de marketing já grava
(`controle_etiquetas_marketing.csv`) e mostra as linhas com `Status == "ERRO"`.
NÃO roda `processar_etiquetas_marketing` (esse gera etiqueta de verdade na API
dos Correios) — só lê o resultado já persistido.

O CSV é deduplicado por NF (mantém o último estado), então uma linha `ERRO`
significa uma etiqueta ainda NÃO resolvida — é exatamente o que o email lista.
Colunas: Data, NF, Chave, BPLId, Carrier, Status, Rastreio, Arquivo, Msg_Erro.
"""
import csv
import os
from datetime import datetime, timezone
from pathlib import Path

CSV_MARKETING = os.getenv(
    "PORTAL_LOG_MARKETING",
    r"\\10.41.212.3\Pharmaesthetics\Logística\26 - Logística Expedição\1.ETIQUETAS CORREIOS\antes de 2026\controle_etiquetas_marketing.csv",
)


def _iso(data_str: str) -> str:
    try:
        return datetime.strptime(data_str.strip(), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).isoformat()
    except Exception:
        return datetime.now(timezone.utc).isoformat()


def _resumo_erro(msg: str) -> str:
    """Extrai a parte legível do JSON de erro dos Correios para a descrição."""
    m = msg or ""
    if "CEP" in m and "não foi encontrado" in m:
        return "Falha etiqueta Correios: CEP do destinatário não encontrado (corrigir cadastro no SAP)"
    if "valor declarado" in m.lower():
        return "Falha etiqueta Correios: valor declarado fora da faixa permitida (Serviço Adicional 019)"
    return "Falha ao gerar etiqueta Correios (marketing): " + m[:160]


DIAS_BUSCA_MKT = 30  # janela do robô (etiqueta_marketing.py): passou disso ele não tenta nem avisa mais


def _nfs_na_janela(nfs: set) -> set | None:
    """NFs (matriz, uso 127) com DocDate dentro da janela do robô. Só leitura no HANA.
    Qualquer falha -> None (o chamador mantém tudo, sem esconder erro por engano)."""
    if not nfs:
        return set()
    try:
        import sap_feed
        from hdbcli import dbapi
        lista = ",".join(str(int(n)) for n in nfs)
        conn = dbapi.connect(address=sap_feed.HANA["address"], port=sap_feed.HANA["port"],
                             user=sap_feed.HANA["user"], password=sap_feed.HANA["password"])
        try:
            cur = conn.cursor()
            ok = set()
            for tb, lk in (("OINV", "INV12"), ("ODLN", "DLN12")):
                cur.execute(
                    f'''SELECT B."Serial" FROM "SBOPHARMAESTHETICS"."{tb}" B
                    JOIN "SBOPHARMAESTHETICS"."{lk}" L ON L."DocEntry"=B."DocEntry"
                    WHERE B."CANCELED"='N' AND L."MainUsage"=127
                      AND B."DocDate">=ADD_DAYS(CURRENT_DATE,-?) AND B."Serial" IN ({lista})''',
                    (DIAS_BUSCA_MKT,))
                ok.update(str(int(r[0])) for r in cur.fetchall())
            return ok
        finally:
            conn.close()
    except Exception as e:
        print(f"  [MKT_FEED] janela de {DIAS_BUSCA_MKT}d não verificada: {e}")
        return None


def coletar_marketing() -> list[dict]:
    p = Path(CSV_MARKETING)
    if not p.exists():
        print(f"  [MKT_FEED] CSV não encontrado: {CSV_MARKETING}")
        return []
    linhas = []
    for enc in ("utf-8-sig", "latin-1"):
        try:
            with p.open("r", encoding=enc, newline="") as f:
                linhas = list(csv.DictReader(f))
            break
        except (UnicodeDecodeError, UnicodeError):
            continue
        except Exception as e:
            print(f"  [MKT_FEED] erro lendo CSV: {e}")
            return []

    erros = [r for r in linhas
             if str(r.get("Status", "")).strip().upper() == "ERRO" and str(r.get("NF", "")).strip()]
    # o robô só reprocessa/avisa NFs dentro da janela; o CSV mantém ERRO para sempre
    na_janela = _nfs_na_janela({str(r["NF"]).strip() for r in erros})
    out = []
    for r in erros:
        nf = str(r.get("NF", "")).strip()
        if na_janela is not None and nf.lstrip("0") not in na_janela:
            continue
        out.append({
            "nf": nf, "filial": "Matriz", "estado": "travada",
            "transportadora": "Correios (Matriz)",
            "problema_codigo": "MARKETING_ETIQUETA", "problema_categoria": "MARKETING",
            "problema_descricao": _resumo_erro(str(r.get("Msg_Erro", ""))),
            "travada_desde": _iso(str(r.get("Data", ""))), "grupo": "MARKETING",
        })
    return out
