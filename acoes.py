"""
acoes.py — estado local das AÇÕES do portal (Fase 0): ocultar uma NF da lista de
travadas (ignorar / marcar tratada) e reativar.

Fase 0 = persistência simples num JSON local (`estado_portal.json`). Na Fase 1 isso
migra para a tabela `nfsportal` na Storage Account `stescolhasfrete` (ver PLANEJAMENTO.md).

⚠️ NÃO altera a NF nem o SAP/B4You — é só um estado do portal que some a nota da tela.
A chave é sempre o `id` composto `filial:nf` (o número da NF colide entre Varejo/Atacado).
"""
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock

ARQUIVO = Path(os.getenv("PORTAL_ESTADO_JSON", "estado_portal.json"))
TIPOS_VALIDOS = ("ignorada", "tratada")

_lock = Lock()
_OCULTAS: dict[str, dict] = {}  # id -> {tipo, motivo, nf, filial, em}


def _carregar() -> None:
    global _OCULTAS
    if ARQUIVO.exists():
        try:
            _OCULTAS = json.loads(ARQUIVO.read_text(encoding="utf-8")).get("ocultas", {})
        except Exception as e:
            print(f"  [ACOES] falha lendo {ARQUIVO}: {e}", flush=True)
            _OCULTAS = {}


def _salvar() -> None:
    try:
        ARQUIVO.write_text(json.dumps({"ocultas": _OCULTAS}, ensure_ascii=False, indent=2),
                           encoding="utf-8")
    except Exception as e:
        print(f"  [ACOES] falha salvando {ARQUIVO}: {e}", flush=True)


def ids_ocultos() -> set:
    """Ids (filial:nf) que devem sumir da lista de travadas."""
    return set(_OCULTAS.keys())


def ocultar(id_nf: str, tipo: str, motivo: str = "", nf: str = "", filial: str = "") -> dict:
    """Marca uma NF como ignorada/tratada — some da tela e não volta até reativar."""
    tipo = tipo if tipo in TIPOS_VALIDOS else "ignorada"
    with _lock:
        registro = {
            "tipo": tipo, "motivo": (motivo or "").strip(),
            "nf": nf, "filial": filial,
            "em": datetime.now(timezone.utc).isoformat(),
        }
        _OCULTAS[id_nf] = registro
        _salvar()
    return registro


def reativar(id_nf: str) -> bool:
    """Traz a NF de volta para a lista de travadas (próximo ciclo do feed a republica)."""
    with _lock:
        existia = _OCULTAS.pop(id_nf, None) is not None
        if existia:
            _salvar()
    return existia


def listar() -> list[dict]:
    """Lista as ocultas (para o painel 'ver ocultas' do front)."""
    return [{"id": k, **v} for k, v in sorted(_OCULTAS.items())]


_carregar()
