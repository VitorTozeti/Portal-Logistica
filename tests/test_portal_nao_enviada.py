"""12/11/2026: NF de Varejo/Atacado do corte da Unilog que o robô ainda não mandou aparecia no Portal como "Falha no
envio da NF para a B4You (status: PENDENTE)" (código UNILOG_FALHA na tela). Agora é "Ainda não enviada à Unilog"
(UNILOG_NAO_ENVIADA, Integração); com alerta do robô para a NF, vale o alerta dele. Sem rede, sem SAP.

    python -m unittest tests/test_portal_nao_enviada.py

Mesma versão do teste do robô (logistica_pharma). Desde 12/11/2026 o feed.py daqui é igual ao do robô (textos do log
mestre de alertas_texto.texto_log).
"""
import csv
import json
import os
import sys
import tempfile
import time
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("PORTAL_AZURE_BASE", "")
import alertas_texto as at  # noqa: E402
import coletor_azure as c  # noqa: E402
import faturamento  # noqa: E402
import feed  # noqa: E402
import unilog_feed  # noqa: E402

COLUNAS = ["NF", "Chave", "Carrier", "Data_Processamento", "Requer_Boleto", "Requer_Etiqueta", "Status_Arq_NF",
           "Status_Arq_Boleto", "Status_Arq_Etiqueta", "Envio_B4You_NF", "Envio_B4You_Boleto", "Envio_B4You_Etiqueta",
           "Envio_Email_Transp", "Envio_SFTP_TGT", "Envio_Azure", "Envio_Postagem", "Msg_Erro"]
CORREIOS = feed.CORREIOS_CARRIER


def linha(nf, proc="2026-11-11 15:20:00", **kw):
    """Linha do log mestre de uma NF que o robô copiou (arquivos OK) e que não subiu à B4You (PENDENTE)."""
    r = {"NF": nf, "Chave": "3" * 44, "Carrier": CORREIOS, "Data_Processamento": proc, "Requer_Boleto": "FALSE",
         "Requer_Etiqueta": "TRUE", "Status_Arq_NF": "OK", "Status_Arq_Boleto": "PENDENTE", "Status_Arq_Etiqueta": "OK",
         "Envio_B4You_NF": "PENDENTE", "Envio_B4You_Boleto": "PENDENTE", "Envio_B4You_Etiqueta": "PENDENTE",
         "Envio_Email_Transp": "PENDENTE", "Msg_Erro": ""}
    r.update(kw)
    return r


class Texto(unittest.TestCase):
    def test_frase_categoria_e_quem_faz(self):
        self.assertEqual(at.categoria("NAO_ENVIADA"), at.INTEGRACAO)
        linhas = feed.TEXTO_NAO_ENVIADA.split("\n")
        self.assertEqual(linhas[0], "Ainda não enviada à Unilog.")
        self.assertTrue(linhas[-1].startswith("O que fazer: Logística não precisa agir"), linhas[-1])
        self.assertNotIn("B4You", feed.TEXTO_NAO_ENVIADA)


