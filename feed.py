"""
feed.py — a FONTE REAL do estado das NFs (versão B4You).

Lê os logs mestre de PRODUÇÃO que o robô de expedição gera
(`controle_pedidos_mestre.csv`, um por filial) e classifica cada NF com a MESMA
lógica do robô (`log_handler.gerar_excel_validacao`, log_handler.py:349-443).
Publica o estado no hub e re-lê periodicamente, empurrando só as mudanças.

100% real: nada é sorteado — os números de NF, transportadora e problema saem
do arquivo que a logística usa hoje.

⚠️ Cobre o MOTOR 2 (falhas de etapa no log mestre). As "barradas na SEFAZ" que
nunca entram no log (MOTOR 1, auditoria SAP) exigem conexão HANA — próximo passo.
Detalhe dos motores: nota portal-logistica-nfs-problema no vault.
"""
import asyncio
import csv
import errno
import os
from datetime import datetime, timezone
from pathlib import Path

from hub import hub


class FonteIndisponivel(Exception):
    """A fonte (log mestre) NÃO pôde ser LIDA por erro de ACESSO/rede — não é o
    mesmo que 'arquivo ausente'. Casos: senha da conta do servidor expirada
    (WinError 1330), credencial inválida (1326), share/servidor fora do ar
    (53/64/67), permissão negada (5/EACCES). Quando isto acontece o portal NÃO
    pode tratar como 'sem dados' (isso zeraria o quadro e mostraria tudo como
    resolvido) — tem que CONGELAR o último estado e sinalizar 'não atualizei'."""

    def __init__(self, caminho: str, erro: Exception):
        self.caminho = caminho
        self.erro = erro
        super().__init__(f"{caminho}: {erro}")


# WinError que significam "não consegui ACESSAR" (≠ "não existe"): senha expirada
# (1330), logon inválido (1326/1331), acesso negado (5), share/servidor fora
# (53 caminho de rede, 64 nome de rede indisponível, 67 nome de rede não achado),
# credencial já em uso/conflito (1219). ENOENT/arquivo-ausente NÃO entra aqui.
_WINERR_ACESSO = {5, 53, 64, 67, 1219, 1326, 1330, 1331}


def _e_erro_de_acesso(e: OSError) -> bool:
    we = getattr(e, "winerror", None)
    if we in _WINERR_ACESSO:
        return True
    return e.errno in (errno.EACCES, errno.EPERM)

# --- Fonte real (PROD). Override por env se precisar apontar para outra pasta. ---
LOGS_MESTRE = {
    "Varejo":  os.getenv("PORTAL_LOG_VAREJO",  r"O:\Logística\0 - B4YOU\Varejo\controle_pedidos_mestre.csv"),
    "Atacado": os.getenv("PORTAL_LOG_ATACADO", r"O:\Logística\0 - B4YOU\Atacado\controle_pedidos_mestre.csv"),
}
POLL_SEGUNDOS = int(os.getenv("PORTAL_POLL_SEGUNDOS", "20"))
MAX_SUBIRAM = int(os.getenv("PORTAL_MAX_SUBIRAM", "50000"))  # teto alto: mostra TODAS as NFs "OK" do ano (front pagina em blocos)
ANO_SUBIRAM = int(os.getenv("PORTAL_ANO_SUBIRAM", "0"))      # 0 = ano corrente; ex.: 2026 fixa o ano. Só entram "subiram" desse ano.

# Constantes espelhadas do config.py do robô (config.py:40,144,216-225).
CORREIOS_CARRIER = "F0002251"
CODIGO_TGT = "F0002755"
CARRIER_NOMES = {
    "F0002251": "Correios", "F0002755": "TGT", "F0003888": "ACERTA EXPRESS",
    "F0003998": "VIP Cargas Aéreas", "F0002315": "SulCargo", "F0002173": "JAMEF",
    "F0003345": "Quality",
}


def _nome_transp(cod: str) -> str:
    return CARRIER_NOMES.get((cod or "").strip(), cod or "—")


