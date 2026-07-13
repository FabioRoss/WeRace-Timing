from __future__ import annotations

import asyncio
import logging

from .config import get_settings
from .hub import Hub
from .models import DriverRow, Message, RaceInfo, SourceConfig, SourceStatus
from .recorder import FrameRecorder
from .sources.apex import ApexSource
from .sources.base import BaseSource
from .sources.mywer import MyWerSource
from .sources.replay import ReplaySource
from .sources.simulator import SimulatorSource

log = logging.getLogger(__name__)

SOURCE_CLASSES: dict[str, type[BaseSource]] = {
    "mywer": MyWerSource,
    "apex": ApexSource,
    "simulator": SimulatorSource,
    "replay": ReplaySource,
}

BROADCAST_INTERVAL = 1.0
MAX_MESSAGES = 200


class Event:
    """One independent event slot: source connection, state, clients, messages."""

    def __init__(self, slot: int) -> None:
        from .state import EventState

        self.slot = slot
        self.state = EventState(slot)
        self.hub = Hub()
        self.recorder = FrameRecorder(get_settings().recordings_dir)
        self.source: BaseSource | None = None
        self.messages: list[Message] = []
        self._msg_id = 0
        self._broadcast_task: asyncio.Task | None = None
        self._last_broadcast_state = -1.0
        self._last_source_status: dict | None = None

    # ---------------------------------------------------------------- source

    async def connect_source(self, config: SourceConfig) -> SourceStatus:
        await self.disconnect_source()
        cls = SOURCE_CLASSES.get(config.kind)
        if cls is None:
            raise ValueError(f"unknown source kind: {config.kind}")
        self.source = cls(config, self._on_data, self._on_frame, self._reset_state)
        self.source.start()
        # Wait (briefly) for the first connect attempt to succeed or fail so
        # the caller gets a real outcome, not just "task scheduled".
        try:
            await asyncio.wait_for(self.source.first_attempt.wait(), timeout=6)
        except asyncio.TimeoutError:
            log.warning(
                "slot %d: %s not connected after 6s, still trying", self.slot, config.url
            )
        log.info("slot %d source %s (%s): connected=%s error=%r",
                 self.slot, config.label or config.url, config.kind,
                 self.source.status.connected, self.source.status.error)
        return self.source_status()

    async def disconnect_source(self) -> None:
        if self.source:
            await self.source.stop()
            self.source = None
            # Tell dashboards immediately; no frames will arrive to trigger it.
            await self.broadcast_now()
        self.stop_recording()

    def source_status(self) -> SourceStatus:
        status = self.source.status if self.source else SourceStatus()
        status.recording = self.recorder.active
        status.recording_file = self.recorder.path.name if self.recorder.path else ""
        return status

    async def _on_data(self, race: RaceInfo | None, drivers: list[DriverRow] | None) -> None:
        self.state.update(race, drivers)

    def _on_frame(self, text: str) -> None:
        if self.recorder.active and text and self.source:
            self.recorder.write(text, {"kind": self.source.config.kind})

    def _reset_state(self) -> None:
        # A replay seek rebuilds state from the recording's start; drop the
        # accumulated laps/best/tracking so post-seek history is correct.
        self.state.reset()

    # ------------------------------------------------------------- recording

    def start_recording(self) -> str:
        label = self.source.config.label if self.source else ""
        path = self.recorder.start(self.slot, label)
        return path.name

    def stop_recording(self) -> None:
        self.recorder.stop()

    # ------------------------------------------------------------- messaging

    async def send_message(
        self,
        sender: str,
        text: str,
        target: list[str] | None = None,
        priority: str = "info",
    ) -> Message:
        self._msg_id += 1
        msg = Message(id=self._msg_id, sender=sender, target=target, text=text, priority=priority)
        self.messages.append(msg)
        if len(self.messages) > MAX_MESSAGES:
            del self.messages[0]

        # Driver channels are keyed by token; resolve kart numbers to tokens.
        from .security import make_token

        payload = {"type": "message", **msg.model_dump()}
        if target:
            for kart_no in target:
                await self.hub.send_to_driver(make_token(self.slot, "driver", kart_no), payload)
        else:
            await self.hub.broadcast_drivers(lambda _token: payload)
        # Mirror on the live channel so TM/RC/general dashboards can log it
        await self.hub.broadcast_live(payload)
        return msg

    # ------------------------------------------------------------ broadcast

    def start_broadcasting(self) -> None:
        if not self._broadcast_task:
            self._broadcast_task = asyncio.create_task(
                self._broadcast_loop(), name=f"broadcast-{self.slot}"
            )

    async def stop_broadcasting(self) -> None:
        if self._broadcast_task:
            self._broadcast_task.cancel()
            try:
                await self._broadcast_task
            except asyncio.CancelledError:
                pass
            self._broadcast_task = None
        await self.disconnect_source()

    async def _broadcast_loop(self) -> None:
        while True:
            await asyncio.sleep(BROADCAST_INTERVAL)
            try:
                # Broadcast on data updates AND on source-status transitions
                # (connect, disconnect, errors) — a failing source produces no
                # frames, so status changes must trigger pushes on their own.
                source_status = self.source_status().model_dump()
                if (
                    self.state.updated_at == self._last_broadcast_state
                    and source_status == self._last_source_status
                ):
                    continue
                self._last_broadcast_state = self.state.updated_at
                self._last_source_status = source_status
                await self.broadcast_now()
            except Exception:
                log.exception("broadcast loop error (slot %d)", self.slot)

    def driver_token_map(self) -> dict[str, str]:
        """token -> kart_no for every kart currently in the feed."""
        from .security import make_token

        return {
            make_token(self.slot, "driver", kart): kart
            for kart in self.state.kart_numbers()
        }

    def driver_payload(self, token: str, token_map: dict[str, str] | None = None) -> dict:
        token_map = token_map if token_map is not None else self.driver_token_map()
        kart = token_map.get(token)
        if kart:
            return self.state.driver_view(kart)
        return {
            "type": "driver",
            "slot": self.slot,
            "found": False,
            "flag": self.state.flag_override or self.state.race.flag,
            "time_to_go": self.state.race.time_to_go,
            "updated_at": self.state.updated_at,
        }

    async def broadcast_now(self) -> None:
        snapshot = self.state.snapshot(self.source_status()).model_dump()
        await self.hub.broadcast_live(snapshot)
        token_map = self.driver_token_map()
        await self.hub.broadcast_drivers(lambda token: self.driver_payload(token, token_map))

    def reset(self) -> None:
        self.state.reset()
        self.messages.clear()


class EventManager:
    def __init__(self, num_events: int) -> None:
        self.events: dict[int, Event] = {slot: Event(slot) for slot in range(1, num_events + 1)}

    def get(self, slot: int) -> Event:
        event = self.events.get(slot)
        if event is None:
            raise KeyError(f"no such event slot: {slot}")
        return event

    def start(self) -> None:
        for event in self.events.values():
            event.start_broadcasting()

    async def stop(self) -> None:
        for event in self.events.values():
            await event.stop_broadcasting()


manager: EventManager | None = None


def get_manager() -> EventManager:
    global manager
    if manager is None:
        manager = EventManager(get_settings().num_events)
    return manager
