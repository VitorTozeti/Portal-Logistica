"""Nomes simples das etapas da Unilog (selo da NF e colunas do Detalhar). Sem rede.

    python -m unittest tests.test_unilog_etapas
"""
import json
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ))

TMP = tempfile.TemporaryDirectory()
ARQ = Path(TMP.name) / "estado.json"
os.environ["PORTAL_UNILOG_ESTADO"] = str(ARQ)
import unilog_feed as u  # noqa: E402


def estado(*regs):
    ARQ.write_text(json.dumps({"nfs": {f"Varejo:{i}": {"filial": "Varejo", "serial": str(i), **r} for i, r in enumerate(regs, 1)}}),
                   encoding="utf-8")
    u._cache.update(mtime=None, dados=None)


class TestEtapas(unittest.TestCase):
    def test_nomes_da_unilog_viram_nomes_simples(self):
        casos = {("2", "IMPORTADO"): "Pedido recebido", ("2", "AGUARDANDO_PRODUCAO"): "Na fila de separação",
                 ("2", "EM_PRODUCAO_ONDA"): "Em separação", ("2", "PEDIDO_SEM_SALDO"): "Sem estoque na Unilog",
                 ("4", "CHECK_OUT_FINALIZADO"): "Separação conferida", ("4", "AGUARDANDO_ROTEIRIZACAO"): "Aguardando rota",
                 ("4", "REIMPRESSAO_ETIQUETA"): "Aguardando rota", ("4", "AGUARDANDO_EMBARQUE"): "Pronto para coleta",
                 ("22", "EMBARCADO"): "Embarcada", ("22", "EMBARCADO (planilha da Unilog)"): "Embarcada",
                 ("", ""): "Enviada à Unilog", ("21", "CANCELADO"): "Cancelada"}
        for (code, desc), nome in casos.items():
            self.assertEqual(u.etapa_simples(code, desc), nome, (code, desc))

    def test_sem_nome_cai_no_codigo_e_nome_novo_nao_some(self):
        self.assertEqual(u.etapa_simples("2", None), "Integrada")
        self.assertEqual(u.etapa_simples("22", ""), "Embarcada")
        self.assertEqual(u.etapa_simples("2", "ETAPA_NOVA"), "Integrada")   # código manda; o robô já alerta nome fora da lista
        self.assertEqual(u.etapa_simples("", "ETAPA_NOVA"), "ETAPA_NOVA")

    def test_situacoes_usa_o_nome_simples_e_recusada_continua(self):
        estado({"status_code": "2", "status_desc": "EM_PRODUCAO_ONDA", "request_id": "r"},
               {"etapa": "RECUSADO", "status_code": "2", "status_desc": "x"},
               {"status_code": "22", "status_desc": "EMBARCADO (planilha da Unilog)", "request_id": "r"})
        s = u.situacoes()["Varejo"]
        self.assertEqual([s[k]["nome"] for k in ("1", "2", "3")], ["Em separação", "Recusada", "Embarcada"])

    def test_todo_nome_simples_tem_coluna_no_monitor(self):
        html = (RAIZ / "static" / "monitor.html").read_text(encoding="utf-8")
        bloco = html[html.index("const FASES_UNILOG"):html.index("const PASSO_FLUXO")]
        colunas = set(re.findall(r'nome:"([^"]+)"', bloco))
        esperados = set(u.ETAPA_SIMPLES.values()) - {"Cancelada"}   # cancelada nunca chega a "subiu"
        self.assertEqual(esperados - colunas, set())


if __name__ == "__main__":
    unittest.main()