def classificar(r: dict):
    """
    Replica gerar_excel_validacao (log_handler.py:349-443).
    Retorna (codigo, categoria, descricao) do problema, ou None se a NF está OK.
    Um problema pode ter várias causas; junta todas na descrição e usa a 1ª como código.
    """
    if r.get("Envio_B4You_NF") == "CANCELADO":
        return "CANCELADO"  # sinaliza para pular

    problemas = []  # (codigo, categoria, texto)
    status_nf = str(r.get("Status_Arq_NF", ""))

    if status_nf != "OK":
        if "Falta XML" in status_nf and "Falta PDF" in status_nf:
            problemas.append(("XML_2STRIKE", "FATURAMENTO", "XML e PDF não encontrados na pasta de rede (2ª tentativa)"))
        elif "Falta XML" in status_nf:
            problemas.append(("XML_2STRIKE", "FATURAMENTO", "XML não encontrado na pasta de rede (2ª tentativa)"))
        elif "Falta PDF" in status_nf:
            problemas.append(("PDF_2STRIKE", "FATURAMENTO", "PDF não encontrado na pasta de rede (2ª tentativa)"))
        else:
            problemas.append(("ARQUIVO_IO", "ARQUIVOS", f"Erro ao copiar arquivos: {status_nf}"))

    if r.get("Requer_Etiqueta") == "TRUE" and r.get("Status_Arq_Etiqueta") != "OK":
        problemas.append(("ETIQUETA_CORREIOS", "CORREIOS", "Etiqueta Correios não gerada (corrigir cadastro do cliente no SAP)"))

    if r.get("Requer_Boleto") == "TRUE" and r.get("Status_Arq_Boleto") != "OK":
        problemas.append(("BOLETO_AUSENTE", "FINANCEIRO", "Boleto exigido não encontrado na pasta de rede"))

    if status_nf == "OK":
        env_nf = r.get("Envio_B4You_NF")
        if env_nf != "OK":
            if env_nf in ("BLOQUEADO_SALDO", "Bloqueado Saldo"):
                problemas.append(("B4YOU_SALDO", "B4YOU", "Sem saldo/estoque na B4You — reenvia quando o estoque entrar"))
            elif env_nf == "BLOQUEADO_CADASTRO":
                problemas.append(("B4YOU_CADASTRO", "B4YOU", "Item não cadastrado no catálogo da B4You"))
            elif env_nf == "BLOQUEADO_DUPLICIDADE":
                problemas.append(("B4YOU_DUPLICIDADE", "B4YOU", "B4You respondeu 'já existe' mas o pedido não foi encontrado"))
            else:
                problemas.append(("B4YOU_FALHA", "B4YOU", f"Falha no envio da NF para a B4You (status: {env_nf})"))
        else:
            if r.get("Requer_Boleto") == "TRUE" and r.get("Status_Arq_Boleto") == "OK" and r.get("Envio_B4You_Boleto") != "OK":
                problemas.append(("B4YOU_ANEXO_BOLETO", "B4YOU", f"Falha ao enviar o Boleto para a B4You (status: {r.get('Envio_B4You_Boleto')})"))
            if r.get("Requer_Etiqueta") == "TRUE" and r.get("Status_Arq_Etiqueta") == "OK" and r.get("Envio_B4You_Etiqueta") != "OK":
                problemas.append(("B4YOU_ANEXO_ETIQUETA", "B4YOU", f"Falha ao enviar a Etiqueta para a B4You (status: {r.get('Envio_B4You_Etiqueta')})"))

    carrier = str(r.get("Carrier", "")).strip()
    if carrier and carrier != CORREIOS_CARRIER and carrier != CODIGO_TGT and status_nf == "OK":
        if r.get("Envio_Email_Transp") != "OK":
            if not carrier or carrier.lower() == "nan":
                problemas.append(("TRANSP_NAO_INFORMADA", "TRANSPORTADORA", "Código da transportadora não informado na NF (verificar SAP)"))
            elif carrier not in CARRIER_NOMES:
                problemas.append(("TRANSP_INVALIDA", "TRANSPORTADORA", f"Código '{carrier}' não reconhecido — provável erro de digitação no SAP"))
            else:
                problemas.append(("EMAIL_TRANSP_FALHA", "TRANSPORTADORA", f"Falha no envio do e-mail para {_nome_transp(carrier)}"))

    if not problemas:
        return None
    cod, cat, _ = problemas[0]
    return (cod, cat, " + ".join(p[2] for p in problemas))


def _iso(data_proc: str) -> str:
    """'2026-03-05 15:23:17' -> ISO com timezone (para o front calcular 'há quanto tempo')."""
    try:
        dt = datetime.strptime(data_proc.strip(), "%Y-%m-%d %H:%M:%S")
        return dt.replace(tzinfo=timezone.utc).isoformat()
    except Exception:
        return datetime.now(timezone.utc).isoformat()


