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

    def test_pontos_de_atencao_fora_das_travadas(self):
        """12/11/2026: pedido demorando na Unilog fica num bloco próprio, com a categoria e a frase do catálogo do robô."""
        js = (RAIZ / "static" / "nomes-alertas.js").read_bytes().decode("utf-8")
        self.assertIn('window.ALERTA_ATENCAO = {"categoria": "ATENCAO"', js)
        self.assertIn(alertas_texto.TEXTO_ATENCAO, js)
        html = (RAIZ / "static" / "monitor.html").read_text(encoding="utf-8")
        self.assertIn('id="atencao"', html)
        self.assertIn("&& (mostrarOcultas || !ehAtencao(n))", html)          # fora da lista e do contador de Travadas
        self.assertIn("!ocultas.has(n.id) && !ehAtencao(n)).length", html)    # fora do "travadas, fora do fluxo"
        for tipo in ("PARADO_EM_2", "PARADO", "AGUARDA_EMBARQUE"):
            self.assertEqual(alertas_texto.categoria(tipo), alertas_texto.ATENCAO)


if __name__ == "__main__":
    unittest.main()
