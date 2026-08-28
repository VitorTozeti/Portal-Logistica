"""
hub.py — o "coração" da live connection.

Um pequeno pub/sub em memória: quem produz o estado das NFs (o feed) publica
eventos aqui; cada navegador conectado no SSE tem uma fila e recebe tudo.

Não sabe NADA sobre B4You/Unilog nem sobre SAP — é só o encanamento do tempo
real. A fonte do dado pluga em feed.py.
"""
import asyncio
import json
from typing import Any


class Hub:
    def __init__(self) -> None:
        # cada cliente SSE conectado vira uma fila nesta lista
        self._assinantes: list[asyncio.Queue] = []
        # último estado conhecido de cada NF (para o cliente que acabou de conectar
        # já receber a foto atual, sem esperar o próximo evento)
        self.estado: dict[str, dict[str, Any]] = {}

    def assinar(self) -> asyncio.Queue:
        fila: asyncio.Queue = asyncio.Queue()
        self._assinantes.append(fila)
        return fila

    def cancelar(self, fila: asyncio.Queue) -> None:
        if fila in self._assinantes:
            self._assinantes.remove(fila)

    def publicar(self, evento: dict[str, Any]) -> None:
        """Guarda o estado da NF e empurra o evento para todos os conectados.
        Chave = `id` (composto filial:nf) para não colidir NFs iguais de filiais diferentes.
        Evento com estado 'resolvida' REMOVE a nota do estado (saiu da lista de problemas)."""
        chave = evento.get("id") or str(evento.get("nf"))
        if evento.get("estado") == "resolvida":
            self.estado.pop(chave, None)
        else:
            self.estado[chave] = evento
        dados = json.dumps(evento, ensure_ascii=False)
        for fila in list(self._assinantes):
            fila.put_nowait(dados)

    def snapshot(self) -> list[dict[str, Any]]:
        """Foto atual de todas as NFs conhecidas (para o cliente novo)."""
        return list(self.estado.values())


# instância única compartilhada pelo app
hub = Hub()
