from __future__ import annotations

import logging
import time

from .models import DriverRow, EventSnapshot, Flag, LapRecord, RaceInfo, SourceStatus
from .timeparse import parse_duration_ms

log = logging.getLogger(__name__)

MAX_LAPS_PER_KART = 2000


def _classify_gap(d: DriverRow, ref: DriverRow | None) -> str:
    """Gap string of `d` relative to `ref` from laps + cumulative time:
    same lap -> "S.mmm" seconds behind; laps down -> "+N L"."""
    if ref is None or ref is d:
        return ""
    laps_down = ref.laps - d.laps
    if laps_down > 0:
        return f"+{laps_down} L"
    if d.total_time_ms is not None and ref.total_time_ms is not None:
        delta = (d.total_time_ms - ref.total_time_ms) / 1000
        return f"{delta:.3f}" if delta >= 0 else ""
    return ""


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
        # Race-control settings: recompute standings from laps/totaltime, and
        # whether the venue has automatic pit-lane gates (else pits are inferred).
        self.recompute_positions: bool = False
        self.auto_pitlane: bool = True
        self.updated_at: float = 0.0
        # Fallback stint tracking when the source has no since-pit field
        self._pit_counts: dict[str, int] = {}
        self._stint_started: dict[str, float] = {}
        self._lap_pits: dict[str, int] = {}      # pits count at the last lap record
        self._cross_ts: dict[str, float] = {}    # wall time of the last crossing
        self._cross_ms: dict[str, int] = {}      # expected duration of the running lap
        self._clean_lap_ms: dict[str, int] = {}  # last lap NOT inflated by a pit stop
        self._auto_pits: dict[str, int] = {}     # inferred pit-stop count (no gates)

    def reset(self) -> None:
        # Preserve race-control settings across a data reset.
        settings = (self.recompute_positions, self.auto_pitlane)
        self.__init__(self.slot)
        self.recompute_positions, self.auto_pitlane = settings

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
            if self.recompute_positions:
                drivers = self._recompute_order(drivers)
            for row in drivers:
                self._track_laps(row, now)
                if not self.auto_pitlane:
                    self._infer_pit(row, now)
                self._track_stint(row, now)
            self.drivers = drivers
            self._update_session_best()
        self.updated_at = now

    def _recompute_order(self, drivers: list[DriverRow]) -> list[DriverRow]:
        """Some MyWeR uploaders never reorder karts — position stays the start
        grid and gaps read 0. Rebuild the classification from laps + cumulative
        time (most laps, then least total time) and derive gaps from it."""
        ordered = sorted(
            drivers,
            key=lambda d: (
                -d.laps,
                d.total_time_ms if d.total_time_ms is not None else float("inf"),
                d.position if d.position > 0 else 999,
            ),
        )
        leader = ordered[0] if ordered else None
        prev: DriverRow | None = None
        for rank, d in enumerate(ordered, start=1):
            d.position = rank
            d.gap_leader = _classify_gap(d, leader)
            d.gap_ahead = _classify_gap(d, prev)
            prev = d
        return ordered

    def _session_changed(self, race: RaceInfo) -> bool:
        old, new = self.race.run_type, race.run_type
        return bool(old and new and old != new and self.drivers)

    def _laps_regressed(self, drivers: list[DriverRow]) -> bool:
        """Detect a genuine session rollover (a fresh session resets every
        kart's lap count to the startline) without being fooled by two noise
        sources: a single glitched row, and MyWeR's periodic full-metadata
        refresh that carries only a stale SUBSET of the field whose lap counts
        lag by one. Require a quorum of the tracked field to be present AND to
        have fallen back to the first few laps — not a backward jitter on a
        couple of karts still deep in the race."""
        prev = {d.kart_no: d.laps for d in self.drivers}
        if not prev:
            return False
        common = [d for d in drivers if d.kart_no in prev]
        # A subset frame can't declare a rollover for the whole field.
        if len(common) * 2 < len(prev):
            return False
        # A real restart lands back at the startline; a stale high lap count
        # off by one is not a new session.
        restarted = sum(1 for d in common if d.laps <= 3 and d.laps < prev[d.kart_no])
        return restarted >= 2 and restarted * 2 >= len(common)

    def _reset_session_state(self, reason: str) -> None:
        log.info("slot %d: session rollover (%s) — clearing lap history", self.slot, reason)
        self.lap_history.clear()
        self._lap_pits.clear()
        self._cross_ts.clear()
        self._cross_ms.clear()
        self._clean_lap_ms.clear()
        self._pit_counts.clear()
        self._stint_started.clear()
        self._auto_pits.clear()
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
            # No pit-lane gates: a lap far longer than the kart's clean pace is
            # a pit stop the feed never reported — count it ourselves.
            if not self.auto_pitlane:
                clean = self._clean_lap_ms.get(row.kart_no)
                if clean and row.last_lap_ms > max(clean * 1.6, clean + 20000):
                    pitted = True
                    self._auto_pits[row.kart_no] = self._auto_pits.get(row.kart_no, 0) + 1
            self._lap_pits[row.kart_no] = row.pits
            self._cross_ts[row.kart_no] = now
            if not pitted:
                self._clean_lap_ms[row.kart_no] = row.last_lap_ms
            # Expected duration of the lap that just started: a pit-inflated
            # lap time would make the progress bar/ring crawl falsely, so use
            # the previous clean lap (+1s for the out-lap) instead.
            if pitted and row.kart_no in self._clean_lap_ms:
                self._cross_ms[row.kart_no] = self._clean_lap_ms[row.kart_no] + 1000
            else:
                self._cross_ms[row.kart_no] = row.last_lap_ms
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
        # No pit-lane gates: expose our inferred pit count continuously.
        if not self.auto_pitlane:
            row.pits = self._auto_pits.get(row.kart_no, 0)
        # Progress fallback for sources without sector events (simulator,
        # mywer): anchor a plain 0->1 bar at the last observed crossing.
        if row.prog_ts is None and not row.in_pit:
            cross = self._cross_ts.get(row.kart_no)
            expected = self._cross_ms.get(row.kart_no) or row.last_lap_ms
            if cross is not None and expected:
                row.prog_ts = cross
                row.prog_from = 0.0
                row.prog_to = 1.0
                row.prog_ms = expected

    def _infer_pit(self, row: DriverRow, now: float) -> None:
        """No pit-lane gates: a kart whose expected crossing is long overdue is
        sitting in the pit. Flag it and record when the stop really began (the
        missed crossing) so the rejoin forecast keeps that stationary time."""
        cross = self._cross_ts.get(row.kart_no)
        expected = self._cross_ms.get(row.kart_no)
        if cross and expected and not row.finished and (now - cross) > 1.5 * expected / 1000:
            row.in_pit = True
            row.pit_state = "in"
            row.pit_since_ts = cross + expected / 1000

    def _track_stint(self, row: DriverRow, now: float) -> None:
        prev_pits = self._pit_counts.get(row.kart_no)
        if prev_pits is None or row.pits > prev_pits:
            self._stint_started[row.kart_no] = now
        self._pit_counts[row.kart_no] = row.pits
        # Normalize stint: use the feed's value when it carries one, else the
        # time since we first saw the kart / its last pit (feeds like MyWeR send
        # all-zeros for "sincepit" at some venues).
        ms = parse_duration_ms(row.stint_time) if row.stint_time else None
        row.stint_seconds = ms // 1000 if ms else int(now - self._stint_started[row.kart_no])

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
            recompute_positions=self.recompute_positions,
            auto_pitlane=self.auto_pitlane,
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

        stint_seconds = row.stint_seconds if row else None

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
