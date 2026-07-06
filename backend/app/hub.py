from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import WebSocket

log = logging.getLogger(__name__)


class Hub:
    """Tracks connected dashboard websockets for one event slot."""

    def __init__(self) -> None:
        self.live_clients: set[WebSocket] = set()
        self.driver_clients: dict[str, set[WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def join_live(self, ws: WebSocket) -> None:
        async with self._lock:
            self.live_clients.add(ws)

    async def leave_live(self, ws: WebSocket) -> None:
        async with self._lock:
            self.live_clients.discard(ws)

    async def join_driver(self, kart_no: str, ws: WebSocket) -> None:
        async with self._lock:
            self.driver_clients.setdefault(kart_no, set()).add(ws)

    async def leave_driver(self, kart_no: str, ws: WebSocket) -> None:
        async with self._lock:
            clients = self.driver_clients.get(kart_no)
            if clients:
                clients.discard(ws)
                if not clients:
                    del self.driver_clients[kart_no]

    @staticmethod
    async def _send(ws: WebSocket, payload: dict[str, Any]) -> bool:
        try:
            await ws.send_json(payload)
            return True
        except Exception:
            return False

    async def broadcast_live(self, payload: dict[str, Any]) -> None:
        dead = [ws for ws in list(self.live_clients) if not await self._send(ws, payload)]
        for ws in dead:
            await self.leave_live(ws)

    async def send_to_driver(self, kart_no: str, payload: dict[str, Any]) -> int:
        """Send to every open dashboard of one kart. Returns delivery count."""
        delivered = 0
        for ws in list(self.driver_clients.get(kart_no, ())):
            if await self._send(ws, payload):
                delivered += 1
            else:
                await self.leave_driver(kart_no, ws)
        return delivered

    async def broadcast_drivers(self, make_payload) -> None:
        """Push per-kart payloads; make_payload(kart_no) builds each one."""
        for kart_no in list(self.driver_clients.keys()):
            await self.send_to_driver(kart_no, make_payload(kart_no))

    def counts(self) -> dict[str, int]:
        return {
            "live": len(self.live_clients),
            "drivers": sum(len(v) for v in self.driver_clients.values()),
        }
