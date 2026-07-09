from __future__ import annotations

import logging
import time

from .models import DriverRow, EventSnapshot, Flag, LapRecord, RaceInfo, SourceStatus

log = logging.getLogger(__name__)

MAX_LAPS_PER_KART = 2000


class EventState:
    """Normalized live state for one event slot.

    Decoders push race info + full driver standings here; the state derives
    lap history, session best and per-driver views (gap ahead/behind, stint).
    """

    def __init__(self, slot: int) -> None:
        self.slot = slot
        self.race = RaceInfo()
        self.drivers: list[DriverRow] = []
        self.lap_history: dict[str, list[LapRecord]] = {}
        self.session_best_ms: int | None = None
        self.session_best_kart: str = ""
        # Race-control flag override (organizers without track-system access);
        # None = mirror the timing feed's flag.
        self.flag_override: Flag | None = None
        self.updated_at: float = 0.0
        # Fallback stint tracking when the source has no since-pit field
        self._pit_counts: dict[str, int] = {}
        self._stint_started: dict[str, float] = {}
        self._lap_pits: dict[str, int] = {}      # pits count at the last lap record
        self._cross_ts: dict[str, float] = {}    # wall time of the last crossing

    def reset(self) -> None:
        self.__init__(self.slot)

    # ------------------------------------------------------------------ input

    def update(self, race: RaceInfo | None, drivers: list[DriverRow] | None) -> None:
        now = time.time()
        if race is not None:
            if self._session_changed(race):
                self._reset_session_state("session name changed")
            self.race = race
        if drivers is not None:
            drivers = sorted(drivers, key=lambda d: d.position if d.position > 0 else 999)
            # Safety net: never let duplicate kart numbers reach the dashboards
            # (keep the best-positioned row per kart).
            seen: set[str] = set()
            unique: list[DriverRow] = []
            dropped: set[str] = set()
            for row in drivers:
                if row.kart_no in seen:
                    dropped.add(row.kart_no)
                    continue
                seen.add(row.kart_no)
                unique.append(row)
            if dropped:
                log.warning(
                    "slot %d: dropped duplicate driver rows for karts %s",
                    self.slot, sorted(dropped),
                )
            drivers = unique
            if self._laps_regressed(drivers):
                self._reset_session_state("lap counts regressed")
            for row in drivers:
                self._track_laps(row, now)
                self._track_stint(row, now)
            self.drivers = drivers
            self._update_session_best()
        self.updated_at = now

    def _session_changed(self, race: RaceInfo) -> bool:
        old, new = self.race.run_type, race.run_type
        return bool(old and new and old != new and self.drivers)

    def _laps_regressed(self, drivers: list[DriverRow]) -> bool:
        """A new session resets lap counts; require a quorum of regressing
        karts so a single glitched row can't wipe the history."""
        prev = {d.kart_no: d.laps for d in self.drivers}
        common = [d for d in drivers if d.kart_no in prev]
        regressed = sum(1 for d in common if d.laps < prev[d.kart_no])
        return regressed >= 2 and regressed * 2 >= len(common)

    def _reset_session_state(self, reason: str) -> None:
        log.info("slot %d: session rollover (%s) — clearing lap history", self.slot, reason)
        self.lap_history.clear()
        self._lap_pits.clear()
        self._cross_ts.clear()
        self._pit_counts.clear()
        self._stint_started.clear()
        self.session_best_ms = None
        self.session_best_kart = ""

    def _track_laps(self, row: DriverRow, now: float) -> None:
        history = self.lap_history.setdefault(row.kart_no, [])
        last_recorded = history[-1].lap_no if history else 0
        if row.laps > last_recorded and row.last_lap_ms:
            pitted = (
                row.pits > self._lap_pits.get(row.kart_no, row.pits)
                or row.in_pit
            )
            self._lap_pits[row.kart_no] = row.pits
            self._cross_ts[row.kart_no] = now
            history.append(
                LapRecord(
                    kart_no=row.kart_no,
                    lap_no=row.laps,
                    lap_ms=row.last_lap_ms,
                    position=row.position,
                    pit=pitted,
                    ts=now,
                )
            )
            if len(history) > MAX_LAPS_PER_KART:
                del history[0]
        # Progress fallback for sources without sector events (simulator,
        # mywer): anchor a plain 0->1 bar at the last observed crossing.
        if row.prog_ts is None and not row.in_pit:
            cross = self._cross_ts.get(row.kart_no)
            if cross is not None and row.last_lap_ms:
                row.prog_ts = cross
                row.prog_from = 0.0
                row.prog_to = 1.0
                row.prog_ms = row.last_lap_ms

    def _track_stint(self, row: DriverRow, now: float) -> None:
        prev_pits = self._pit_counts.get(row.kart_no)
        if prev_pits is None or row.pits > prev_pits:
            self._stint_started[row.kart_no] = now
        self._pit_counts[row.kart_no] = row.pits

    def _update_session_best(self) -> None:
        best: tuple[int, str] | None = None
        for row in self.drivers:
            if row.best_lap_ms and (best is None or row.best_lap_ms < best[0]):
                best = (row.best_lap_ms, row.kart_no)
        if best:
            self.session_best_ms, self.session_best_kart = best

    # ----------------------------------------------------------------- output

    def effective_race(self) -> RaceInfo:
        if self.flag_override is None:
            return self.race
        return self.race.model_copy(update={"flag": self.flag_override})

    def snapshot(self, source: SourceStatus) -> EventSnapshot:
        return EventSnapshot(
            slot=self.slot,
            race=self.effective_race(),
            drivers=self.drivers,
            source=source,
            flag_override=self.flag_override,
            session_best_ms=self.session_best_ms,
            session_best_kart=self.session_best_kart,
            updated_at=self.updated_at,
        )

    def kart_numbers(self) -> list[str]:
        return [d.kart_no for d in self.drivers if d.kart_no]

    def find(self, kart_no: str) -> DriverRow | None:
        for row in self.drivers:
            if row.kart_no == kart_no:
                return row
        return None

    def driver_view(self, kart_no: str) -> dict:
        """Compact payload for the driver dashboard."""
        row = self.find(kart_no)
        idx = self.drivers.index(row) if row else -1
        ahead = self.drivers[idx - 1] if row and idx > 0 else None
        behind = self.drivers[idx + 1] if row and idx + 1 < len(self.drivers) else None

        stint_seconds: int | None = None
        if row:
            if row.stint_time:
                from .timeparse import parse_duration_ms

                ms = parse_duration_ms(row.stint_time)
                stint_seconds = ms // 1000 if ms else None
            if stint_seconds is None and row.kart_no in self._stint_started:
                stint_seconds = int(time.time() - self._stint_started[row.kart_no])

        return {
            "type": "driver",
            "slot": self.slot,
            "kart_no": kart_no,
            "found": row is not None,
            "position": row.position if row else 0,
            "total_karts": len(self.drivers),
            "name": row.name if row else "",
            "last_lap_ms": row.last_lap_ms if row else None,
            "best_lap_ms": row.best_lap_ms if row else None,
            "laps": row.laps if row else 0,
            "pits": row.pits if row else 0,
            "gap_ahead": row.gap_ahead if row else "",
            "gap_behind": behind.gap_ahead if behind else "",
            "kart_ahead": ahead.kart_no if ahead else "",
            "kart_behind": behind.kart_no if behind else "",
            "gap_leader": row.gap_leader if row else "",
            "stint_seconds": stint_seconds,
            "in_pit": row.in_pit if row else False,
            "finished": row.finished if row else False,
            "flag": self.flag_override or self.race.flag,
            "time_to_go": self.race.time_to_go,
            "togo_ms": self.race.togo_ms,
            "togo_ts": self.race.togo_ts,
            "counting": self.race.counting,
            "race_time": self.race.race_time,
            "run_type": self.race.run_type,
            "ended": self.race.ended,
            "session_best_ms": self.session_best_ms,
            "updated_at": self.updated_at,
        }

    def lap_chart(self, karts: list[str] | None = None, last_n: int = 300) -> dict:
        """Lap history for team-manager analysis charts."""
        selected = karts or self.kart_numbers()
        return {
            kart: [
                {
                    "lap": rec.lap_no, "ms": rec.lap_ms, "pos": rec.position,
                    "pit": rec.pit, "ts": rec.ts,
                }
                for rec in self.lap_history.get(kart, [])[-last_n:]
            ]
            for kart in selected
        }