class Classificar(unittest.TestCase):
    def test_do_corte_sem_envio_e_unilog_nao_b4you(self):
        cod, cat, desc = feed.classificar(linha("9622"), da_unilog=True, unilog_pendente=True)
        self.assertEqual((cod, cat), ("UNILOG_NAO_ENVIADA", "INTEGRACAO"))
        self.assertEqual(desc, feed.TEXTO_NAO_ENVIADA)

    def test_antes_do_corte_segue_a_b4you(self):
        cod, cat, desc = feed.classificar(linha("9000"))
        self.assertEqual(cod, "B4YOU_FALHA")
        self.assertIn("B4You", desc)

    def test_ignorada_pelo_portal_nao_e_cobrada(self):
        ok = {k: "OK" for k in COLUNAS if k.startswith(("Status_", "Envio_"))}
        self.assertIsNone(feed.classificar(linha("9623", Requer_Etiqueta="FALSE", **ok), True, unilog_pendente=True))

    def test_sem_arquivo_fica_so_o_faturamento(self):
        cod, cat, desc = feed.classificar(linha("9624", Status_Arq_NF="Falta XML"), True, unilog_pendente=True)
        self.assertEqual(cod, "XML_2STRIKE")
        self.assertNotIn("Unilog", desc)

    def test_etiqueta_e_nao_enviada_em_paragrafos(self):
        cod, cat, desc = feed.classificar(linha("9625", Status_Arq_Etiqueta="PENDENTE"), True, unilog_pendente=True)
        self.assertEqual(cod, "ETIQUETA_CORREIOS")
        self.assertEqual(desc.split("\n\n"), [at.texto_log("ETIQUETA_CORREIOS"), feed.TEXTO_NAO_ENVIADA])

    def test_do_corte_sem_estado_lido_nao_acusa_nada(self):
        # sem o estado do robô não dá para saber se subiu: nem B4You nem "não enviada" (o Portal mostra UNILOG_SEM_ESTADO)
        self.assertIsNone(feed.classificar(linha("9627"), da_unilog=True, unilog_pendente=False))


class Corte(unittest.TestCase):
    def env(self, desde, ate=""):
        return mock.patch.dict(os.environ, {"UNILOG_FILIAIS_DESDE": desde, "UNILOG_FILIAIS_ATE": ate})

    def test_corte_no_futuro_ou_sem_corte_e_inerte(self):
        with self.env((date.today() + timedelta(days=1)).isoformat()):
            self.assertIsNone(feed._corte_unilog())
        with self.env(""):
            self.assertIsNone(feed._corte_unilog())
        with self.env("2099-12-31"):        # padrão do config_unilog
            self.assertIsNone(feed._corte_unilog())

    def test_docdate_do_sap_vale_sobre_a_data_de_processamento(self):
        corte = ("2026-11-03", None)
        r = linha("9288", proc="2026-11-03 08:00:00")
        self.assertTrue(feed.do_corte_unilog("Atacado", "9288", r, corte, {}))
        self.assertFalse(feed.do_corte_unilog("Atacado", "9288", r, corte, {(4, "9288"): "2026-11-02T00:00:00+00:00"}))
        self.assertFalse(feed.do_corte_unilog("Varejo", "9288", r, corte, {(3, "9288"): "2026-11-02T00:00:00+00:00"}))
        self.assertTrue(feed.do_corte_unilog("Varejo", "9288", r, corte, {(4, "9288"): "2026-11-02T00:00:00+00:00"}))

    def test_volta_para_a_b4you_e_sem_data(self):
        r = linha("9700", proc="2026-12-02 10:00:00")
        self.assertFalse(feed.do_corte_unilog("Atacado", "9700", r, ("2026-11-03", "2026-12-01"), {}))
        self.assertTrue(feed.do_corte_unilog("Atacado", "9700", r, ("2026-11-03", "2026-12-02"), {}))
        self.assertFalse(feed.do_corte_unilog("Atacado", "9701", linha("9701", proc="nan"), ("2026-11-03", None), {}))
        self.assertFalse(feed.do_corte_unilog("Matriz", "9700", r, ("2026-11-03", None), {}))


