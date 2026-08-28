"""
app.py — o servidor do Portal da Logística (versão básica, B4You).

Expõe:
  GET /            -> o front (static/index.html)
  GET /stream      -> a LIVE CONNECTION (SSE): empurra o estado das NFs em tempo real
  GET /api/nfs     -> foto atual (snapshot) — usado por quem não quer stream

Rodar:
  pip install -r requirements.txt
  uvicorn app:app --reload
  abrir http://127.0.0.1:8000
"""
import asyncio

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

import acoes
from hub import hub
from feed import rodar_feed_simulado

app = FastAPI(title="Portal da Logística — B4You")


@app.on_event("startup")
async def _iniciar_feed() -> None:
    # liga a fonte de eventos em segundo plano
    asyncio.create_task(rodar_feed_simulado())


@app.get("/api/nfs")
async def listar_nfs():
    """Foto atual de todas as NFs conhecidas."""
    return hub.snapshot()


@app.post("/acoes/ocultar")
async def ocultar_nf(payload: dict):
    """
    Ação por nota (Fase 0): ignorar ou marcar tratada → some da tela.
    Body: {"id": "Varejo:7096", "tipo": "ignorada"|"tratada", "motivo": "opcional"}.
    Não altera a NF/SAP/B4You — só o estado local do portal. Remove já da tela (SSE).
    """
    id_nf = str(payload.get("id") or "").strip()
    if not id_nf:
        return {"ok": False, "erro": "id obrigatório"}
    filial, _, nf = id_nf.partition(":")
    reg = acoes.ocultar(id_nf, str(payload.get("tipo") or "ignorada"),
                        str(payload.get("motivo") or ""), nf=nf, filial=filial)
    # tira da tela de todos os conectados agora, sem esperar o próximo ciclo
    hub.publicar({"id": id_nf, "nf": nf, "filial": filial, "estado": "resolvida"})
    return {"ok": True, "registro": reg}


@app.post("/acoes/reativar")
async def reativar_nf(payload: dict):
    """Traz a NF de volta (o próximo ciclo do feed a republica se ainda estiver travada)."""
    id_nf = str(payload.get("id") or "").strip()
    if not id_nf:
        return {"ok": False, "erro": "id obrigatório"}
    return {"ok": acoes.reativar(id_nf)}


@app.get("/acoes/ocultas")
async def listar_ocultas():
    """NFs atualmente ocultas (ignoradas/tratadas) — para o painel 'ver ocultas'."""
    return acoes.listar()


@app.get("/stream")
async def stream(request: Request):
    """
    Server-Sent Events. O navegador conecta com `new EventSource('/stream')`.
    Ao conectar, mandamos o snapshot atual; depois, cada mudança vira um evento.
    """
    fila = hub.assinar()

    async def gerador():
        # 1) manda a foto atual para a tela já nascer preenchida
        for evento in hub.snapshot():
            import json
            yield f"data: {json.dumps(evento, ensure_ascii=False)}\n\n"
        # 2) daqui pra frente, empurra cada novo evento
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    dados = await asyncio.wait_for(fila.get(), timeout=15)
                    yield f"data: {dados}\n\n"
                except asyncio.TimeoutError:
                    # comentário-keepalive: segura a conexão viva através de proxies
                    yield ": keep-alive\n\n"
        finally:
            hub.cancelar(fila)

    return StreamingResponse(
        gerador(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # desliga buffering (nginx/Azure)
        },
    )


# o front por último, para não engolir as rotas /api e /stream
app.mount("/", StaticFiles(directory="static", html=True), name="static")
