from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .events import get_manager
from .routers import admin, export, live, public, team

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"


@asynccontextmanager
async def lifespan(app: FastAPI):
    manager = get_manager()
    manager.start()
    yield
    await manager.stop()


app = FastAPI(title="WeRace Bridge", lifespan=lifespan)

app.include_router(live.router)
app.include_router(public.router)
app.include_router(admin.router)
app.include_router(team.router)
app.include_router(export.router)


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
