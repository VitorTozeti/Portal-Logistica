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

    out = []
    for r in linhas:
        if str(r.get("Status", "")).strip().upper() != "ERRO":
            continue
        nf = str(r.get("NF", "")).strip()
        if not nf:
            continue
        out.append({
            "nf": nf, "filial": "Matriz", "estado": "travada",
            "transportadora": "Correios (Matriz)",
            "problema_codigo": "MARKETING_ETIQUETA", "problema_categoria": "MARKETING",
            "problema_descricao": _resumo_erro(str(r.get("Msg_Erro", ""))),
            "travada_desde": _iso(str(r.get("Data", ""))), "grupo": "MARKETING",
        })
    return out
