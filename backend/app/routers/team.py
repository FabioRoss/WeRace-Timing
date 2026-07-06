from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ..config import get_settings
from ..security import make_token, resolve_token
from .public import get_event

router = APIRouter()


def _resolve_team(slot: int, token: str):
    event = get_event(slot)
    kart = resolve_token(slot, "team", token, event.state.kart_numbers())
    return event, kart


@router.get("/e/{slot}/api/team/{token}")
def team_info(slot: int, token: str, request: Request) -> dict:
    """Resolve a team-manager token to its kart and expose the driver link."""
    event, kart = _resolve_team(slot, token)
    if kart is None:
        # Kart not (yet) in the timing feed — the dashboard shows a waiting state.
        return {"found": False, "slot": slot}

    base = get_settings().public_base_url.rstrip("/") or str(request.base_url).rstrip("/")
    d_token = make_token(slot, "driver", kart)
    row = event.state.find(kart)
    return {
        "found": True,
        "slot": slot,
        "kart_no": kart,
        "name": row.name if row else "",
        "driver_token": d_token,
        "driver_url": f"{base}/e/{slot}/driver/{d_token}",
        "messages": [
            m.model_dump()
            for m in event.messages[-30:]
            if m.target is None or kart in m.target
        ],
    }


class TeamMessage(BaseModel):
    text: str = Field(min_length=1, max_length=300)
    priority: str = "info"


@router.post("/e/{slot}/api/team/{token}/message")
async def team_message(slot: int, token: str, body: TeamMessage) -> dict:
    event, kart = _resolve_team(slot, token)
    if kart is None:
        raise HTTPException(status_code=409, detail="Kart not in the timing feed yet")
    priority = body.priority if body.priority in ("info", "warning", "urgent") else "info"
    msg = await event.send_message("team_manager", body.text.strip(), [kart], priority)
    return {"ok": True, "message": msg.model_dump()}
