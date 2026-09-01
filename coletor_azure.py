"""
coletor_azure.py — o COLETOR on-prem do Portal da Logística.

Roda DENTRO da rede Pharma (candidato: máquina do robô OTIF — enxerga o drive
`O:`, o SAP HANA e o `.env`). Lê as MESMAS fontes do portal local (`feed.py` +
os 3 motores `sap_feed`/`marketing_feed`/`canc_feed`) e, em vez de publicar no
hub local, dá **POST do estado das NFs** para o endpoint da Azure
(`/v1/portal/nfs`) exposto pelo container `ca-calculadora-frete`. O front no
GitHub Pages lê o espelho de lá (`GET /v1/portal/nfs`).

É a metade "de dentro" da ponte dos 2 mundos: só faz chamada de **SAÍDA
(HTTPS)** — nada entra na rede. Best-effort: uma falha de rede/API não derruba
o processo; o ciclo seguinte tenta de novo (o estado só é dado como "publicado"
quando o POST confirma).

Contrato do endpoint (confirmado com a sessão do azure-calc em 31/08):
  POST /v1/portal/nfs   body = {"nfs": [ {nota}, ... ]}
    nota: nf (obrigatório) + filial, estado, transportadora, atualizado_em,
          ignorada, problema_codigo, problema_categoria, problema_descricao,
          travada_desde, grupo   (campos extras são ignorados pelo servidor)
    - estado ∈ "subiu" | "travada" | "resolvida"  (resolvida = DELETE da linha)
    - PartitionKey = filial, RowKey = nf  → SEMPRE mandar `filial`
    - upsert REPLACE: mandar o snapshot mantém o espelho consistente
      (travada→subiu zera os campos problema_* sozinho)
  Auth: HTTP Basic (USER_ID/SENHA do container).
  Rate limit: 5 req/s por IP → chunkar e espaçar os POSTs.

⚠️ O endpoint só existe em produção depois do merge da branch
`claude/portal-endpoint-nfs` (repo `VitorTozeti/Azure_rg_logistica`) para `main`
+ deploy. Antes disso o POST volta 404 — o coletor loga e segue.

Rodar (no servidor interno):
    pip install -r requirements.txt
    python coletor_azure.py            # loop contínuo (fica de pé)
    python coletor_azure.py --once     # 1 ciclo e sai (p/ Agendador de Tarefas)

Modo agendado (recomendado no servidor): use o `run_coletor.bat`, que força
`--once` e é disparado de 15 em 15 min pelo Agendador de Tarefas do Windows.
O estado do delta é persistido em `estado_coletor.json` ENTRE execuções — é o
que permite detectar NF "resolvida" mesmo com o processo reiniciando a cada run.
"""
import json
import os
import sys
import time

import requests

try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

import feed  # reusa _coletar_estado() e as constantes de classificação

# ── Configuração (tudo por env; nada de segredo no código) ──────────────────
AZURE_BASE = os.getenv("PORTAL_AZURE_BASE", "").strip().rstrip("/")
AZURE_USER = os.getenv("PORTAL_AZURE_USER", "")
AZURE_SENHA = os.getenv("PORTAL_AZURE_SENHA", "")
POLL_SEGUNDOS = int(os.getenv("PORTAL_POLL_SEGUNDOS", "20"))
CHUNK = int(os.getenv("PORTAL_AZURE_CHUNK", "500"))          # NFs por POST
RPS = float(os.getenv("PORTAL_AZURE_RPS", "4"))              # POSTs/s (< 5 do rate limit)
TIMEOUT = int(os.getenv("PORTAL_AZURE_TIMEOUT", "30"))       # s por request

# Modo de execução: loop contínuo (default, p/ rodar como serviço) OU one-shot
# (1 ciclo e sai — p/ Agendador de Tarefas / .bat de 15 em 15 min). Liga com o
# env PORTAL_ONESHOT=1 ou passando --once na linha de comando.
ONESHOT = os.getenv("PORTAL_ONESHOT", "").strip().lower() in ("1", "true", "sim", "yes") \
    or "--once" in sys.argv

# Onde o estado do delta é persistido ENTRE execuções. Sem isto, um coletor
# agendado (processo novo a cada 15 min) perde o cache em memória e (a) reenvia
# tudo sempre e (b) NUNCA detecta uma NF "resolvida" (que depende de comparar
# com o ciclo anterior). Guardado ao lado do script, git-ignorado.
ESTADO_ARQ = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          os.getenv("PORTAL_COLETOR_ESTADO", "estado_coletor.json"))

