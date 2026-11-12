"""Gera static/nomes-alertas.js (nome curto da etiqueta do card, no lugar do problema_codigo) a partir do alertas_texto.py.

A fonte é o alertas_texto.py do robô (logistica_pharma); a cópia da raiz deste repo é a mesma versão. A Azure descarta campo
novo no espelho, então o nome não viaja com a NF: o Monitor lê este arquivo. Rodar sempre que o alertas_texto.py mudar:

    python -B tools/gerar_nomes_alertas.py

O teste tests/test_nomes_alertas.py falha se o arquivo estiver desatualizado.
"""
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ))

import alertas_texto  # noqa: E402

DESTINO = RAIZ / "static" / "nomes-alertas.js"

if __name__ == "__main__":
    with open(DESTINO, "w", encoding="utf-8", newline="\n") as f:
        f.write(alertas_texto.nomes_js())
    print(f"{DESTINO.relative_to(RAIZ)}: {len(alertas_texto.nomes())} nomes")
