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
    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._count = 0
        self._seek_target = 0
        self._seek_event = asyncio.Event()

    def seek(self, fraction: float) -> None:
        """Jump the playback to `fraction` (0..1) of the recording. The run
        loop rebuilds state from the start up to that point, so the standings
        and lap history match the new position."""
        if self._count <= 0:
            return
        frac = min(max(fraction, 0.0), 1.0)
        self._seek_target = min(int(frac * self._count), self._count - 1)
        self._seek_event.set()

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
        if _make_decoder(kind, self) is None:
            self.status.error = f"cannot replay recordings of kind '{kind}'"
            return

        speed = max(self.config.speed or 1.0, 0.1)
        self._count = len(records)
        first_ts = next((r.get("ts") for r in records if r.get("ts") is not None), None)
        self.status.connected = True
        self.status.error = ""
        self.status.replay_count = len(records)
        self.status.replay_duration_s = self._duration(records)
        self.first_attempt.set()
        self.status.label = self.status.label or f"Replay {path.name}"
        try:
            delegate = _make_decoder(kind, self)
            i = 0
            prev_ts = None
            while i < len(records):
                if self._seek_event.is_set():
                    self._seek_event.clear()
                    i = self._seek_target
                    # Rebuild state from the start up to the seek point with a
                    # fresh decoder, no sleeps, no re-recording.
                    delegate = _make_decoder(kind, self)
                    if self.on_reset:
                        self.on_reset()
                    for rec in records[:i]:
                        payload = rec.get("payload") or ""
                        if payload:
                            try:
                                await delegate.handle_frame(payload)
                            except Exception:
                                log.exception("replay: decoder error (seek rebuild)")
                    prev_ts = records[i - 1].get("ts") if i > 0 else None

                rec = records[i]
                ts = rec.get("ts")
                if prev_ts is not None and ts is not None:
                    delay = min(max(ts - prev_ts, 0), MAX_FRAME_GAP_S) / speed
                    try:
                        # Interruptible sleep: a seek during the wait is handled
                        # at the top of the loop.
                        await asyncio.wait_for(self._seek_event.wait(), timeout=delay)
                        continue
                    except asyncio.TimeoutError:
                        pass
                prev_ts = ts
                self.status.replay_pos = i
                self.status.replay_elapsed_s = (
                    ts - first_ts if ts is not None and first_ts is not None else None
                )
                payload = rec.get("payload") or ""
                if payload:
                    self._record(payload)
                    try:
                        await delegate.handle_frame(payload)
                    except Exception:
                        log.exception("replay: decoder error")
                i += 1
        finally:
            self.status.connected = False

    @staticmethod
    def _duration(records: list[dict]) -> float | None:
        tss = [r.get("ts") for r in records if r.get("ts") is not None]
        return (tss[-1] - tss[0]) if len(tss) >= 2 else None


def _make_decoder(kind: str, parent: ReplaySource):
    """Instantiate a protocol source purely as a frame decoder (never started)."""
    from .apex import ApexSource
    from .mywer import MyWerSource

    cls = {"mywer": MyWerSource, "apex": ApexSource}.get(kind)
    if cls is None:
        return None
    return cls(parent.config, parent.on_data)