# Campos que o endpoint entende (o resto o servidor descarta de qualquer jeito).
_CAMPOS = ["nf", "filial", "estado", "transportadora", "atualizado_em",
           "ignorada", "problema_codigo", "problema_categoria",
           "problema_descricao", "travada_desde", "grupo"]


def _nota(ev: dict) -> dict:
    """Recorta um evento do feed para o schema do endpoint, saneando None/tipos.
    (o feed às vezes manda travada_desde=None — Pydantic `str` recusa None)."""
    d = {}
    for k in _CAMPOS:
        v = ev.get(k)
        if k == "ignorada":
            d[k] = bool(v)
        else:
            d[k] = "" if v is None else str(v)
    return d


def _montar_estado():
    """Roda os 4 motores igual ao loop do portal local (feed.rodar_feed_simulado)
    e devolve (todas_travadas, subiram) já com `id` e sem as ocultas do portal."""
    travadas, subiram, nfs_no_log, log_index = feed._coletar_estado()

    barradas, marketing, cancelamentos = [], [], []
    try:
        import sap_feed
        barradas = sap_feed.coletar_barradas(nfs_no_log)
    except Exception as e:
        print(f"  [COLETOR] Motor 1 (SAP) indisponível: {e}", flush=True)
    try:
        import marketing_feed
        marketing = marketing_feed.coletar_marketing()
    except Exception as e:
        print(f"  [COLETOR] Marketing indisponível: {e}", flush=True)
    try:
        import canc_feed
        cancelamentos = canc_feed.coletar_cancelamentos(log_index)
    except Exception as e:
        print(f"  [COLETOR] Cancelamento indisponível: {e}", flush=True)

    todas_travadas = travadas + barradas + marketing + cancelamentos
    for ev in todas_travadas + subiram:
        ev["id"] = f"{ev.get('filial', '?')}:{ev['nf']}"

    # NFs que o portal marcou ignorada/tratada somem da lista de travadas (igual ao feed)
    try:
        import acoes
        ocultas = acoes.ids_ocultos()
        if ocultas:
            todas_travadas = [ev for ev in todas_travadas if ev["id"] not in ocultas]
    except Exception as e:
        print(f"  [COLETOR] ações locais indisponíveis: {e}", flush=True)

    return todas_travadas, subiram


def _carregar_estado() -> tuple[dict, set]:
    """Lê o cache de delta do disco (id->assinatura já confirmada + ids que
    estavam travados no último ciclo). Arquivo ausente/corrompido → começa zerado
    (o 1º ciclo reenvia tudo, que é idempotente no upsert). Nunca levanta."""
    try:
        with open(ESTADO_ARQ, encoding="utf-8") as f:
            d = json.load(f)
        publicado = dict(d.get("publicado", {}))
        travadas = set(d.get("travadas_anteriores", []))
        return publicado, travadas
    except FileNotFoundError:
        return {}, set()
    except Exception as ex:
        print(f"  [COLETOR] estado local ilegível ({ex}) — começando zerado.", flush=True)
        return {}, set()


def _salvar_estado(publicado: dict, travadas_anteriores: set) -> None:
    """Grava o cache de delta no disco de forma atômica (escreve em .tmp e
    renomeia) para o próximo run agendado continuar de onde parou. Best-effort."""
    try:
        tmp = ESTADO_ARQ + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"publicado": publicado,
                       "travadas_anteriores": sorted(travadas_anteriores)}, f)
        os.replace(tmp, ESTADO_ARQ)
    except Exception as ex:
        print(f"  [COLETOR] não consegui salvar o estado local: {ex}", flush=True)


def _enviar(notas: list) -> bool:
    """POSTa as notas em blocos de CHUNK, respeitando o rate limit. Devolve
    True só se TODOS os blocos confirmaram (senão o ciclo repete no próximo)."""
    if not notas:
        return True
    if not (AZURE_BASE and AZURE_USER and AZURE_SENHA):
        print("  [COLETOR] sem PORTAL_AZURE_BASE/USER/SENHA — no-op (nada enviado).", flush=True)
        return False

    url = f"{AZURE_BASE}/v1/portal/nfs"
    auth = (AZURE_USER, AZURE_SENHA)
    intervalo = 1.0 / RPS if RPS > 0 else 0
    g = r = e = 0
    for i in range(0, len(notas), CHUNK):
        bloco = notas[i:i + CHUNK]
        try:
            resp = requests.post(url, json={"nfs": bloco}, auth=auth, timeout=TIMEOUT)
            resp.raise_for_status()
            j = resp.json()
            g += j.get("gravadas", 0)
            r += j.get("removidas", 0)
            e += j.get("erros", 0)
            if j.get("persistencia") == "no-op":
                print("  [COLETOR] [AVISO] container respondeu 'no-op' (sem STORAGE_ACCOUNT_URL) - o deploy ainda nao grava.", flush=True)
        except Exception as ex:
            print(f"  [COLETOR] falha no POST (bloco {i//CHUNK + 1}): {ex}", flush=True)
            return False
        if intervalo:
            time.sleep(intervalo)
    print(f"  [COLETOR] enviadas {len(notas)} notas -> gravadas={g} removidas={r} erros={e}", flush=True)
    return True