class ColetarEstado(unittest.TestCase):
    """Log mestre + estado do robô de verdade (arquivos temporários), como o coletor lê no servidor."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.pasta = Path(self.dir.name)
        unilog_feed._cache.update(mtime=None, dados=None)

    def tearDown(self):
        unilog_feed._cache.update(mtime=None, dados=None)
        self.dir.cleanup()

    def log(self, nome, linhas):
        p = self.pasta / f"{nome}.csv"
        with p.open("w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=COLUNAS)
            w.writeheader()
            for r in linhas:
                w.writerow(r)
        return str(p)

    def coletar(self, estado, datas=None, desde="2026-11-03"):
        varejo = self.log("varejo", [linha("19440"), linha("19300", proc="2026-11-05 09:00:00"),
                                     linha("18900", proc="2026-10-30 10:00:00")])
        atacado = self.log("atacado", [linha("9622"), linha("9288", proc="2026-11-03 08:00:00")])
        caminho = self.pasta / "estado.json"
        if estado is not None:
            caminho.write_text(json.dumps(estado), encoding="utf-8")
        with mock.patch.object(feed, "LOGS_MESTRE", {"Varejo": varejo, "Atacado": atacado}), \
                mock.patch.object(unilog_feed, "ESTADO", str(caminho)), \
                mock.patch.dict(os.environ, {"UNILOG_FILIAIS_DESDE": desde, "UNILOG_FILIAIS_ATE": ""}), \
                mock.patch.object(faturamento, "datas", return_value=datas or {}):
            travadas, subiram, _, _ = feed._coletar_estado()
        return {f"{e['filial']}:{e['nf']}": e for e in travadas}, {f"{e['filial']}:{e['nf']}": e for e in subiram}

    def estado(self):
        agora = time.strftime("%Y-%m-%dT%H:%M:%S")
        return {"nfs": {"Varejo:19300": {"filial": "Varejo", "serial": "19300", "status_code": "2", "status_desde": agora,
                                         "request_id": "r1"}},
                "alertas": {}}

    def test_nao_enviada_no_lugar_da_falha_da_b4you(self):
        trav, sub = self.coletar(self.estado(), datas={(4, "9288"): "2026-11-02T00:00:00+00:00"})
        self.assertEqual({k: e["problema_codigo"] for k, e in trav.items()}, {
            "Varejo:19440": "UNILOG_NAO_ENVIADA",      # do corte, fora do estado
            "Atacado:9622": "UNILOG_NAO_ENVIADA",
            "Varejo:18900": "B4YOU_FALHA",             # antes do corte (Data_Processamento): regra da B4You de sempre
            "Atacado:9288": "B4YOU_FALHA",             # DocDate 02/11 no SAP: antes do corte, mesmo processada em 03/11
        })
        n = trav["Atacado:9622"]
        self.assertEqual(n["problema_categoria"], "INTEGRACAO")
        self.assertEqual(n["grupo"], "UNILOG")
        self.assertNotIn("operador", n)              # "operador" = o robô mandou (selo e coluna "Na Unilog")
        self.assertNotIn("B4You", n["problema_descricao"])
        self.assertEqual(sub["Varejo:19300"]["operador"], "Unilog")      # já no estado do robô: segue como antes
        self.assertNotIn("Varejo:19300", trav)

    def test_estado_ilegivel_nao_acusa_as_do_corte(self):
        trav, _ = self.coletar(None)
        self.assertEqual(sorted(trav), ["Varejo:18900"])   # as do corte não viram B4You nem "não enviada"

    def test_sem_corte_tudo_como_antes(self):
        trav, _ = self.coletar(self.estado(), desde="2099-12-31")
        self.assertEqual(trav["Atacado:9622"]["problema_codigo"], "B4YOU_FALHA")


def ev(nf, cod, desc, **kw):
    d = {"id": f"Atacado:{nf}", "nf": nf, "filial": "Atacado", "estado": "travada", "problema_codigo": cod,
         "problema_categoria": "INTEGRACAO", "problema_descricao": desc, "transportadora": "Correios", "grupo": "UNILOG"}
    d.update(kw)
    return d


def alerta_robo(nf, cod, desc):
    return ev(nf, cod, desc, transportadora="Unilog", operador="Unilog", problema_categoria="ESTOQUE")


class JuntarNoColetor(unittest.TestCase):
    def test_alerta_do_robo_vence_a_nao_enviada(self):
        saldo = at.descricao([("SEM_SALDO", [("PR0044-U, lote PL1: pede 10, a Unilog não tem esse lote", "1")])])
        out = c._juntar_mesma_nf([ev("9628", "UNILOG_NAO_ENVIADA", feed.TEXTO_NAO_ENVIADA),
                                  alerta_robo("9628", "UNILOG_SEM_SALDO", saldo)])
        self.assertEqual(len(out), 1)
        n = out[0]
        self.assertEqual(n["problema_codigo"], "UNILOG_SEM_SALDO")
        self.assertEqual(n["problema_descricao"], saldo)
        self.assertEqual(n["transportadora"], "Correios")       # a transportadora real fica

    def test_outra_causa_do_log_fica(self):
        desc = feed.TEXTO_NAO_ENVIADA + "\n\nFalha no envio do e-mail para SulCargo"
        sem_ean = at.descricao([("SEM_EAN", [("CS00000019: sem EAN no SAP", "")])])
        n = c._juntar_mesma_nf([ev("9629", "UNILOG_NAO_ENVIADA", desc), alerta_robo("9629", "UNILOG_SEM_EAN", sem_ean)])[0]
        self.assertEqual(n["problema_codigo"], "UNILOG_SEM_EAN")
        self.assertEqual(n["problema_descricao"], sem_ean + "\n\nFalha no envio do e-mail para SulCargo")

    def test_etiqueta_do_log_e_alerta_do_robo(self):
        desc = "Etiqueta Correios não gerada (corrigir cadastro do cliente no SAP)\n\n" + feed.TEXTO_NAO_ENVIADA
        etq = at.descricao([("ETIQUETA_PENDENTE", [("", "")])])
        n = c._juntar_mesma_nf([ev("9630", "ETIQUETA_CORREIOS", desc, problema_categoria="CORREIOS"),
                                alerta_robo("9630", "UNILOG_ETIQUETA_PENDENTE", etq)])[0]
        self.assertEqual(n["problema_codigo"], "ETIQUETA_CORREIOS")
        self.assertNotIn("Ainda não enviada", n["problema_descricao"])
        self.assertIn(etq, n["problema_descricao"])

    def test_sem_alerta_do_robo_a_nao_enviada_fica(self):
        sap = ev("9631", "TRANSFERENCIA_ATRASADA", "Transferência Atrasada - B4You/Unilog", problema_categoria="TRANSFERENCIA")
        n = c._juntar_mesma_nf([ev("9631", "UNILOG_NAO_ENVIADA", feed.TEXTO_NAO_ENVIADA), sap])[0]
        self.assertEqual(n["problema_codigo"], "TRANSFERENCIA_ATRASADA")
        self.assertEqual(n["problema_descricao"], "Transferência Atrasada - B4You/Unilog\n\n" + feed.TEXTO_NAO_ENVIADA)

    def test_nota_vai_ao_espelho_com_o_texto_novo(self):
        nota = c._nota(ev("9622", "UNILOG_NAO_ENVIADA", feed.TEXTO_NAO_ENVIADA))
        self.assertEqual((nota["problema_codigo"], nota["problema_categoria"], nota["grupo"], nota["operador"]),
                         ("UNILOG_NAO_ENVIADA", "INTEGRACAO", "UNILOG", ""))


class FaturamentoEspera(unittest.TestCase):
    def test_hana_fora_nao_tenta_duas_vezes_no_mesmo_ciclo(self):
        chamadas = []

        def falha():
            chamadas.append(1)
            raise OSError("porta recusada")

        antigo = dict(faturamento._cache)
        try:
            faturamento._cache.update(quando=0.0, mapa={}, falhou=0.0)
            with mock.patch.dict(faturamento.HANA, {"user": "u", "password": "p"}), \
                    mock.patch.object(faturamento, "_carregar", side_effect=falha):
                self.assertEqual(faturamento.datas(), {})
                self.assertEqual(faturamento.datas(), {})       # feed e enriquecer no mesmo ciclo: uma tentativa só
            self.assertEqual(len(chamadas), 1)
        finally:
            faturamento._cache.clear()
            faturamento._cache.update(antigo)


if __name__ == "__main__":
    unittest.main()
