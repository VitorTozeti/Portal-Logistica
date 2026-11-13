"""NF de transferência com aviso de estoque vai para Entrada e transferência (13/11/2026, Leo/Marcelo: "O filtro
transferência deveria falar mais alto do que o estoque"). Cópia do teste do robô (pharmaesthetics/logistica_pharma,
tests/test_transferencia_estoque.py). Sem rede.

    python -m unittest tests.test_transferencia_estoque
"""
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("PORTAL_AZURE_BASE", "")
import alertas_texto as at  # noqa: E402
import coletor_azure  # noqa: E402
import unilog_feed  # noqa: E402


def _ts(min_atras):
    return (datetime.now() - timedelta(minutes=min_atras)).isoformat(timespec="seconds")


class TestTransferenciaAcimaDoEstoque(unittest.TestCase):
    def test_catalogo(self):
        self.assertEqual(at.categoria("SEM_SALDO", "", "TRANSFERENCIA"), at.ENTRADA)
        self.assertEqual(at.categoria("SEM_SALDO", "", "VENDA"), at.ESTOQUE)
        self.assertEqual(at.categoria("SEM_EAN", "", "TRANSFERENCIA"), at.CADASTRO)

    def test_19603_no_portal(self):
        a = {"tipo": "SEM_SALDO", "filial": "Varejo", "serial": "19603", "detalhe": "x", "nf_tipo": "TRANSFERENCIA",
             "mensagem": "PR0059 (sem lote): pede 140, a Unilog tem 130 livres", "primeiro": _ts(90), "ultimo": _ts(2)}
        dados = {"nfs": {}, "alertas": {"a": a},
                 "ciclo": {"inicio": _ts(5), "fim": _ts(1), "parcial": [], "anterior": _ts(25)}}
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "estado.json"
            p.write_text(json.dumps(dados), encoding="utf-8")
            try:
                with mock.patch.object(unilog_feed, "ESTADO", str(p)):
                    unilog_feed._cache.update(mtime=None, dados=None)
                    ev = unilog_feed.coletar_unilog()[0]
            finally:
                unilog_feed._cache.update(mtime=None, dados=None)
        self.assertEqual((ev["problema_codigo"], ev["problema_categoria"]), ("UNILOG_SEM_SALDO", at.ENTRADA))
        self.assertIn("pede 140, a Unilog tem 130 livres", ev["problema_descricao"])

    def test_transferencia_do_sap_e_a_principal_em_qualquer_ordem(self):
        sap = {"id": "Varejo:19480", "nf": "19480", "filial": "Varejo", "problema_codigo": "TRANSFERENCIA_ATRASADA",
               "problema_categoria": "TRANSFERENCIA", "problema_descricao": "Transferência Atrasada - B4You/Unilog"}
        uni = {"id": "Varejo:19480", "nf": "19480", "filial": "Varejo", "operador": "Unilog",
               "problema_codigo": "UNILOG_SEM_SALDO", "problema_categoria": at.ENTRADA,
               "problema_descricao": at.descricao([("SEM_SALDO", [("PA0012: pede 25", "")])])}
        for ordem in ([dict(sap), dict(uni)], [dict(uni), dict(sap)]):
            self.assertEqual(coletor_azure._juntar_mesma_nf(ordem)[0]["problema_codigo"], "TRANSFERENCIA_ATRASADA")


if __name__ == "__main__":
    unittest.main()
