"""Public results API — read-only access to PUBLISHED saved snapshots.

This is also the machine-readable seam for a future cross-app integration:
`GET /api/results` returns structured metadata (incl. track/tags/podium) for
every published session. Private notes and internal blocks are never exposed.
"""
from __future__ import annotations

import io
import logging
import os
import time

from fastapi import APIRouter, HTTPException, Query, Response

from .. import snapshots
from ..state import EventState
from .export import snapshot_pdf_response

router = APIRouter()
log = logging.getLogger(__name__)

# Open Graph link-preview card (1200x630 is the standard social size).
_CARD_W, _CARD_H = 1200, 630
_BG = (7, 8, 12)          # brand near-black (#07080c)
_ACCENT = (225, 6, 0)     # brand red (#e10600)
_INK = (240, 242, 245)
_MUTED = (150, 156, 168)
_FONT_DIR = "/usr/share/fonts/truetype/dejavu"


def _load_font(size: int, bold: bool = False):
    from PIL import ImageFont
    path = os.path.join(_FONT_DIR, "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf")
    if os.path.exists(path):
        return ImageFont.truetype(path, size)
    return ImageFont.load_default()


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


def _wrap(draw, text: str, font, max_w: int) -> list[str]:
    words, lines, cur = text.split(), [], ""
    for w in words:
        trial = f"{cur} {w}".strip()
        if draw.textlength(trial, font=font) <= max_w:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines[:3]


def render_card_png(record: dict) -> bytes:
    from PIL import Image, ImageDraw

    meta = snapshots.meta_of(record)
    img = Image.new("RGB", (_CARD_W, _CARD_H), _BG)
    draw = ImageDraw.Draw(img)
    draw.rectangle((0, 0, _CARD_W, 10), fill=_ACCENT)          # top accent bar
    pad = 72

    draw.text((pad, 60), "RESULTS", font=_load_font(30, True), fill=_ACCENT)

    y = 110
    for line in _wrap(draw, meta["name"] or "Results", _load_font(58, True), _CARD_W - 2 * pad):
        draw.text((pad, y), line, font=_load_font(58, True), fill=_INK)
        y += 70

    date = time.strftime("%d %b %Y", time.localtime(record.get("created_at") or time.time()))
    sub = " · ".join(b for b in (meta["track"], f"{meta['driver_count']} karts", date) if b)
    draw.text((pad, y + 6), sub, font=_load_font(30), fill=_MUTED)

    py = y + 78
    for p in meta["podium"]:
        draw.text((pad, py), f"P{p['position']}", font=_load_font(40, True), fill=_ACCENT)
        name = f"#{p['kart_no']} {p['name']}".strip()
        draw.text((pad + 90, py + 4), name, font=_load_font(38), fill=_INK)
        py += 60

    draw.text((pad, _CARD_H - 60), "WeRace Timing", font=_load_font(26, True), fill=_MUTED)

    out = io.BytesIO()
    img.save(out, format="PNG")
    return out.getvalue()


@router.get("/api/results/{snapshot_id}/card.png")
def result_card(snapshot_id: str) -> Response:
    """Open Graph preview image for a published result (used in link previews)."""
    record = _published_or_404(snapshot_id)
    try:
        png = render_card_png(record)
    except Exception:
        log.exception("result card render failed for %s", snapshot_id)
        raise HTTPException(status_code=503, detail="preview image unavailable")
    return Response(
        content=png,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=300"},
    )


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
