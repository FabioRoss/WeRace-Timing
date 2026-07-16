"""Public results API — read-only access to PUBLISHED saved snapshots.

This is also the machine-readable seam for a future cross-app integration:
`GET /api/results` returns structured metadata (incl. track/tags/podium) for
every published session. Private notes and internal blocks are never exposed.
"""
from __future__ import annotations

import logging
import time

from fastapi import APIRouter, HTTPException, Query, Response

from .. import cards, snapshots
from ..events import get_manager
from ..state import EventState
from .export import snapshot_pdf_response

router = APIRouter()
log = logging.getLogger(__name__)

def _published_or_404(snapshot_id: str) -> dict:
    record = snapshots.load_record(snapshot_id)
    if record is None or not record.get("published"):
        raise HTTPException(status_code=404, detail="result not found")
    return record


@router.get("/api/results")
def list_results() -> dict:
    """Published sessions (newest first) as lightweight cards."""
    return {
        "results": [
            snapshots.meta_of(r) for r in snapshots.list_records() if r.get("published")
        ]
    }


@router.get("/api/results/{snapshot_id}")
def get_result(snapshot_id: str) -> dict:
    """A published session's public view: renderable snapshot + public notes,
    with private notes stripped."""
    return snapshots.public_view(_published_or_404(snapshot_id))


@router.get("/api/events")
def list_events() -> dict:
    """Published events (snapshot groups) plus published sessions not in any
    event ("loose"), so the results index can show both."""
    events = snapshots.list_groups(published_only=True)
    loose = [
        snapshots.meta_of(r)
        for r in snapshots.list_records()
        if r.get("published") and not r.get("group_id")
    ]
    return {"events": events, "loose": loose}


@router.get("/api/events/{group_id}")
def get_event(group_id: str) -> dict:
    """An event's published sessions (oldest-first) as full public views, one per
    tab. 404 when the event has no published sessions."""
    records = [
        r for r in snapshots.list_records()
        if r.get("published") and r.get("group_id") == group_id
    ]
    if not records:
        raise HTTPException(status_code=404, detail="event not found")
    records.sort(key=lambda r: r.get("created_at") or 0)
    name = next((r.get("group_name") for r in records if r.get("group_name")), group_id)
    track = next((r.get("track") for r in records if r.get("track")), "")
    return {
        "id": group_id, "name": name, "track": track,
        "sessions": [snapshots.public_view(r) for r in records],
    }


@router.get("/api/results/{snapshot_id}/laps")
def result_laps(snapshot_id: str, karts: str = Query(default="")) -> dict:
    """Lap-by-lap history for a published session (the same shape as the live
    `/e/{slot}/api/laps`), so the results page can draw lap-time charts."""
    record = _published_or_404(snapshot_id)
    selected = [k.strip() for k in karts.split(",") if k.strip()] or None
    return {"id": snapshot_id, "laps": EventState.hydrate(record).lap_chart(selected)}


# ------------------------------------------------------- Open Graph cards
# Racey 1200×630 link-preview images (see app/cards.py). Callers build the plain
# card data; a render failure (e.g. Pillow missing) 503s rather than crashing.

def _card_date(record: dict) -> str:
    return time.strftime("%d %b %Y", time.localtime(record.get("created_at") or time.time()))


def render_result_card(record: dict) -> bytes:
    meta = snapshots.meta_of(record)
    return cards.render_card(
        "Results", meta["name"] or "Results",
        [meta["track"], f"{meta['driver_count']} karts", _card_date(record)],
        rows=meta["podium"],
    )


def render_event_card(event: dict) -> bytes:
    sessions = event.get("sessions", [])
    # Podium from the last session that has one (usually the race).
    podium = next((s.get("podium") for s in reversed(sessions) if s.get("podium")), [])
    n = len(sessions)
    return cards.render_card(
        "Event", event.get("name") or "Event",
        [event.get("track", ""), f"{n} session" + ("" if n == 1 else "s")],
        rows=podium,
    )


def render_dashboard_card(event) -> bytes:
    race = event.state.effective_race()
    drivers = event.state.drivers
    rows = [{"position": d.position, "kart_no": d.kart_no, "name": d.name} for d in drivers[:3]]
    sub = [race.track_name, f"{len(drivers)} karts"] if drivers else [race.track_name]
    return cards.render_card(
        "Live timing", race.event_name or "Live timing", sub,
        rows=rows, flag=race.flag.value,
    )


def _png(data: bytes) -> Response:
    return Response(content=data, media_type="image/png",
                    headers={"Cache-Control": "public, max-age=300"})


def _card_or_503(build, *args, what: str) -> Response:
    try:
        return _png(build(*args))
    except Exception:
        log.exception("%s card render failed", what)
        raise HTTPException(status_code=503, detail="preview image unavailable")


@router.get("/api/card.png")
def brand_card() -> Response:
    """Generic WeRace Timing preview image (landing / results index / fallback)."""
    return _card_or_503(cards.render_brand, what="brand")


@router.get("/api/results/{snapshot_id}/card.png")
def result_card(snapshot_id: str) -> Response:
    """Open Graph preview image for a published result."""
    record = _published_or_404(snapshot_id)
    return _card_or_503(render_result_card, record, what="result")


@router.get("/api/events/{group_id}/card.png")
def event_card(group_id: str) -> Response:
    """Open Graph preview image for a published event (group of sessions)."""
    event = get_event(group_id)   # 404 when the event has no published sessions
    return _card_or_503(render_event_card, event, what="event")


@router.get("/api/e/{slot}/card.png")
def dashboard_card(slot: int) -> Response:
    """Live Open Graph preview image for a dashboard slot (current standings)."""
    try:
        event = get_manager().get(slot)
    except KeyError:
        raise HTTPException(status_code=404, detail="No such event slot")
    return _card_or_503(render_dashboard_card, event, what="dashboard")


@router.get("/api/results/{snapshot_id}/timesheet.pdf")
def result_pdf(
    snapshot_id: str,
    charts: bool | None = None, grid: bool | None = None,
    pits: bool | None = None, stints: bool | None = None, pitest: bool | None = None,
    penalties: bool | None = None,
    event: str | None = None, session: str | None = None, accent: str | None = None,
) -> Response:
    """Public timesheet. The layout defaults to the snapshot's saved `pdf_config`
    (what the operator picked); any explicit query param overrides it."""
    record = _published_or_404(snapshot_id)
    config = snapshots.effective_pdf_config(record)
    overrides = {
        "charts": charts, "grid": grid, "pits": pits, "stints": stints,
        "pitest": pitest, "penalties": penalties,
        "event": event, "session": session, "accent": accent,
    }
    for key, value in overrides.items():
        if value is not None:
            config[key] = value
    return snapshot_pdf_response(record, **config)
