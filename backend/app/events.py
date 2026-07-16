from __future__ import annotations

import asyncio
import logging
import time

from . import snapshots
from .config import get_settings
from .hub import Hub
from .models import DriverRow, Flag, Message, Penalty, RaceInfo, SourceConfig, SourceStatus
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


def _penalty_message_text(penalty: Penalty) -> str:
    """Team-facing notification text for a penalty/warning."""
    reason = penalty.reason.strip()
    if penalty.kind == "warning":
        base = "Warning"
    elif penalty.kind == "lap":
        base = f"Penalty: -{penalty.laps} lap" + ("s" if penalty.laps != 1 else "")
    else:
        base = f"Penalty: +{penalty.seconds}s"
    return f"{base} - {reason}" if reason else base


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
        # Pending (delayed) team notifications for freshly-assigned penalties,
        # keyed by penalty id, so a quick delete can cancel one before it fires.
        self._pending_notify: dict[int, asyncio.Task] = {}
        self._broadcast_task: asyncio.Task | None = None
        self._last_broadcast_state = -1.0
        self._last_source_status: dict | None = None
        # End-of-session auto-save fires once per session; re-armed on rollover.
        self._auto_saved = False
        self._last_generation = self.state.session_generation
        # Previous flag, to re-arm the auto-save when a new session warms up
        # (MyWeR reuses the same generation across back-to-back W→G→S sessions).
        self._prev_flag = Flag.NONE

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
        # A new session (rollover) re-arms the one-shot end-of-session auto-save.
        if self.state.session_generation != self._last_generation:
            self._last_generation = self.state.session_generation
            self._auto_saved = False
        # MyWeR runs back-to-back sessions within one generation (…S then W for
        # the next). The edge into WARMUP marks a fresh session, so re-arm there
        # too — the prior session's STOPPED save stays put, the next one saves.
        flag = self.state.race.flag
        if flag == Flag.WARMUP and self._prev_flag != Flag.WARMUP:
            self._auto_saved = False
        self._prev_flag = flag
        self._auto_save_if_ended(time.time(), idle=False)

    # ------------------------------------------------- end-of-session auto-save

    def _worth_saving(self) -> bool:
        """Only archive a session that actually ran — never an empty or
        never-started one (the guard against saving bad/empty data)."""
        return bool(self.state.drivers) and any(d.laps > 0 for d in self.state.drivers)

    def _auto_save_if_ended(self, now: float, *, idle: bool) -> None:
        """Auto-save once when the session looks finished. Most feeds never set
        `ended`, so we also infer it from the checkered flag and — when `idle`
        (checked each broadcast tick) — from the feed going quiet while still
        connected."""
        if self._auto_saved or not self._worth_saving():
            return
        terminal = getattr(self.source, "terminal_flags", {Flag.FINISH})
        ended = self.state.race.ended or self.state.race.flag in terminal
        if not ended and idle:
            # A session that actually ran (guarded by _worth_saving) whose feed
            # has gone quiet is finished — whether the source is still connected,
            # dropped at the finish, or a replay that reached its end.
            ended = now - self.state.updated_at > get_settings().autosave_idle_s
        if not ended:
            return
        try:
            self.save_snapshot("auto")
            self._auto_saved = True
        except Exception:
            log.exception("slot %d: auto-save snapshot failed", self.slot)

    # -------------------------------------------------------------- snapshots

    def build_record(self, trigger: str) -> dict:
        """A full, self-contained saved-snapshot record (see app/snapshots.py)."""
        race = self.state.race
        now = time.time()
        session = race.run_type
        date = time.strftime("%d %b %Y", time.localtime(now))
        name = " — ".join(
            p for p in (race.event_name or f"Event {self.slot}", session, date) if p
        )
        ttl_days = get_settings().snapshot_ttl_days
        return {
            "version": snapshots.SNAPSHOT_VERSION,
            "id": snapshots.make_id(name),
            "slot": self.slot,
            "created_at": now,
            "expires_at": now + ttl_days * 86400,
            "keep": False,
            "published": False,
            "trigger": trigger,
            "name": name,
            "track": race.track_name,
            "tags": [],
            "private_notes": "",
            "public_notes": "",
            "pdf_config": {},
            "group_id": None,
            "group_name": "",
            **self.state.export_state(self.source_status()),
            "messages": [m.model_dump() for m in self.messages],
            # As-finished penalties, so amendments can be reverted later.
            "original_penalties": [p.model_dump() for p in self.state.penalties],
        }

    def save_snapshot(self, trigger: str) -> str:
        record = self.build_record(trigger)
        snapshots.write_record(record)
        # Any save (manual too) arms the once-guard so the inferred end-of-race
        # save can't duplicate this session; a rollover/reset re-arms it.
        self._auto_saved = True
        log.info("slot %d: saved snapshot %s (%s)", self.slot, record["id"], trigger)
        return record["id"]

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

    # ------------------------------------------------- penalty notifications

    def schedule_penalty_notify(self, penalty: Penalty) -> None:
        """Notify the penalized kart's team after a short grace delay, so Race
        Control can delete a mistake first (cancel_penalty_notify)."""
        # Penalties hidden from teams (RC config): don't notify them either.
        if self.state.hide_team_penalties:
            return
        delay = get_settings().penalty_notify_delay_s
        task = asyncio.create_task(
            self._notify_penalty_after(penalty, delay),
            name=f"penalty-notify-{self.slot}-{penalty.id}",
        )
        self._pending_notify[penalty.id] = task

    def cancel_penalty_notify(self, penalty_id: int) -> None:
        task = self._pending_notify.pop(penalty_id, None)
        if task is not None:
            task.cancel()

    async def _notify_penalty_after(self, penalty: Penalty, delay: float) -> None:
        try:
            if delay > 0:
                await asyncio.sleep(delay)
            # The penalty may have been deleted during the grace window.
            if self.state.find_penalty(penalty.id) is None:
                return
            # …or penalties may have been hidden from teams during the grace window.
            if self.state.hide_team_penalties:
                return
            text = _penalty_message_text(penalty)
            priority = "warning" if penalty.kind == "warning" else "urgent"
            await self.send_message("race_control", text, [penalty.kart_no], priority)
            penalty.notified = True
            await self.broadcast_now()
        except asyncio.CancelledError:
            pass
        finally:
            self._pending_notify.pop(penalty.id, None)

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
                # Runs every tick even when nothing changed, so a session whose
                # feed has gone quiet still gets its inferred end-of-race save.
                self._auto_save_if_ended(time.time(), idle=True)
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
        self._auto_saved = False
        self._last_generation = self.state.session_generation
        self._prev_flag = Flag.NONE
        for task in self._pending_notify.values():
            task.cancel()
        self._pending_notify.clear()


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
