from __future__ import annotations

import asyncio
import logging
import re
import time
from contextlib import asynccontextmanager
from html import escape
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from . import snapshots
from .config import get_settings
from .events import get_manager
from .routers import admin, export, live, public, results, team

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger(__name__)

FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"


async def _snapshot_gc_loop() -> None:
    """Periodically delete saved snapshots past their 30-day expiry (unless
    flagged to keep). Runs once at startup, then on an interval."""
    interval = get_settings().snapshot_gc_interval_s
    while True:
        try:
            snapshots.gc_expired(time.time())
        except Exception:
            log.exception("snapshot GC sweep failed")
        await asyncio.sleep(max(60.0, interval))


@asynccontextmanager
async def lifespan(app: FastAPI):
    manager = get_manager()
    manager.start()
    # One-shot startup sweep + a long-lived periodic GC task (single worker).
    try:
        snapshots.gc_expired(time.time())
    except Exception:
        log.exception("startup snapshot GC failed")
    gc_task = asyncio.create_task(_snapshot_gc_loop(), name="snapshot-gc")
    yield
    gc_task.cancel()
    try:
        await gc_task
    except asyncio.CancelledError:
        pass
    await manager.stop()


app = FastAPI(title="WeRace Bridge", lifespan=lifespan)

app.include_router(live.router)
app.include_router(public.router)
app.include_router(admin.router)
app.include_router(team.router)
app.include_router(export.router)
app.include_router(results.router)


_RESULTS_PATH = re.compile(r"^results/([A-Za-z0-9_-]+)$")
_EVENTS_PATH = re.compile(r"^events/([A-Za-z0-9_-]+)$")
_DASH_PATH = re.compile(r"^e/(\d+)(?:/.*)?$")


def _og_tags(title: str, description: str, url: str, image: str) -> str:
    def esc(v: str) -> str:
        return escape(v, quote=True)
    tags = {
        "og:type": "website", "og:site_name": "WeRace Timing",
        "og:title": title, "og:description": description, "og:url": url, "og:image": image,
        "twitter:card": "summary_large_image",
        "twitter:title": title, "twitter:description": description, "twitter:image": image,
    }
    lines = []
    for key, value in tags.items():
        attr = "name" if key.startswith("twitter:") else "property"
        lines.append(f'<meta {attr}="{key}" content="{esc(value)}" />')
    return "".join(lines)


_BRAND_META = {
    "title": "WeRace Timing — Live kart timing",
    "description": "Real-time race dashboards, live results and shareable timing for kart racing.",
    "image_path": "/api/card.png",
    "url_path": "/",
}


def _dashboard_meta(slot: int) -> dict | None:
    """Live Open Graph meta for a dashboard slot, or None when the slot is out of
    range. The card image reflects the current standings."""
    try:
        event = get_manager().get(slot)
    except KeyError:
        return None
    race = event.state.effective_race()
    name = race.event_name or f"Event {slot}"
    parts = [race.track_name]
    if event.state.drivers:
        parts.append(f"{len(event.state.drivers)} karts")
    detail = " · ".join(p for p in parts if p)
    return {
        "title": f"{name} — Live timing",
        "description": " — ".join(b for b in (detail, "Live kart timing") if b),
        "image_path": f"/api/e/{slot}/card.png",
        "url_path": f"/e/{slot}",
    }


def _meta_for_path(path: str) -> dict:
    """Open Graph meta for any SPA route — per-result / per-event / per-dashboard
    where applicable, else the brand default (so every page previews)."""
    m = _RESULTS_PATH.match(path)
    if m:
        record = snapshots.load_record(m.group(1))
        if record and record.get("published"):
            return snapshots.og_meta(record)
    m = _EVENTS_PATH.match(path)
    if m:
        meta = snapshots.event_og_meta(m.group(1))
        if meta:
            return meta
    m = _DASH_PATH.match(path)
    if m:
        meta = _dashboard_meta(int(m.group(1)))
        if meta:
            return meta
    return _BRAND_META


def _spa_html(path: str, request) -> str | None:
    """index.html with Open Graph meta injected for the given SPA route."""
    try:
        html = (FRONTEND_DIST / "index.html").read_text(encoding="utf-8")
    except OSError:
        return None
    meta = _meta_for_path(path)
    base = get_settings().public_base_url.rstrip("/") or str(request.base_url).rstrip("/")
    tags = _og_tags(meta["title"], meta["description"],
                    base + meta["url_path"], base + meta["image_path"])
    html = re.sub(r"<title>.*?</title>", f"<title>{escape(meta['title'])}</title>", html, count=1)
    return html.replace("</head>", tags + "</head>", 1)


if FRONTEND_DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str, request: Request):
        """Serve the built SPA; SPA routes fall back to index.html with Open Graph
        meta injected (per result/event/dashboard, else the brand default)."""
        candidate = (FRONTEND_DIST / path).resolve()
        if (
            path
            and candidate.is_file()
            and candidate.is_relative_to(FRONTEND_DIST.resolve())
        ):
            return FileResponse(candidate)
        html = _spa_html(path, request)
        if html is not None:
            return HTMLResponse(html, headers={"Cache-Control": "no-cache"})
        return FileResponse(FRONTEND_DIST / "index.html")
