from __future__ import annotations

import asyncio
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
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


if FRONTEND_DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str) -> FileResponse:
        """Serve the built SPA; unknown routes fall back to index.html."""
        candidate = (FRONTEND_DIST / path).resolve()
        if (
            path
            and candidate.is_file()
            and candidate.is_relative_to(FRONTEND_DIST.resolve())
        ):
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIST / "index.html")
