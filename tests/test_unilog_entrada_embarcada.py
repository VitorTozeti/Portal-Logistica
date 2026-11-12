"""Entrada de transferência já embarcada (12/11/2026): a 19143 (Varejo -> Atacado, saída em 22) estava com
ENTRADA_DIVERGENTE desde 07/11 no e-mail e não aparecia no Portal, porque o feed descartava todo alerta de NF em 21/22
fora de uma lista de cancelamento. A entrada no destino é conferida depois do embarque, e o retorno do cancelamento
depois do 21. Cópia do teste do robô (marcelovzm/logistica_pharma, tests/test_portal_ultimo_ciclo.py::
TestAlertasDepoisDoFim; lá a lista é conferida contra o código do robô). Sem rede.

    python -m unittest tests.test_unilog_entrada_embarcada
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

# os alertas das etapas `entradas` e `retornos` do robô (conferidos no robô por AST)
DO_ROBO = {"ENTRADA_DIVERGENTE", "ENTRADA_COM_ERRO", "ENTRADA_CONFIRMACAO_FALHOU", "ENTRADA_SEM_NF",
           "ENTRADA_CLASSE_DESCONHECIDA", "ENTRADA_POST_FALHOU", "ENTRADA_INCERTA", "ENTRADA_DE_NF_CANCELADA",
           "RETORNO_CONFIRMACAO_FALHOU"}


def _ts(min_atras):
    return (datetime.now() - timedelta(minutes=min_atras)).isoformat(timespec="seconds")


class TestEntradaEmbarcada(unittest.TestCase):
    def _coletar(self, nfs, alertas):
        dados = {"ciclo": {"inicio": _ts(5), "fim": _ts(1), "parcial": [], "anterior": _ts(25)},
                 "nfs": nfs, "alertas": alertas}
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "estado.json"
            p.write_text(json.dumps(dados), encoding="utf-8")
            try:
                with mock.patch.object(unilog_feed, "ESTADO", str(p)):
                    unilog_feed._cache.update(mtime=None, dados=None)
                    return {e["nf"]: e for e in unilog_feed.coletar_unilog()}
            finally:
                unilog_feed._cache.update(mtime=None, dados=None)

    @staticmethod
    def _nf(serial, code, filial="Varejo", **campos):
        return {f"{filial}:{serial}": dict({"filial": filial, "serial": serial, "etapa": "ENVIADO", "status_code": code,
                                            "request_id": "rid", "enviado_em": _ts(9000), "status_desde": _ts(8000)},
                                           **campos)}

    @staticmethod
    def _al(serial, tipo, filial="Varejo", ultimo=2):
        return {f"{tipo}|{filial}|{serial}|": {"tipo": tipo, "filial": filial, "serial": serial, "detalhe": "",
                                                "mensagem": "conferencia da entrada no Atacado diferente da NF",
                                                "primeiro": _ts(7000), "ultimo": _ts(ultimo), "vezes": 156}}

    def test_entrada_divergente_da_transferencia_embarcada_aparece(self):
        nfs = self._nf("19143", "22", tipo="TRANSFERENCIA", destino_filial="Atacado")
        ev = self._coletar(nfs, self._al("19143", "ENTRADA_DIVERGENTE")).get("19143")
        self.assertIsNotNone(ev)
        self.assertEqual(ev["problema_codigo"], "UNILOG_ENTRADA_DIVERGENTE")
        self.assertEqual(ev["problema_categoria"], "TRANSFERENCIA")

    def test_retorno_do_cancelamento_aparece(self):
        out = self._coletar(self._nf("9436", "21", filial="Atacado"),
                            self._al("9436", "RETORNO_CONFIRMACAO_FALHOU", filial="Atacado"))
        self.assertEqual(out["9436"]["problema_codigo"], "UNILOG_RETORNO_CONFIRMACAO_FALHOU")

    def test_alerta_da_saida_na_nf_embarcada_segue_fora(self):
        nfs = self._nf("19143", "22", tipo="TRANSFERENCIA", destino_filial="Atacado")
        self.assertEqual(self._coletar(nfs, self._al("19143", "SEPARACAO_DIVERGENTE")), {})

    def test_entrada_resolvida_sai(self):
        nfs = self._nf("19143", "22", tipo="TRANSFERENCIA", destino_filial="Atacado")
        self.assertEqual(self._coletar(nfs, self._al("19143", "ENTRADA_DIVERGENTE", ultimo=60)), {})

    def test_lista_igual_a_do_robo(self):
        self.assertEqual(DO_ROBO - unilog_feed._ALERTAS_DEPOIS_DO_FIM, set())


if __name__ == "__main__":
    unittest.main()
