"""static/nomes-alertas.js tem que ser o gerado do alertas_texto.py (tools/gerar_nomes_alertas.py). Sem rede.

    python -B tests/test_nomes_alertas.py
"""
import sys
import unittest
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ))

import alertas_texto  # noqa: E402


class NomesAlertas(unittest.TestCase):
    def test_arquivo_gerado_esta_em_dia(self):
        atual = (RAIZ / "static" / "nomes-alertas.js").read_bytes().decode("utf-8").replace("\r\n", "\n")   # checkout CRLF
        self.assertEqual(atual, alertas_texto.nomes_js(), "rode: python -B tools/gerar_nomes_alertas.py")

    def test_monitor_carrega_o_arquivo(self):
        html = (RAIZ / "static" / "monitor.html").read_text(encoding="utf-8")
        self.assertIn('src="./nomes-alertas.js', html)

    def test_caso_do_marcelo(self):
        self.assertEqual(alertas_texto.nome_codigo("PDF_2STRIKE"), "Falta DANFE")


if __name__ == "__main__":
    unittest.main()
