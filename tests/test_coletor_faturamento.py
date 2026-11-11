"""Coletor: uma travada por NF (10/11/2026) e a categoria do alerta de billing. Sem rede, sem SAP.

    python -m unittest tests.test_coletor_faturamento
"""
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("PORTAL_AZURE_BASE", "")
import coletor_azure as c  # noqa: E402


def ev(nf, cod, desc, **kw):
    d = {"id": f"Atacado:{nf}", "nf": nf, "filial": "Atacado", "estado": "travada",
         "problema_codigo": cod, "problema_descricao": desc, "transportadora": "Quality"}
    d.update(kw)
    return d


def alerta_unilog(nf, cod, desc):
    return ev(nf, cod, desc, transportadora="Unilog", operador="Unilog", grupo="UNILOG", problema_categoria="ESTOQUE")


class JuntarMesmaNF(unittest.TestCase):
    def test_sem_saldo_vence_falha_b4you(self):
        out = c._juntar_mesma_nf([
            ev("9483", "B4YOU_FALHA", "Falha no envio da NF para a B4You (status: PENDENTE)", problema_categoria="B4YOU"),
            alerta_unilog("9483", "UNILOG_SEM_SALDO", "item X sem saldo"),
        ])
        self.assertEqual(len(out), 1)
        n = out[0]
        self.assertEqual(n["problema_codigo"], "UNILOG_SEM_SALDO")
        self.assertEqual(n["operador"], "Unilog")
        self.assertEqual(n["transportadora"], "Quality")        # a transportadora real fica
        self.assertNotIn("B4You", n["problema_descricao"])

    def test_boleto_fica_principal_e_junta_a_unilog(self):
        out = c._juntar_mesma_nf([
            ev("9544", "BOLETO_AUSENTE", "Boleto exigido não encontrado + Falha no envio da NF para a B4You (status: PENDENTE)",
               problema_categoria="FINANCEIRO"),
            alerta_unilog("9544", "UNILOG_SEM_SALDO", "item Y sem saldo"),
        ])
        n = out[0]
        self.assertEqual(n["problema_codigo"], "BOLETO_AUSENTE")
        self.assertEqual(n["problema_descricao"], "Boleto exigido não encontrado + item Y sem saldo")
        self.assertEqual(n["operador"], "Unilog")

    def test_frase_nova_da_unilog_tambem_sai(self):   # feed.py do Portal escreve "para a Unilog" desde 11/11
        out = c._juntar_mesma_nf([
            ev("9545", "BOLETO_AUSENTE", "Boleto exigido + Falha no envio da NF para a Unilog (status: PENDENTE)"),
            alerta_unilog("9545", "UNILOG_SEM_SALDO", "item Z sem saldo"),
        ])
        self.assertEqual(out[0]["problema_descricao"], "Boleto exigido + item Z sem saldo")

    def test_sem_unilog_nao_mexe(self):
        a = ev("9538", "BOLETO_AUSENTE", "Boleto + Falha no envio da NF para a B4You (status: PENDENTE)")
        b = ev("9540", "SEFAZ_BARRADA", "Barrada na SEFAZ", grupo="BARRADAS_SAP")
        self.assertEqual(c._juntar_mesma_nf([a, b]), [a, b])

    def test_delta_reenvia_a_juntada_uma_vez(self):
        juntas = c._juntar_mesma_nf([
            ev("9483", "B4YOU_FALHA", "Falha no envio da NF para a B4You"),
            alerta_unilog("9483", "UNILOG_SEM_SALDO", "sem saldo"),
        ])
        antigo = {"Atacado:9483": "travada|UNILOG_SEM_SALDO|0|||"}   # assinatura da versão anterior
        enviados = []
        with mock.patch.object(c, "_montar_estado", return_value=(juntas, [])), \
                mock.patch.object(c, "_espelho_travadas", return_value=None), \
                mock.patch.object(c, "_enviar", side_effect=lambda n: enviados.extend(n) or True):
            pub, _ = c._ciclo(antigo, {"Atacado:9483"})
            self.assertEqual([e["problema_codigo"] for e in enviados], ["UNILOG_SEM_SALDO"])
            enviados.clear()
            c._ciclo(pub, {"Atacado:9483"})
            self.assertEqual(enviados, [])                         # 2º ciclo: nada muda, nada vai


class BillingSemArquivo(unittest.TestCase):
    def rodar(self, detalhe):
        import unilog_feed   # importado aqui: o test_unilog_etapas define PORTAL_UNILOG_ESTADO antes de importar
        agora = time.strftime("%Y-%m-%dT%H:%M:%S")
        dados = {"nfs": {}, "alertas": {"k": {"tipo": "BILLING_SEM_ARQUIVO", "filial": "Varejo", "serial": "19255",
                                              "detalhe": detalhe, "mensagem": "faturamento esperando",
                                              "primeiro": agora, "ultimo": agora}}}
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "estado.json"
            p.write_text(json.dumps(dados), encoding="utf-8")
            try:
                with mock.patch.object(unilog_feed, "ESTADO", str(p)):
                    unilog_feed._cache.update(mtime=None, dados=None)
                    return unilog_feed.coletar_unilog()[0]["problema_categoria"]
            finally:
                unilog_feed._cache.update(mtime=None, dados=None)   # não vaza para os outros testes

    def test_so_boleto_e_financeiro(self):
        self.assertEqual(self.rodar("boleto"), "FINANCEIRO")

    def test_xml_ou_danfe_e_faturamento(self):
        self.assertEqual(self.rodar("XML,DANFE"), "FATURAMENTO")
        self.assertEqual(self.rodar("DANFE,boleto"), "FATURAMENTO")


if __name__ == "__main__":
    unittest.main()
