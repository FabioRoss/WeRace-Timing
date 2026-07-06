from __future__ import annotations

import asyncio
import logging
import time
from typing import Awaitable, Callable

import websockets

from ..models import DriverRow, RaceInfo, SourceConfig, SourceStatus

log = logging.getLogger(__name__)

# on_data(race_info_or_None, drivers_or_None) — decoders push normalized updates
OnData = Callable[[RaceInfo | None, list[DriverRow] | None], Awaitable[None]]
OnFrame = Callable[[str], None]


class BaseSource:
    """A timing feed for one event slot. Subclasses decode frames."""

    def __init__(self, config: SourceConfig, on_data: OnData, on_frame: OnFrame | None = None) -> None:
        self.config = config
        self.on_data = on_data
        self.on_frame = on_frame  # recorder hook, receives every raw frame
        self.status = SourceStatus(kind=config.kind, label=config.label, url=config.url)
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name=f"source-{self.config.kind}")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
            self._task = None
        self.status.connected = False

    async def _run(self) -> None:
        raise NotImplementedError

    async def handle_frame(self, text: str) -> None:
        """Decode one raw frame. Implemented by protocol subclasses."""
        raise NotImplementedError

    def _record(self, text: str) -> None:
        self.status.frames_received += 1
        self.status.last_frame_ts = time.time()
        if self.on_frame:
            self.on_frame(text)


class WebSocketSource(BaseSource):
    """Connects to an upstream wss feed with auto-reconnect + backoff."""

    HEARTBEAT: str | None = None      # optional keepalive text to send periodically
    HEARTBEAT_INTERVAL = 30.0

    def _headers(self) -> dict[str, str]:
        headers = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/118.0.0.0"}
        if self.config.origin:
            headers["Origin"] = self.config.origin
        return headers

    async def _run(self) -> None:
        backoff = 1.0
        while True:
            try:
                async with websockets.connect(
                    self.config.url,
                    additional_headers=self._headers(),
                    open_timeout=15,
                    ping_interval=20,
                    ping_timeout=20,
                    max_size=4 * 1024 * 1024,
                ) as ws:
                    log.info("connected to %s", self.config.url)
                    self.status.connected = True
                    self.status.error = ""
                    backoff = 1.0
                    heartbeat = None
                    if self.HEARTBEAT:
                        heartbeat = asyncio.create_task(self._heartbeat(ws))
                    try:
                        async for frame in ws:
                            if isinstance(frame, bytes):
                                frame = frame.decode("utf-8", errors="replace")
                            self._record(frame)
                            try:
                                await self.handle_frame(frame)
                            except Exception:
                                log.exception("decoder error on frame: %.200s", frame)
                    finally:
                        if heartbeat:
                            heartbeat.cancel()
            except asyncio.CancelledError:
                self.status.connected = False
                raise
            except Exception as exc:
                self.status.error = f"{type(exc).__name__}: {exc}"
                log.warning("source %s disconnected: %s", self.config.url, self.status.error)
            self.status.connected = False
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)

    async def _heartbeat(self, ws) -> None:
        while True:
            await asyncio.sleep(self.HEARTBEAT_INTERVAL)
            try:
                await ws.send(self.HEARTBEAT)
            except Exception:
                return
