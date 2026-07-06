"""Replays a recorded .ndjson frame dump through the matching protocol decoder."""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path

from ..config import get_settings
from .base import BaseSource

log = logging.getLogger(__name__)

MAX_FRAME_GAP_S = 5.0   # don't reproduce long silences


class ReplaySource(BaseSource):
    async def _run(self) -> None:
        path = (get_settings().recordings_dir / Path(self.config.file).name).resolve()
        if not path.is_file():
            self.status.error = f"recording not found: {path.name}"
            return

        records = []
        with path.open(encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    try:
                        records.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
        if not records:
            self.status.error = "recording is empty"
            return

        kind = next((r.get("kind") for r in records if r.get("kind")), "mywer")
        delegate = _make_decoder(kind, self)
        if delegate is None:
            self.status.error = f"cannot replay recordings of kind '{kind}'"
            return

        speed = max(self.config.speed or 1.0, 0.1)
        self.status.connected = True
        self.status.error = ""
        self.status.label = self.status.label or f"Replay {path.name}"
        try:
            prev_ts = None
            for rec in records:
                ts = rec.get("ts")
                if prev_ts is not None and ts is not None:
                    await asyncio.sleep(min(max(ts - prev_ts, 0), MAX_FRAME_GAP_S) / speed)
                prev_ts = ts
                payload = rec.get("payload") or ""
                if not payload:
                    continue
                self._record(payload)
                try:
                    await delegate.handle_frame(payload)
                except Exception:
                    log.exception("replay: decoder error")
        finally:
            self.status.connected = False


def _make_decoder(kind: str, parent: ReplaySource):
    """Instantiate a protocol source purely as a frame decoder (never started)."""
    from .apex import ApexSource
    from .mywer import MyWerSource

    cls = {"mywer": MyWerSource, "apex": ApexSource}.get(kind)
    if cls is None:
        return None
    return cls(parent.config, parent.on_data)
