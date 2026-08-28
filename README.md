# Portal da Logística — versão B4You (básica)

Portal interno (Logística + TI) que mostra o estado das NFs **ao vivo**: as que
subiram e as travadas (com o problema real e há quanto tempo). Começando simples,
com **B4You**; depois haverá uma versão **Unilog**.

## Como a Live Connection funciona

Usa **SSE (Server-Sent Events)** — o servidor empurra cada mudança para o navegador;
o `EventSource` reconecta sozinho se cair. É o encaixe certo para um feed só-leitura
(não precisa de WebSocket). As ações do portal (ignorar, re-rotear) serão POSTs
normais; o resultado volta pelo mesmo SSE.

```
feed.py  ──publica──>  hub.py (pub/sub em memória)  ──SSE /stream──>  static/index.html
 (fonte)                (encanamento)                                  (EventSource)
```

- **hub.py** — pub/sub em memória; guarda o último estado de cada NF e empurra para todos os conectados. Não sabe nada de B4You/SAP.
- **feed.py** — a FONTE REAL (orquestrador + Motor 2 do log mestre). Chama `sap_feed.py`, `marketing_feed.py` e `canc_feed.py` a cada 20s e publica só as mudanças. 100% só-leitura.
- **app.py** — FastAPI: `/stream` (SSE), `/api/nfs` (snapshot), `/acoes/*` (ignorar/tratada/reativar), `/` (front).
- **acoes.py** — estado local das ações (ignorar/tratada) em `estado_portal.json` (Fase 0).

> 📋 Plano completo do projeto (arquitetura, fases, recursos Azure): **[PLANEJAMENTO.md](PLANEJAMENTO.md)**.

## Rodar

```bash
pip install -r requirements.txt
uvicorn app:app --reload
# abrir http://127.0.0.1:8000
```

## Próximos passos

1. Trocar o `feed.py` simulado pelo **puxadinho real** (ler log mestre + auditoria SAP).
   Catálogo completo dos problemas: nota `portal-logistica-nfs-problema` no vault.
2. Ação por nota (ignorar + soluções rápidas) — POSTs que voltam pelo SSE.
3. Login restrito a Logística/TI (Entra ID).
4. Página de OTIF.
5. Versão **Unilog**: troca a família de códigos `B4YOU_*` pelos equivalentes da Unilog;
   o encanamento (hub/SSE) não muda.
