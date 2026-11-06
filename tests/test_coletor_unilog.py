"""Coletor -> Azure: os campos da Unilog viajam e o delta nao reenvia a B4You. Sem rede, sem SAP.

    python -m unittest tests.test_coletor_unilog
"""
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("PORTAL_AZURE_BASE", "")
import coletor_azure as c  # noqa: E402

HIST = [{"em": "2026-11-05T14:00:00+00:00", "evento": "STATUS 2 AGUARDANDO_PRODUCAO"}]


def uni(nf, code="2", estado="subiu", **kw):
    return {"id": f"Varejo:{nf}", "nf": nf, "filial": "Varejo", "estado": estado, "operador": "Unilog",
            "unilog_code": code, "unilog_situacao": "Na fila de separação", "unilog_desde": None,
            "unilog_request_id": "rid", "unilog_historico": HIST, **kw}


def b4y(nf):
    return {"id": f"Varejo:{nf}", "nf": nf, "filial": "Varejo", "estado": "subiu"}


class Base(unittest.TestCase):
    def ciclo(self, travadas, subiram, publicado, anteriores=(), espelho=None):
        with mock.patch.object(c, "_montar_estado", return_value=(travadas, subiram)), \
                mock.patch.object(c, "_espelho_travadas", return_value=espelho), \
                mock.patch.object(c, "_enviar", return_value=True) as enviar:
            atual, trav = c._ciclo(publicado, set(anteriores))
        enviadas = enviar.call_args[0][0] if enviar.called else []
        return atual, trav, enviadas


class TestNota(unittest.TestCase):
    def test_campos_unilog_viajam_e_historico_e_lista(self):
        n = c._nota(uni("1"))
        self.assertEqual(n["operador"], "Unilog")
        self.assertEqual(n["unilog_code"], "2")
        self.assertEqual(n["unilog_historico"], HIST)
        self.assertEqual(n["unilog_desde"], "")      # None vira vazio

    def test_nf_b4you_vai_sem_operador_e_com_lista_vazia(self):
        n = c._nota(b4y("2"))
        self.assertEqual(n["operador"], "")
        self.assertEqual(n["unilog_historico"], [])


class TestDelta(Base):
    def test_cache_antigo_republica_so_a_unilog(self):
        _, _, enviadas = self.ciclo([], [uni("1"), b4y("2")], {"Varejo:1": "subiu", "Varejo:2": "subiu"})
        self.assertEqual([n["nf"] for n in enviadas], ["1"])

    def test_mudou_de_situacao_republica(self):
        atual, _, enviadas = self.ciclo([], [uni("1", code="22")], {"Varejo:1": "subiu|2|Na fila de separação"})
        self.assertEqual([n["unilog_code"] for n in enviadas], ["22"])
        self.assertEqual(atual["Varejo:1"], "subiu|22|Na fila de separação")

    def test_mudou_so_o_nome_da_etapa_republica(self):
        # mesmo código 2, mas o Portal passou a mostrar o nome simples: tem de reenviar as que já estavam na Azure
        _, _, enviadas = self.ciclo([], [uni("1")], {"Varejo:1": "subiu|2|Integrada"})
        self.assertEqual([n["unilog_situacao"] for n in enviadas], ["Na fila de separação"])

    def test_sem_mudanca_nao_envia(self):
        _, _, enviadas = self.ciclo([], [uni("1"), b4y("2")], {"Varejo:1": "subiu|2|Na fila de separação", "Varejo:2": "subiu"})
        self.assertEqual(enviadas, [])

    def test_travada_da_unilog_republica_uma_vez_com_operador(self):
        t = uni("1", estado="travada", problema_codigo="BOLETO_AUSENTE")
        atual, _, enviadas = self.ciclo([t], [], {"Varejo:1": "travada|BOLETO_AUSENTE|0"}, ["Varejo:1"])
        self.assertEqual(enviadas[0]["operador"], "Unilog")
        _, _, de_novo = self.ciclo([t], [], atual, ["Varejo:1"])
        self.assertEqual(de_novo, [])

    def test_travada_da_b4you_nao_muda_de_assinatura(self):
        t = {**b4y("2"), "estado": "travada", "problema_codigo": "X"}
        _, _, enviadas = self.ciclo([t], [], {"Varejo:2": "travada|X|0"}, ["Varejo:2"])
        self.assertEqual(enviadas, [])

    def test_reconciliacao_guarda_a_assinatura_da_unilog(self):
        atual, _, enviadas = self.ciclo([], [uni("1")], {"Varejo:1": "subiu|2|Na fila de separação"}, espelho={"Varejo:1": ("Varejo", "1")})
        self.assertEqual(enviadas[0]["operador"], "Unilog")
        self.assertEqual(atual["Varejo:1"], "subiu|2|Na fila de separação")


if __name__ == "__main__":
    unittest.main()