def _ler_csv(caminho: str):
    """Lê um log mestre. Distingue os dois mundos que ANTES caíam no mesmo `[]`:
      - arquivo genuinamente AUSENTE  -> [] (normal: robô ainda não gerou a linha)
      - erro de ACESSO/rede           -> levanta FonteIndisponivel (senha do
        servidor expirada, VPN caída, share fora) — o chamador CONGELA o estado.
    Em Python 3.8+ o `Path.exists()` sobre um UNC com credencial expirada LEVANTA
    OSError(1330) (não devolve False), então o try abaixo captura o caso real."""
    p = Path(caminho)
    try:
        existe = p.exists()
    except OSError as e:
        if _e_erro_de_acesso(e):
            raise FonteIndisponivel(caminho, e) from e
        print(f"  [FEED] erro ao checar {caminho}: {e}")
        return []
    if not existe:
        print(f"  [FEED] log mestre não encontrado: {caminho}")
        return []
    for enc in ("utf-8-sig", "latin-1"):
        try:
            with p.open("r", encoding=enc, newline="") as f:
                return list(csv.DictReader(f))
        except (UnicodeDecodeError, UnicodeError):
            continue
        except OSError as e:
            if _e_erro_de_acesso(e):
                raise FonteIndisponivel(caminho, e) from e
            print(f"  [FEED] erro lendo {caminho}: {e}")
            return []
        except Exception as e:
            print(f"  [FEED] erro lendo {caminho}: {e}")
            return []
    return []


def _limpar_nf(v: str) -> str:
    try:
        return str(int(v))
    except (ValueError, TypeError):
        return str(v or "").strip().lstrip("0")


def _coletar_estado():
    """Lê os dois logs e devolve (travadas, subiram, nfs_no_log, log_index) já classificados."""
    travadas, ok_rows, nfs_no_log, log_index = [], [], set(), {}
    for filial, caminho in LOGS_MESTRE.items():
        for r in _ler_csv(caminho):
            carrier = str(r.get("Carrier", "")).strip()
            nf = str(r.get("NF", "")).strip()
            if nf:
                nfs_no_log.add(nf)
                try:
                    nfs_no_log.add(str(int(nf)))
                except ValueError:
                    pass
                # index POR FILIAL p/ o diagnóstico de cancelamento (inclui HISTORICO — ex.: NF 268).
                # Por filial porque o nº da NF colide entre Varejo/Atacado (séries independentes).
                log_index.setdefault(filial, {})[_limpar_nf(nf)] = {
                    "status": str(r.get("Envio_B4You_NF", "") or ""),
                    "carrier": carrier,
                }
            if carrier == "HISTORICO":
                continue  # carga inicial manual, não entra como operação
            if not nf:
                continue
            res = classificar(r)
            if res == "CANCELADO":
                continue
            # "ignorada" de verdade = SÓ quando a Chave é IGNORADO (marca única do ignorar_notas.py
            # ao criar a linha do zero). "Dispensado Manualmente" no Msg_Erro NÃO conta — pega carga
            # histórica e dispensas de boleto/etc. que não são ignore operacional. (decisão do gestor)
            ignorada = str(r.get("Chave", "")).strip().upper() == "IGNORADO"
            base = {
                "nf": nf, "filial": filial,
                "transportadora": _nome_transp(carrier),
                "atualizado_em": _iso(str(r.get("Data_Processamento", ""))),
                "ignorada": ignorada,
            }
            if res is None:
                ok_rows.append({**base, "estado": "subiu",
                                "_ord": str(r.get("Data_Processamento", ""))})
            else:
                cod, cat, desc = res
                travadas.append({**base, "estado": "travada",
                                 "problema_codigo": cod, "problema_categoria": cat,
                                 "problema_descricao": desc,
                                 "travada_desde": _iso(str(r.get("Data_Processamento", "")))})
    # subiram: TODAS as NFs "OK" do ano (mais recentes primeiro), teto alto só como guarda
    ano_alvo = str(ANO_SUBIRAM or datetime.now().year)
    ok_rows = [x for x in ok_rows if str(x["_ord"])[:4] == ano_alvo]
    ok_rows.sort(key=lambda x: x["_ord"], reverse=True)
    subiram = [{k: v for k, v in x.items() if k != "_ord"} for x in ok_rows[:MAX_SUBIRAM]]
    return travadas, subiram, nfs_no_log, log_index


# --- Saúde da fonte (para o front mostrar "não consegui atualizar as NFs") ---
# Estado de saúde publicado no hub sob o id fixo "__saude__". O front trata esse
# evento como banner (não como card). Publicamos SÓ na virada (ok<->falha) para não
# gerar delta a cada ciclo, + um evento inicial para o snapshot nunca ficar sem saúde.
_saude = {"fonte_ok": None, "ultima_ok": None}  # fonte_ok None = ainda não avaliado


