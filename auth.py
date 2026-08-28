"""
auth.py — login simples do Portal da Logística.

Dois perfis de acesso, com as credenciais vindas do `.env` (que no deploy viram
GitHub Secrets — ver `.env.example`):
  • TI        — 1 credencial COMPARTILHADA (PORTAL_TI_USUARIO / PORTAL_TI_SENHA).
  • Logística — USUÁRIOS CADASTRADOS (PORTAL_LOGISTICA_USUARIOS = "usuario:senha,...").

⚠️ Isto NÃO é o Entra ID (planejado p/ Fase 2 no PLANEJAMENTO.md). É um login de senha
compartilhada, suficiente para restringir o portal a Logística/TI enquanto o SSO não entra.
As senhas NUNCA vão para o git — moram no `.env` (local) / GitHub Secrets (deploy).

A sessão é um cookie ASSINADO com HMAC-SHA256 (PORTAL_SECRET_KEY): sem banco, sem estado no
servidor. Expira em PORTAL_SESSAO_HORAS (default 12h). O segredo garante que ninguém forja
um cookie sem conhecer a chave.
"""
import base64
import hashlib
import hmac
import json
import os
import time

from dotenv import load_dotenv

load_dotenv()  # carrega o .env da pasta do portal (credenciais de acesso)

COOKIE = "portal_sessao"
_SECRET = os.getenv("PORTAL_SECRET_KEY", "portal-logistica-dev-inseguro").encode()
SESSAO_SEG = int(float(os.getenv("PORTAL_SESSAO_HORAS", "12")) * 3600)


def _usuarios_logistica() -> dict[str, str]:
    """PORTAL_LOGISTICA_USUARIOS ('u1:s1,u2:s2') -> {usuario: senha}."""
    bruto = os.getenv("PORTAL_LOGISTICA_USUARIOS", "user:senha")
    mapa: dict[str, str] = {}
    for par in bruto.split(","):
        par = par.strip()
        if not par or ":" not in par:
            continue
        usuario, _, senha = par.partition(":")
        if usuario.strip():
            mapa[usuario.strip()] = senha  # senha pode ter espaços; não faz strip
    return mapa


def _credenciais_ti() -> tuple[str, str]:
    return (os.getenv("PORTAL_TI_USUARIO", "user").strip(),
            os.getenv("PORTAL_TI_SENHA", "senha"))


def verificar(perfil: str, usuario: str, senha: str) -> bool:
    """True se (usuario, senha) baterem no perfil ('ti' | 'logistica'). Tempo-constante."""
    usuario = (usuario or "").strip()
    senha = senha or ""
    if perfil == "ti":
        u, s = _credenciais_ti()
        return (bool(usuario)
                and hmac.compare_digest(usuario, u)
                and hmac.compare_digest(senha, s))
    if perfil == "logistica":
        esperada = _usuarios_logistica().get(usuario)
        return esperada is not None and hmac.compare_digest(senha, esperada)
    return False


def criar_cookie(usuario: str, perfil: str) -> str:
    """Monta o valor do cookie de sessão assinado: base64(json).assinatura."""
    corpo = {"u": usuario, "p": perfil, "exp": int(time.time()) + SESSAO_SEG}
    dados = base64.urlsafe_b64encode(json.dumps(corpo).encode()).decode()
    assinatura = hmac.new(_SECRET, dados.encode(), hashlib.sha256).hexdigest()
    return f"{dados}.{assinatura}"


def ler_cookie(valor: str | None) -> dict | None:
    """Valida assinatura + expiração; devolve {u, p, exp} ou None se inválido/expirado."""
    if not valor or "." not in valor:
        return None
    dados, _, assinatura = valor.partition(".")
    esperada = hmac.new(_SECRET, dados.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(assinatura, esperada):
        return None
    try:
        corpo = json.loads(base64.urlsafe_b64decode(dados.encode()))
    except Exception:
        return None
    if float(corpo.get("exp", 0)) < time.time():
        return None
    return corpo
