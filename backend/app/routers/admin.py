from __future__ import annotations

import io
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from .. import snapshots
from ..config import get_settings
from ..models import Flag, Penalty, SourceConfig
from ..security import check_safeword, make_token
from ..state import EventState
from ..tracks import TRACK_CATALOG
from .public import get_event

router = APIRouter(dependencies=[Depends(check_safeword)])

# Story backgrounds the operator can optionally save on the server for reuse.
MAX_BACKGROUNDS = 5
MAX_BG_DIM = 2000  # longest edge, px — downscale bigger uploads to bound size.
_BG_EXTS = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}


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


def _list_backgrounds(directory: Path) -> list[dict]:
    items = []
    if directory.is_dir():
        for p in sorted(
            (p for p in directory.iterdir() if p.suffix.lstrip(".").lower() in _BG_EXTS),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        ):
            st = p.stat()
            items.append({"name": p.name, "size_bytes": st.st_size, "modified": st.st_mtime})
    return items


@router.get("/api/admin/backgrounds")
def list_backgrounds() -> dict:
    """Story backgrounds saved on the server (newest first), for the reuse strip."""
    directory = get_settings().backgrounds_dir
    return {"backgrounds": _list_backgrounds(directory), "max": MAX_BACKGROUNDS}


def _resolve_background(name: str) -> Path:
    """Resolve a background filename to a path inside the backgrounds dir,
    rejecting traversal and anything that isn't an existing image there."""
    directory = get_settings().backgrounds_dir.resolve()
    safe = Path(name).name
    if safe != name or safe.rsplit(".", 1)[-1].lower() not in _BG_EXTS:
        raise HTTPException(status_code=422, detail="invalid background name")
    target = (directory / safe).resolve()
    if target.parent != directory or not target.is_file():
        raise HTTPException(status_code=404, detail="background not found")
    return target


@router.post("/api/admin/backgrounds")
async def save_background(file: UploadFile) -> dict:
    """Save an uploaded story background for later reuse (max 5). The image is
    validated + downscaled + re-encoded with Pillow, so only real, size-bounded
    images ever land on disk. Saving is an explicit opt-in — day to day a
    background stays only in the operator's browser."""
    from PIL import Image, UnidentifiedImageError

    directory = get_settings().backgrounds_dir
    directory.mkdir(parents=True, exist_ok=True)
    if len(_list_backgrounds(directory)) >= MAX_BACKGROUNDS:
        raise HTTPException(
            status_code=409,
            detail=f"background store is full ({MAX_BACKGROUNDS}) — delete one first",
        )

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=422, detail="empty upload")
    try:
        img = Image.open(io.BytesIO(raw))
        img.verify()  # detect truncated/garbage before decoding
        img = Image.open(io.BytesIO(raw))  # verify() leaves the image unusable
        img.load()
    except (UnidentifiedImageError, OSError, ValueError):
        raise HTTPException(status_code=422, detail="not a readable image")

    keep_alpha = img.mode in ("RGBA", "LA", "P") and "transparency" in img.info
    img = img.convert("RGBA" if keep_alpha else "RGB")
    if max(img.size) > MAX_BG_DIM:
        img.thumbnail((MAX_BG_DIM, MAX_BG_DIM), Image.LANCZOS)

    ext = "png" if keep_alpha else "jpg"
    out = io.BytesIO()
    if ext == "png":
        img.save(out, format="PNG", optimize=True)
    else:
        img.save(out, format="JPEG", quality=88, optimize=True)
    (directory / f"bg-{uuid.uuid4().hex[:12]}.{ext}").write_bytes(out.getvalue())
    return {"ok": True, "backgrounds": _list_backgrounds(directory), "max": MAX_BACKGROUNDS}


@router.get("/api/admin/backgrounds/{name}")
def serve_background(name: str) -> Response:
    """Serve a saved background's bytes for an <img>/fetch (thumbnail + reuse)."""
    target = _resolve_background(name)
    media = _BG_EXTS[target.suffix.lstrip(".").lower()]
    return Response(content=target.read_bytes(), media_type=media)


@router.delete("/api/admin/backgrounds/{name}")
def delete_background(name: str) -> dict:
    target = _resolve_background(name)
    target.unlink()
    directory = get_settings().backgrounds_dir
    return {"ok": True, "deleted": target.name, "backgrounds": _list_backgrounds(directory)}