def _iso_agora() -> str:
    return datetime.now(timezone.utc).isoformat()


def _marcar_saude(ok: bool, fi: "FonteIndisponivel | None" = None) -> None:
    mudou = ok != _saude["fonte_ok"]
    if ok:
        _saude["ultima_ok"] = _iso_agora()
    _saude["fonte_ok"] = ok
    if not mudou:
        return  # sem virada → não repete o evento
    if ok:
        hub.publicar({"id": "__saude__", "estado": "saude", "fonte_ok": True,
                      "ultima_ok": _saude["ultima_ok"]})
    else:
        hub.publicar({"id": "__saude__", "estado": "saude", "fonte_ok": False,
                      "erro": str(fi), "caminho": getattr(fi, "caminho", ""),
                      "ultima_ok": _saude["ultima_ok"]})


async def rodar_feed_simulado() -> None:
    """Nome mantido por compatibilidade com app.py; agora lê dados REAIS."""
    publicado: dict[str, str] = {}  # nf -> assinatura, para publicar só mudanças

    travadas_anteriores: set = set()  # ids (filial:nf) travados no ciclo anterior
    while True:
        try:
            # A COLETA vem primeiro e num try próprio: se a fonte estiver inacessível
            # (senha do servidor expirada etc.), CONGELAMOS o quadro — nada de zerar/
            # marcar tudo como resolvido — e sinalizamos "não atualizei" ao front.
            try:
                travadas, subiram, nfs_no_log, log_index = await asyncio.to_thread(_coletar_estado)
            except FonteIndisponivel as fi:
                _marcar_saude(False, fi)
                print(f"  [FEED] FONTE INDISPONÍVEL — mantendo o último estado (sem zerar): {fi}", flush=True)
                await asyncio.sleep(POLL_SEGUNDOS)
                continue
            _marcar_saude(True)

            barradas, marketing, cancelamentos = [], [], []
            try:
                import sap_feed
                barradas = await asyncio.to_thread(sap_feed.coletar_barradas, nfs_no_log)
            except Exception as e:
                print(f"  [FEED] Motor 1 (SAP) indisponível: {e}", flush=True)
            try:
                import marketing_feed
                marketing = await asyncio.to_thread(marketing_feed.coletar_marketing)
            except Exception as e:
                print(f"  [FEED] Marketing indisponível: {e}", flush=True)
            try:
                import canc_feed
                cancelamentos = await asyncio.to_thread(canc_feed.coletar_cancelamentos, log_index)
            except Exception as e:
                print(f"  [FEED] Cancelamento indisponível: {e}", flush=True)

            # Identidade composta filial:nf — NFs iguais de filiais diferentes NÃO colidem.
            todas_travadas = travadas + barradas + marketing + cancelamentos
            for ev in todas_travadas + subiram:
                ev["id"] = f"{ev.get('filial','?')}:{ev['nf']}"

            # ações do portal: NFs marcadas ignorada/tratada somem da lista de travadas
            import acoes
            ocultas = acoes.ids_ocultos()
            if ocultas:
                todas_travadas = [ev for ev in todas_travadas if ev["id"] not in ocultas]

            atual = {}
            # 1) publica travadas novas/alteradas
            travadas_atuais = set()
            for ev in todas_travadas:
                travadas_atuais.add(ev["id"])
                assinatura = f"{ev['estado']}|{ev.get('problema_codigo','')}"
                atual[ev["id"]] = assinatura
                if publicado.get(ev["id"]) != assinatura:
                    hub.publicar(ev)

            # 2) RESOLVIDAS: estavam travadas antes e não estão mais → somem da tela
            for id_antigo in travadas_anteriores - travadas_atuais:
                filial, _, nf = id_antigo.partition(":")
                hub.publicar({"id": id_antigo, "nf": nf, "filial": filial, "estado": "resolvida"})

            # 3) subiram recentes
            for ev in subiram:
                atual[ev["id"]] = "subiu"
                if publicado.get(ev["id"]) != "subiu":
                    hub.publicar(ev)

            publicado = atual
            travadas_anteriores = travadas_atuais
            print(f"  [FEED] {len(barradas)} barradas · {len(marketing)} mkt · {len(cancelamentos)} canc · {len(travadas)} log · {len(subiram)} subiram (real)", flush=True)
        except Exception as e:
            print(f"  [FEED] falha no ciclo: {e}", flush=True)
        await asyncio.sleep(POLL_SEGUNDOS)
