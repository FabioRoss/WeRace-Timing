from __future__ import annotations

import asyncio
import logging
import ssl
import time
from typing import Awaitable, Callable

import websockets

from ..models import DriverRow, RaceInfo, SourceConfig, SourceStatus

log = logging.getLogger(__name__)

# on_data(race_info_or_None, drivers_or_None) — decoders push normalized updates
OnData = Callable[[RaceInfo | None, list[DriverRow] | None], Awaitable[None]]
OnFrame = Callable[[str], None]


def _is_tls_error(exc: BaseException) -> bool:
    """True when a wss:// handshake died at the TLS layer (the port likely
    speaks plain ws, e.g. Apex Timing's per-track ports)."""
    return isinstance(exc, (ssl.SSLError, ConnectionResetError))


class BaseSource:
    """A timing feed for one event slot. Subclasses decode frames."""

    def __init__(self, config: SourceConfig, on_data: OnData, on_frame: OnFrame | None = None) -> None:
        self.config = config
        self.on_data = on_data
        self.on_frame = on_frame  # recorder hook, receives every raw frame
        self.status = SourceStatus(kind=config.kind, label=config.label, url=config.url)
        # Set once the first connect attempt has succeeded or failed, so the
        # connect endpoint can report a real outcome instead of "scheduled".
        self.first_attempt = asyncio.Event()
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._run_guard(), name=f"source-{self.config.kind}")

    async def _run_guard(self) -> None:
        try:
            await self._run()
        finally:
            self.first_attempt.set()

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                # Bounded: a source stuck in a close handshake must not stall
                # the disconnect endpoint.
                await asyncio.wait_for(self._task, timeout=5)
            except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
                pass
            self._task = None
        self.status.connected = False
        self.status.error = ""
        log.info("source %s stopped", self.config.label or self.config.url)

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
        url = self.config.url
        while True:
            fell_back = False
            try:
                async with websockets.connect(
                    url,
                    additional_headers=self._headers(),
                    open_timeout=15,
                    close_timeout=5,
                    ping_interval=20,
                    ping_timeout=20,
                    max_size=4 * 1024 * 1024,
                ) as ws:
                    log.info("connected to %s", url)
                    self.status.connected = True
                    self.status.error = ""
                    self.first_attempt.set()
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
                log.warning("source %s disconnected: %s", url, self.status.error)
                # Some upstream servers (Apex Timing) speak plain ws on their
                # timing ports; if TLS itself fails, retry once without it and
                # keep the downgraded scheme for later reconnects.
                if url.startswith("wss://") and _is_tls_error(exc):
                    url = "ws://" + url[len("wss://"):]
                    self.status.url = url
                    log.warning(
                        "source %s: TLS handshake failed, retrying as %s",
                        self.config.url, url,
                    )
                    fell_back = True
            self.status.connected = False
            if fell_back:
                continue
            self.first_attempt.set()
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)

    async def _heartbeat(self, ws) -> None:
        while True:
            await asyncio.sleep(self.HEARTBEAT_INTERVAL)
            try:
                await ws.send(self.HEARTBEAT)
            except Exception:
                return