def _ciclo(publicado: dict, travadas_anteriores: set) -> tuple[dict, set]:
    """UM ciclo: coleta → calcula deltas → POST. Só manda o que mudou desde o
    estado dado + as resolvidas (que sumiram da lista de travadas). Devolve o
    novo (publicado, travadas_anteriores). Se o POST falhar, devolve o estado
    ANTIGO inalterado → o próximo ciclo/run tenta tudo de novo (best-effort)."""
    todas_travadas, subiram = _montar_estado()

    pendentes = []
    atual: dict[str, str] = {}

    # 1) travadas novas/alteradas
    travadas_atuais: set = set()
    for ev in todas_travadas:
        travadas_atuais.add(ev["id"])
        assin = f"{ev['estado']}|{ev.get('problema_codigo', '')}|{int(bool(ev.get('ignorada')))}"
        atual[ev["id"]] = assin
        if publicado.get(ev["id"]) != assin:
            pendentes.append(_nota(ev))

    # 2) resolvidas: estavam travadas e não estão mais → DELETE no espelho
    for id_antigo in travadas_anteriores - travadas_atuais:
        filial, _, nf = id_antigo.partition(":")
        pendentes.append({"nf": nf, "filial": filial, "estado": "resolvida"})

    # 3) subiram novas/alteradas
    for ev in subiram:
        atual[ev["id"]] = "subiu"
        if publicado.get(ev["id"]) != "subiu":
            pendentes.append(_nota(ev))

    if pendentes:
        if _enviar(pendentes):
            return atual, travadas_atuais
        # POST falhou → não avança o estado (retenta no próximo run)
        return publicado, travadas_anteriores

    print("  [COLETOR] sem mudanças neste ciclo.", flush=True)
    return atual, travadas_atuais


def rodar() -> None:
    """Loop contínuo (roda como serviço/console que fica de pé): carrega o estado
    do disco 1x e faz ciclos a cada POLL_SEGUNDOS, persistindo a cada ciclo."""
    print(f"[COLETOR] iniciando (loop) — destino={AZURE_BASE or '(não definido)'} "
          f"poll={POLL_SEGUNDOS}s chunk={CHUNK} rps={RPS}", flush=True)
    publicado, travadas_anteriores = _carregar_estado()
    while True:
        try:
            publicado, travadas_anteriores = _ciclo(publicado, travadas_anteriores)
            _salvar_estado(publicado, travadas_anteriores)
        except Exception as ex:
            print(f"  [COLETOR] falha no ciclo: {ex}", flush=True)
        time.sleep(POLL_SEGUNDOS)


def rodar_uma_vez() -> int:
    """Executa UM ciclo e sai — modo p/ Agendador de Tarefas / .bat (15 em 15 min).
    Carrega o estado do disco, faz o ciclo, persiste. Devolve código de saída
    (0 = ok; 1 = falha no ciclo, útil p/ o Agendador registrar o resultado)."""
    print(f"[COLETOR] iniciando (one-shot) — destino={AZURE_BASE or '(não definido)'} "
          f"chunk={CHUNK} rps={RPS}", flush=True)
    publicado, travadas_anteriores = _carregar_estado()
    try:
        publicado, travadas_anteriores = _ciclo(publicado, travadas_anteriores)
        _salvar_estado(publicado, travadas_anteriores)
        return 0
    except Exception as ex:
        print(f"  [COLETOR] falha no ciclo: {ex}", flush=True)
        return 1


if __name__ == "__main__":
    if not AZURE_BASE:
        print("[AVISO] PORTAL_AZURE_BASE nao definido. Defina no .env antes de rodar "
              "(ex.: https://<app>.eastus.azurecontainerapps.io).", flush=True)
    sys.exit(rodar_uma_vez() if ONESHOT else (rodar() or 0))
