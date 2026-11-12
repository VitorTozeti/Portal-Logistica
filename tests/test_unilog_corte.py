"""Corte dos alertas da Unilog com a fatura em falha (12/11/2026): 19444, 19451 e 19454 seguiam em "Falta DANFE" no
Portal já enviadas, porque todo ciclo fechava com parcial = ['faturar:UNILOG_INDISPONIVEL'] e o corte usava o `anterior`
parado nas 14:47. Cópia do teste do robô (marcelovzm/logistica_pharma, tests/test_portal_ultimo_ciclo.py). Sem rede.

    python -m unittest tests.test_unilog_corte
"""
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import unilog_feed  # noqa: E402


def _ts(min_atras):
    return (datetime.now() - timedelta(minutes=min_atras)).isoformat(timespec="seconds")


def _alerta(serial, min_atras, tipo):
    return {"tipo": tipo, "filial": "Varejo", "serial": serial, "mensagem": "", "primeiro": _ts(600),
            "ultimo": _ts(min_atras)}


class TestCorte(unittest.TestCase):
    def _coletar(self, dados):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "estado.json"
            p.write_text(json.dumps(dados), encoding="utf-8")
            try:
                with mock.patch.object(unilog_feed, "ESTADO", str(p)):
                    unilog_feed._cache.update(mtime=None, dados=None)
                    return sorted(e["nf"] for e in unilog_feed.coletar_unilog())
            finally:
                unilog_feed._cache.update(mtime=None, dados=None)

    def _estado(self, parcial, nfs=None):
        return {"ciclo": {"inicio": _ts(5), "fim": _ts(1), "parcial": parcial, "anterior": _ts(25)}, "nfs": nfs or {},
                "alertas": {"a": _alerta("19300", 2, "SEM_SALDO"), "b": _alerta("19444", 20, "PEDIDO_SEM_ARQUIVO"),
                            "c": _alerta("19445", 20, "BILLING_ERRO")}}

    def test_fatura_em_falha_tolera_so_a_fatura(self):
        self.assertEqual(self._coletar(self._estado(["faturar:UNILOG_INDISPONIVEL"])), ["19300", "19445"])

    def test_outra_etapa_em_falha_tolera_todos(self):
        self.assertEqual(self._coletar(self._estado(["acompanhar:UNILOG_INDISPONIVEL"])), ["19300", "19444", "19445"])

    def test_pedido_aceito_depois_do_aviso(self):
        reg = {"filial": "Varejo", "serial": "19444", "etapa": "ENVIADO", "status_code": "2", "request_id": "rid",
               "enviado_em": _ts(10), "status_desde": _ts(10)}
        self.assertEqual(self._coletar(self._estado(["acompanhar:UNILOG_INDISPONIVEL"], {"Varejo:19444": reg})),
                         ["19300", "19445"])


if __name__ == "__main__":
    unittest.main()
