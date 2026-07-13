from __future__ import annotations

import time
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from ..config import get_settings
from ..models import Flag, SourceConfig
from ..security import check_safeword, make_token
from ..tracks import TRACK_CATALOG
from .public import get_event

router = APIRouter(dependencies=[Depends(check_safeword)])


@router.post("/api/admin/validate")
def validate() -> dict:
    return {"ok": True}


@router.get("/api/admin/tracks")
def tracks() -> dict:
    settings = get_settings()
    recordings = []
    if settings.recordings_dir.is_dir():
        recordings = sorted(
            (p.name for p in settings.recordings_dir.glob("*.ndjson")), reverse=True
        )
    return {
        "catalog": [c.model_dump() for c in TRACK_CATALOG],
        "recordings": recordings,
    }


@router.get("/api/admin/recordings")
def list_recordings() -> dict:
    """Recordings on the server, newest first, with size + mtime for the
    management panel."""
    directory = get_settings().recordings_dir
    items = []
    if directory.is_dir():
        for p in sorted(
            directory.glob("*.ndjson"), key=lambda p: p.stat().st_mtime, reverse=True
        ):
            st = p.stat()
            items.append({"name": p.name, "size_bytes": st.st_size, "modified": st.st_mtime})
    return {"recordings": items}


def _resolve_recording(name: str) -> Path:
    """Resolve a recording filename to a path inside the recordings dir,
    rejecting traversal and anything that isn't an existing .ndjson there."""
    directory = get_settings().recordings_dir.resolve()
    safe = Path(name).name
    if safe != name or not safe.endswith(".ndjson"):
        raise HTTPException(status_code=422, detail="invalid recording name")
    target = (directory / safe).resolve()
    if target.parent != directory or not target.is_file():
        raise HTTPException(status_code=404, detail="recording not found")
    return target


@router.delete("/api/admin/recordings/{name}")
def delete_recording(name: str) -> dict:
    from ..events import get_manager

    target = _resolve_recording(name)
    # Never delete a file a live recording is still writing to.
    for event in get_manager().events.values():
        rec = event.recorder
        if rec.active and rec.path and rec.path.resolve() == target:
            raise HTTPException(status_code=409, detail="recording is in progress")
    target.unlink()
    return {"ok": True, "deleted": target.name}


@router.get("/e/{slot}/api/admin/status")
def status(slot: int) -> dict:
    event = get_event(slot)
    return {
        "slot": slot,
        "source": event.source_status().model_dump(),
        "flag_override": event.state.flag_override,
        "recompute_positions": event.state.recompute_positions,
        "auto_pitlane": event.state.auto_pitlane,
        # Diagnostic: the first raw frames after connect, to inspect what the
        # upstream actually sends (init/grid sequences).
        "first_frames": event.source.first_frames if event.source else [],
        "clients": event.hub.counts(),
        "messages": [m.model_dump() for m in event.messages[-50:]],
        "karts": event.state.kart_numbers(),
    }


@router.post("/e/{slot}/api/admin/connect")
async def connect(slot: int, config: SourceConfig) -> dict:
    event = get_event(slot)
    if config.kind in ("mywer", "apex") and not config.url.startswith(("ws://", "wss://")):
        raise HTTPException(status_code=422, detail="url must be a ws:// or wss:// address")
    if config.kind == "replay" and not config.file:
        raise HTTPException(status_code=422, detail="replay requires a recording file")
    status = await event.connect_source(config)
    return {"ok": True, "source": status.model_dump()}


@router.post("/e/{slot}/api/admin/disconnect")
async def disconnect(slot: int) -> dict:
    event = get_event(slot)
    await event.disconnect_source()
    return {"ok": True}


class RecordingToggle(BaseModel):
    enable: bool


@router.post("/e/{slot}/api/admin/recording")
def recording(slot: int, body: RecordingToggle) -> dict:
    event = get_event(slot)
    if body.enable:
        if not event.source:
            raise HTTPException(status_code=409, detail="Connect a source before recording")
        name = event.start_recording()
        return {"ok": True, "recording": True, "file": name}
    event.stop_recording()
    return {"ok": True, "recording": False}


@router.post("/e/{slot}/api/admin/reset")
def reset(slot: int) -> dict:
    event = get_event(slot)
    event.reset()
    return {"ok": True}


class FlagOverride(BaseModel):
    flag: str | None = None         # flag value, or null/"" to follow the feed


@router.post("/e/{slot}/api/admin/flag")
async def flag_override(slot: int, body: FlagOverride) -> dict:
    """Force the session flag on all dashboards (organizers without access to
    the track system); clear to mirror the timing feed again."""
    event = get_event(slot)
    if body.flag:
        try:
            event.state.flag_override = Flag(body.flag)
        except ValueError:
            raise HTTPException(status_code=422, detail=f"unknown flag: {body.flag}")
    else:
        event.state.flag_override = None
    event.state.updated_at = time.time()
    await event.broadcast_now()
    return {"ok": True, "flag_override": event.state.flag_override}


class EventSettings(BaseModel):
    recompute_positions: bool | None = None
    auto_pitlane: bool | None = None


@router.post("/e/{slot}/api/admin/settings")
async def settings(slot: int, body: EventSettings) -> dict:
    """How the feed is interpreted for this event: recompute standings from
    laps/time, and whether the venue has automatic pit-lane gates."""
    event = get_event(slot)
    if body.recompute_positions is not None:
        event.state.recompute_positions = body.recompute_positions
    if body.auto_pitlane is not None:
        event.state.auto_pitlane = body.auto_pitlane
    event.state.updated_at = time.time()
    await event.broadcast_now()
    return {
        "ok": True,
        "recompute_positions": event.state.recompute_positions,
        "auto_pitlane": event.state.auto_pitlane,
    }


class AdminMessage(BaseModel):
    text: str = Field(min_length=1, max_length=300)
    target: list[str] | None = None     # kart numbers; None/empty = all drivers
    priority: str = "info"


@router.post("/e/{slot}/api/admin/message")
async def message(slot: int, body: AdminMessage) -> dict:
    event = get_event(slot)
    target = [k.strip() for k in (body.target or []) if k.strip()] or None
    priority = body.priority if body.priority in ("info", "warning", "urgent") else "info"
    msg = await event.send_message("race_control", body.text.strip(), target, priority)
    return {"ok": True, "message": msg.model_dump()}


def _base_url(request: Request) -> str:
    configured = get_settings().public_base_url.rstrip("/")
    if configured:
        return configured
    return str(request.base_url).rstrip("/")


@router.get("/e/{slot}/api/admin/links")
def links(slot: int, request: Request, extra: str = "") -> dict:
    """Driver + team-manager links/tokens for every kart (Staff QR sheet).

    `extra` allows pre-generating links for kart numbers not yet in the feed
    (comma-separated).
    """
    event = get_event(slot)
    base = _base_url(request)
    karts: list[str] = list(event.state.kart_numbers())
    for k in (x.strip() for x in extra.split(",")):
        if k and k not in karts:
            karts.append(k)

    result = []
    for kart in karts:
        row = event.state.find(kart)
        d_token = make_token(slot, "driver", kart)
        t_token = make_token(slot, "team", kart)
        result.append(
            {
                "kart_no": kart,
                "name": row.name if row else "",
                "driver_token": d_token,
                "team_token": t_token,
                "driver_url": f"{base}/e/{slot}/driver/{d_token}",
                "team_url": f"{base}/e/{slot}/team/{t_token}",
            }
        )
    return {"slot": slot, "base_url": base, "karts": result}
