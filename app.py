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

from fastapi import FastAPI, Form, Request
from fastapi.responses import (FileResponse, JSONResponse, RedirectResponse,
                               StreamingResponse)
from fastapi.staticfiles import StaticFiles

import acoes
import auth
from hub import hub
from feed import rodar_feed_simulado

app = FastAPI(title="Portal da Logística — B4You")

# rotas que qualquer um alcança sem estar logado (a própria tela de login)
_PUBLICO = {"/login", "/logout"}


@app.middleware("http")
async def exigir_login(request: Request, call_next):
    """
    Porteiro do portal: só passa quem tem cookie de sessão válido (ver auth.py).
    - Sem sessão + rota de dados (/api, /stream, /acoes) -> 401 JSON.
    - Sem sessão + qualquer outra (o front) -> manda para /login.
    """
    caminho = request.url.path
    if caminho in _PUBLICO or auth.ler_cookie(request.cookies.get(auth.COOKIE)):
        return await call_next(request)
    if caminho.startswith(("/api", "/stream", "/acoes")):
        return JSONResponse({"erro": "nao autenticado"}, status_code=401)
    return RedirectResponse("/login", status_code=302)


@app.get("/login")
async def login_form():
    """A tela de login (static/login.html)."""
    return FileResponse("static/login.html")


@app.post("/login")
async def login_submit(usuario: str = Form(...), senha: str = Form(...),
                       perfil: str = Form("logistica")):
    """Valida a credencial no perfil escolhido e abre a sessão (cookie assinado)."""
    if not auth.verificar(perfil, usuario, senha):
        # volta ao form sinalizando erro, preservando o perfil que a pessoa escolheu
        return RedirectResponse(f"/login?erro=1&perfil={perfil}", status_code=303)
    resp = RedirectResponse("/", status_code=303)
    resp.set_cookie(auth.COOKIE, auth.criar_cookie(usuario, perfil),
                    httponly=True, samesite="lax", max_age=auth.SESSAO_SEG)
    return resp


@app.get("/logout")
async def logout():
    resp = RedirectResponse("/login", status_code=303)
    resp.delete_cookie(auth.COOKIE)
    return resp


@app.get("/api/sessao")
async def sessao(request: Request):
    """Quem está logado agora (para o front mostrar usuário + botão sair)."""
    s = auth.ler_cookie(request.cookies.get(auth.COOKIE)) or {}
    return {"usuario": s.get("u"), "perfil": s.get("p")}


@app.on_event("startup")
async def _iniciar_feed() -> None:
    # liga a fonte de eventos em segundo plano
    asyncio.create_task(rodar_feed_simulado())


@app.get("/api/nfs")
async def listar_nfs():
    """Foto atual de todas as NFs conhecidas."""
    return hub.snapshot()


@app.get("/api/subiram/historico")
async def subiram_historico(de: str = "", ate: str = "", filial: str = "todas",
                            pagina: int = 1, tudo: str = "",
                            nf: str = "", transp: str = "", ignoradas: str = "todas",
                            ignorados: str = ""):
    """Histórico completo de notas subidas (faturadas) no SAP — sob demanda.
    `tudo=1` ignora o intervalo e puxa desde o começo da empresa.
    Filtros extras: `nf` (substring), `transp` (transportadora exata), `ignoradas`
    ("todas"|"so"|"sem") + `ignorados` (conjunto "Filial:NF,…" que o portal conhece)."""
    if tudo:
        de, ate = "2000-01-01", "2999-12-31"
    else:
        de = de or "2000-01-01"
        ate = ate or "2999-12-31"
    import historico_feed
    return await asyncio.to_thread(
        historico_feed.consultar_historico, de, ate, filial, max(1, pagina), 100,
        nf, transp, ignoradas, ignorados)


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
async def stream(request: Request, snapshot: int = 1):
    """
    Server-Sent Events. O navegador conecta com `new EventSource('/stream')`.
    Ao conectar, mandamos o snapshot atual; depois, cada mudança vira um evento.

    `?snapshot=0`: pula o replay da foto inicial e manda SÓ os deltas ao vivo.
    O front usa isso quando já carregou a foto por `/api/nfs` (1 fetch, 1 parse) —
    evita cuspir os ~12 mil eventos da foto de novo pelo SSE.
    """
    fila = hub.assinar()

    async def gerador():
        # 1) manda a foto atual para a tela já nascer preenchida (a menos que o front peça só deltas)
        if snapshot:
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