@router.get("/e/{slot}/api/admin/status")
def status(slot: int) -> dict:
    event = get_event(slot)
    return {
        "slot": slot,
        "source": event.source_status().model_dump(),
        "flag_override": event.state.flag_override,
        "recompute_positions": event.state.recompute_positions,
        "auto_pitlane": event.state.auto_pitlane,
        "hide_team_penalties": event.state.hide_team_penalties,
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


class ReplaySeek(BaseModel):
    fraction: float = Field(ge=0.0, le=1.0)


@router.post("/e/{slot}/api/admin/replay/seek")
def replay_seek(slot: int, body: ReplaySeek) -> dict:
    """Jump replay playback to a fraction (0..1) of the recording."""
    from ..sources.replay import ReplaySource

    event = get_event(slot)
    if not isinstance(event.source, ReplaySource):
        raise HTTPException(status_code=409, detail="not replaying a recording")
    event.source.seek(body.fraction)
    return {"ok": True, "fraction": body.fraction}


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
    hide_team_penalties: bool | None = None
    team_story_config: dict | None = None


@router.post("/e/{slot}/api/admin/settings")
async def settings(slot: int, body: EventSettings) -> dict:
    """How the feed is interpreted for this event: recompute standings from
    laps/time, whether the venue has automatic pit-lane gates, whether the team
    dashboard hides its penalty panels, and the staff-chosen team-story look."""
    event = get_event(slot)
    if body.recompute_positions is not None:
        event.state.recompute_positions = body.recompute_positions
    if body.auto_pitlane is not None:
        event.state.auto_pitlane = body.auto_pitlane
    if body.hide_team_penalties is not None:
        event.state.hide_team_penalties = body.hide_team_penalties
    if body.team_story_config is not None:
        event.state.team_story_config = snapshots.sanitize_team_story_config(
            body.team_story_config
        )
    event.state.updated_at = time.time()
    await event.broadcast_now()
    return {
        "ok": True,
        "recompute_positions": event.state.recompute_positions,
        "auto_pitlane": event.state.auto_pitlane,
        "hide_team_penalties": event.state.hide_team_penalties,
        "team_story_config": event.state.team_story_config,
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


class AdminPenalty(BaseModel):
    kart_no: str = Field(min_length=1, max_length=10)
    kind: str                                       # time | lap | warning
    seconds: int = Field(default=0, ge=0, le=3600)  # time penalties
    laps: int = Field(default=0, ge=0, le=100)      # lap penalties
    reason: str = Field(default="", max_length=120)


def _penalty_fields(body: AdminPenalty) -> tuple[str, int, int]:
    """Validate a penalty body → (kind, seconds, laps). Shared by the live and
    saved-snapshot penalty endpoints."""
    kind = body.kind
    if kind not in ("time", "lap", "warning"):
        raise HTTPException(status_code=422, detail="kind must be time, lap or warning")
    if kind == "time" and body.seconds <= 0:
        raise HTTPException(status_code=422, detail="time penalty needs seconds > 0")
    if kind == "lap" and body.laps <= 0:
        raise HTTPException(status_code=422, detail="lap penalty needs laps > 0")
    return kind, (body.seconds if kind == "time" else 0), (body.laps if kind == "lap" else 0)


@router.post("/e/{slot}/api/admin/penalty")
async def add_penalty(slot: int, body: AdminPenalty) -> dict:
    event = get_event(slot)
    kind, seconds, laps = _penalty_fields(body)
    pen = event.state.add_penalty(
        body.kart_no.strip(), kind, seconds=seconds, laps=laps, reason=body.reason.strip()
    )
    event.state.updated_at = time.time()
    # Notify the team after a short grace window (staff can delete a mistake).
    event.schedule_penalty_notify(pen)
    await event.broadcast_now()
    return {"ok": True, "penalty": pen.model_dump()}


class AdminPenaltyServed(BaseModel):
    served: bool = True


@router.post("/e/{slot}/api/admin/penalty/{penalty_id}/served")
async def set_penalty_served(slot: int, penalty_id: int, body: AdminPenaltyServed) -> dict:
    event = get_event(slot)
    pen = event.state.set_penalty_served(penalty_id, body.served)
    if pen is None:
        raise HTTPException(status_code=404, detail="penalty not found")
    event.state.updated_at = time.time()
    await event.broadcast_now()
    return {"ok": True, "penalty": pen.model_dump()}


@router.delete("/e/{slot}/api/admin/penalty/{penalty_id}")
async def remove_penalty(slot: int, penalty_id: int) -> dict:
    event = get_event(slot)
    # Cancel any pending team notification before the penalty is gone.
    event.cancel_penalty_notify(penalty_id)
    pen = event.state.remove_penalty(penalty_id)
    if pen is None:
        raise HTTPException(status_code=404, detail="penalty not found")
    event.state.updated_at = time.time()
    await event.broadcast_now()
    return {"ok": True, "penalty": pen.model_dump()}


@router.post("/e/{slot}/api/admin/snapshots")
def save_snapshot_now(slot: int) -> dict:
    """Manually save a snapshot of the slot's current live state (for feeds that
    never flag the session as ended)."""
    event = get_event(slot)
    if not event.state.drivers:
        raise HTTPException(status_code=422, detail="no session data to save yet")
    sid = event.save_snapshot("manual")
    return {"ok": True, "snapshot": snapshots.meta_of(snapshots.load_record(sid))}


# ------------------------------------------------ saved snapshots management

def _load_snapshot_or_404(snapshot_id: str) -> dict:
    rec = snapshots.load_record(snapshot_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="snapshot not found")
    return rec


def _snapshot_penalties(rec: dict) -> list[dict]:
    return rec.setdefault("snapshot", {}).setdefault("penalties", [])


@router.get("/api/admin/snapshots")
def list_snapshots() -> dict:
    return {"snapshots": [snapshots.meta_of(r) for r in snapshots.list_records()]}


@router.get("/api/admin/snapshots/{snapshot_id}")
def get_snapshot(snapshot_id: str) -> dict:
    return _load_snapshot_or_404(snapshot_id)


@router.get("/api/admin/snapshots/{snapshot_id}/laps")
def snapshot_laps(snapshot_id: str, karts: str = Query(default="")) -> dict:
    """Lap-by-lap history for any saved snapshot (same shape as the live laps
    endpoint), so the editor can preview the lap-time charts."""
    rec = _load_snapshot_or_404(snapshot_id)
    selected = [k.strip() for k in karts.split(",") if k.strip()] or None
    return {"id": snapshot_id, "laps": EventState.hydrate(rec).lap_chart(selected)}


class SnapshotPatch(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    short_name: str | None = Field(default=None, max_length=40)
    track: str | None = Field(default=None, max_length=120)
    tags: list[str] | None = None
    keep: bool | None = None
    published: bool | None = None
    private_notes: str | None = Field(default=None, max_length=5000)
    public_notes: str | None = Field(default=None, max_length=5000)
    pdf_config: dict | None = None
    team_story_config: dict | None = None


@router.patch("/api/admin/snapshots/{snapshot_id}")
def patch_snapshot(snapshot_id: str, body: SnapshotPatch) -> dict:
    rec = _load_snapshot_or_404(snapshot_id)
    data = body.model_dump(exclude_unset=True)
    for field in ("name", "short_name", "track", "tags", "private_notes", "public_notes"):
        if data.get(field) is not None:
            rec[field] = data[field]
    if data.get("pdf_config") is not None:
        rec["pdf_config"] = snapshots.sanitize_pdf_config(data["pdf_config"])
    if data.get("team_story_config") is not None:
        rec["team_story_config"] = snapshots.sanitize_team_story_config(
            data["team_story_config"]
        )
    if data.get("published") is not None:
        rec["published"] = data["published"]
        if data["published"]:
            rec["keep"] = True   # published links must not silently expire
    if data.get("keep") is not None:
        rec["keep"] = data["keep"]
    # Expiry follows the keep flag.
    if rec.get("keep"):
        rec["expires_at"] = None
    elif rec.get("expires_at") is None:
        ttl = get_settings().snapshot_ttl_days
        rec["expires_at"] = rec.get("created_at", time.time()) + ttl * 86400
    snapshots.write_record(rec)
    return {"ok": True, "snapshot": snapshots.meta_of(rec)}


# ---------------------------------------------------- event groups (snapshots)

@router.get("/api/admin/snapshot-groups")
def list_snapshot_groups() -> dict:
    """All events (snapshot groups), published or not, for the manager UI."""
    return {"groups": snapshots.list_groups(published_only=False)}


class GroupAssign(BaseModel):
    snapshot_ids: list[str] = Field(min_length=1)
    group_id: str | None = None
    group_name: str | None = Field(default=None, max_length=120)


@router.post("/api/admin/snapshot-groups/assign")
def assign_snapshot_group(body: GroupAssign) -> dict:
    """Group snapshots into an event (existing `group_id` or a new `group_name`),
    or ungroup them when neither is given. Events are per-track: assigning
    snapshots that span multiple tracks is rejected."""
    recs = []
    for sid in body.snapshot_ids:
        rec = snapshots.load_record(sid)
        if rec is None:
            raise HTTPException(status_code=404, detail=f"snapshot not found: {sid}")
        recs.append(rec)

    wants_group = bool(body.group_id) or bool((body.group_name or "").strip())
    if not wants_group:
        for rec in recs:
            rec["group_id"], rec["group_name"] = None, ""
            snapshots.write_record(rec)
        return {"ok": True, "group": None}

    tracks = {(rec.get("track") or "").strip() for rec in recs}
    if body.group_id:
        match = next(
            (g for g in snapshots.list_groups() if g["id"] == body.group_id), None
        )
        gid = body.group_id
        name = ((body.group_name or "") or (match["name"] if match else "")).strip() or gid
        if match:
            tracks.add((match["track"] or "").strip())
    else:
        name = body.group_name.strip()
        gid = snapshots.make_id(name)

    tracks.discard("")
    if len(tracks) > 1:
        raise HTTPException(
            status_code=422,
            detail=f"snapshots span multiple tracks: {sorted(tracks)}",
        )

    for rec in recs:
        rec["group_id"], rec["group_name"] = gid, name
        snapshots.write_record(rec)
    return {"ok": True, "group": {"id": gid, "name": name}}


@router.delete("/api/admin/snapshots/{snapshot_id}")
def delete_snapshot(snapshot_id: str) -> dict:
    try:
        ok = snapshots.delete_record(snapshot_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="invalid snapshot id")
    if not ok:
        raise HTTPException(status_code=404, detail="snapshot not found")
    return {"ok": True}


@router.post("/api/admin/snapshots/{snapshot_id}/penalty")
def snapshot_add_penalty(snapshot_id: str, body: AdminPenalty) -> dict:
    rec = _load_snapshot_or_404(snapshot_id)
    kind, seconds, laps = _penalty_fields(body)
    seq = int(rec.get("penalty_seq", 0)) + 1
    rec["penalty_seq"] = seq
    pen = Penalty(id=seq, kart_no=body.kart_no.strip(), kind=kind,
                  seconds=seconds, laps=laps, reason=body.reason.strip())
    _snapshot_penalties(rec).append(pen.model_dump())
    snapshots.write_record(rec)
    return {"ok": True, "penalty": pen.model_dump()}


@router.post("/api/admin/snapshots/{snapshot_id}/penalty/{penalty_id}/served")
def snapshot_serve_penalty(snapshot_id: str, penalty_id: int, body: AdminPenaltyServed) -> dict:
    rec = _load_snapshot_or_404(snapshot_id)
    for pen in _snapshot_penalties(rec):
        if pen.get("id") == penalty_id:
            pen["served"] = body.served
            snapshots.write_record(rec)
            return {"ok": True, "penalty": pen}
    raise HTTPException(status_code=404, detail="penalty not found")


@router.delete("/api/admin/snapshots/{snapshot_id}/penalty/{penalty_id}")
def snapshot_remove_penalty(snapshot_id: str, penalty_id: int) -> dict:
    rec = _load_snapshot_or_404(snapshot_id)
    pens = _snapshot_penalties(rec)
    kept = [p for p in pens if p.get("id") != penalty_id]
    if len(kept) == len(pens):
        raise HTTPException(status_code=404, detail="penalty not found")
    rec["snapshot"]["penalties"] = kept
    snapshots.write_record(rec)
    return {"ok": True}


@router.post("/api/admin/snapshots/{snapshot_id}/penalty/revert")
def snapshot_revert_penalties(snapshot_id: str) -> dict:
    """Restore the as-finished penalties, discarding later amendments."""
    rec = _load_snapshot_or_404(snapshot_id)
    original = [dict(p) for p in rec.get("original_penalties", [])]
    rec["snapshot"]["penalties"] = original
    rec["penalty_seq"] = max((p.get("id", 0) for p in original), default=0)
    snapshots.write_record(rec)
    return {"ok": True, "penalties": original}


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
