from __future__ import annotations

import logging
import re

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..events import get_manager

log = logging.getLogger(__name__)

router = APIRouter()

TOKEN_SHAPE = re.compile(r"^[0-9a-f]{16}$")


@router.websocket("/e/{slot}/ws/live")
async def ws_live(ws: WebSocket, slot: int) -> None:
    """Feed for General / Team Manager / Race Control / Staff dashboards."""
    try:
        event = get_manager().get(slot)
    except KeyError:
        await ws.close(code=4404)
        return

    await ws.accept()
    await event.hub.join_live(ws)
    try:
        await ws.send_json(event.state.snapshot(event.source_status()).model_dump())
        for msg in event.messages[-20:]:
            await ws.send_json({"type": "message", **msg.model_dump()})
        while True:
            await ws.receive_text()     # keepalive pings from the client
    except WebSocketDisconnect:
        pass
    except Exception:
        log.debug("live ws dropped", exc_info=True)
    finally:
        await event.hub.leave_live(ws)


@router.websocket("/e/{slot}/ws/driver/{token}")
async def ws_driver(ws: WebSocket, slot: int, token: str) -> None:
    """Per-kart feed for the Driver dashboard (state + targeted messages)."""
    try:
        event = get_manager().get(slot)
    except KeyError:
        await ws.close(code=4404)
        return
    if not TOKEN_SHAPE.match(token):
        await ws.close(code=4403)
        return

    await ws.accept()
    await event.hub.join_driver(token, ws)
    try:
        token_map = event.driver_token_map()
        await ws.send_json(event.driver_payload(token, token_map))
        kart = token_map.get(token)
        if kart:
            for msg in event.messages[-10:]:
                if msg.target is None or kart in msg.target:
                    await ws.send_json({"type": "message", **msg.model_dump()})
        while True:
            await ws.receive_text()     # keepalive pings from the client
    except WebSocketDisconnect:
        pass
    except Exception:
        log.debug("driver ws dropped", exc_info=True)
    finally:
        await event.hub.leave_driver(token, ws)
