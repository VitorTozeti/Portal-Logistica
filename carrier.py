"""
carrier.py — seleciona a TRANSPORTADORA/operador do portal (B4You ou Unilog).

O portal nasceu em cima da B4You; a Pharmaesthetics está migrando para a Unilog
(3PL/WMS, API 2.0). Em vez de manter dois forks, a MESMA base roda nos dois modos
atrás de um flag — `PORTAL_CARRIER`. A branch `Unilog` usa `UNILOG` por padrão; a
`main` (produção B4You) segue `B4YOU`. Nada aqui grava — é só configuração.

Uso:
    import carrier
    if carrier.IS_UNILOG: ...
    if carrier.usar_b4you_api(): ...   # chamar /v1/pedido/listar?

O que muda por modo:
- família de códigos de problema de ENVIO (B4YOU_* × UNILOG_*);
- de onde vem o status de envio (log mestre `Envio_B4You_*` × CSVs do pacote unilog/);
- se os motores SAP consultam a API da B4You (transferências/cancelamento).
Os motores SAP em si (barradas, marketing, histórico) são agnósticos e não mudam.
"""
import os

# B4YOU (produção atual) | UNILOG (esta branch). Default UNILOG na branch Unilog.
CARRIER = (os.getenv("PORTAL_CARRIER", "UNILOG") or "UNILOG").strip().upper()
if CARRIER not in ("B4YOU", "UNILOG"):
    CARRIER = "UNILOG"

IS_UNILOG = CARRIER == "UNILOG"
IS_B4YOU = CARRIER == "B4YOU"

# Nome exibido no front/logs.
NOME = "Unilog" if IS_UNILOG else "B4You"


def usar_b4you_api() -> bool:
    """Os motores SAP (sap_feed/canc_feed) só batem na API da B4You no modo B4YOU.
    No modo UNILOG as transferências são silenciadas pelo estado do inbound Unilog
    (ver unilog_feed.nfs_inbound) e o cancelamento é por documento (fora de escopo
    da consulta B4You)."""
    return IS_B4YOU


# --- Fonte dos dados do pacote Unilog (só-leitura) ---------------------------
# Onde o pacote `unilog/` (do repo logistica_pharma) persiste seus CSVs de estado.
UNILOG_DIR = os.getenv(
    "PORTAL_UNILOG_DIR",
    r"C:\Users\v.tozeti\Desktop\Vitor\Logistica\logistica_pharma\unilog",
)
# Ambiente cujo estado o portal lê (o sufixo dos CSVs: *_HOMOLOG.csv / *_PROD.csv).
UNILOG_AMBIENTE = (os.getenv("UNILOG_AMBIENTE", "HOMOLOG") or "HOMOLOG").strip().upper()
