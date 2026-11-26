from __future__ import annotations

import logging
import statistics
import time

from .models import DriverRow, EventSnapshot, Flag, LapRecord, Penalty, RaceInfo, SourceStatus
from .timeparse import parse_duration_ms

log = logging.getLogger(__name__)

MAX_LAPS_PER_KART = 2000


def infer_pit_laps(records: list[LapRecord]) -> set[int]:
    """Lap numbers that look like a pit / stationary lap, judged from the kart's
    own pace: a lap well over its median is a stop the feed never flagged
    (venues without pit-lane gates) or one the incremental detector missed
    because it had no clean baseline yet (e.g. right after a session reset).

    Mirrors the `_track_laps` heuristic but as a stateless global pass, so a
    fresh recompute always finds every pit lap present in the data regardless of
    what was flagged live. Callers OR this with each record's stored `pit` flag,
    so a genuine pit reported by the feed is never dropped.
    """
    times = [r.lap_ms for r in records if r.lap_ms and r.lap_ms > 0]
    if len(times) < 3:
        return set()
    base = statistics.median(times)
    threshold = max(base * 1.6, base + 20000)
    return {r.lap_no for r in records if r.lap_ms and r.lap_ms > threshold}


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
        # Feed-reported pit stops per kart: (lap_no, pit_duration_ms). Only
        # populated on venues whose feed reports pits (gates); the PDF uses it
        # for accurate per-stop times there.
        self.pit_stops: dict[str, list[tuple[int, int]]] = {}
        self.session_best_ms: int | None = None
        self.session_best_kart: str = ""
        # Race-control flag override (organizers without track-system access);
        # None = mirror the timing feed's flag.
        self.flag_override: Flag | None = None
        # Race-control settings: recompute standings from laps/totaltime, and
        # whether the venue has automatic pit-lane gates (else pits are inferred).
        self.recompute_positions: bool = False
        self.auto_pitlane: bool = True
        # Hide the penalty panels on the team dashboard (race control decides
        # when teams may see penalties, e.g. only after the session).
        self.hide_team_penalties: bool = False
        # Race rules shown on the Race Control pit board: minimum pit-lane time
        # and maximum stint length, in seconds (0 = no limit).
        self.min_pit_s: int = 0
        self.max_stint_s: int = 0
        # Staff-chosen defaults for the team Instagram-story graphic (title,
        # subtitle, session label, accent, which stats, saved background, footer
        # link). Empty = use the renderer's own fallbacks. Preserved across a
        # data reset like the other race-control settings.
        self.team_story_config: dict = {}
        self.updated_at: float = 0.0
        # Bumped on every session rollover; the Event uses it to re-arm the
        # one-shot end-of-session auto-save for each new session.
        self.session_generation: int = 0
        # Fallback stint tracking when the source has no since-pit field
        self._pit_counts: dict[str, int] = {}
        self._stint_started: dict[str, float] = {}
        self._lap_pits: dict[str, int] = {}      # pits count at the last lap record
        self._cross_ts: dict[str, float] = {}    # wall time of the last crossing
        self._cross_ms: dict[str, int] = {}      # expected duration of the running lap
        self._clean_lap_ms: dict[str, int] = {}  # last lap NOT inflated by a pit stop
        self._auto_pits: dict[str, int] = {}     # inferred pit-stop count (no gates)
        # Pit board (gate venues): per-kart stop durations and completed stints.
        self._pit_times: dict[str, list[int]] = {}
        self._pit_confirmed: dict[str, bool] = {}  # last stop carries the feed's time
        self._pit_pending: dict[str, int] = {}     # feed time seen while still in pit
        self._pit_seen_ms: dict[str, int] = {}     # last feed last_pit_ms seen
        self._pit_entry: dict[str, float] = {}     # wall time the kart entered the pit
        self._was_in_pit: dict[str, bool] = {}
        self._prev_stint: dict[str, int] = {}      # stint seconds on the previous frame
        self._stints: dict[str, list[int]] = {}
        # --- Penalties & warnings (race control) -------------------------------
        # In-memory only, like team messages: a server restart mid-race loses
        # these. This list + `_penalty_id` are the single storage seam — nothing
        # else touches penalties directly. To persist later, serialize this list
        # per slot (e.g. to a file under a named volume, mirroring recordings)
        # whenever it changes and reload it here in __init__.
        self.penalties: list[Penalty] = []
        self._penalty_id: int = 0

    def reset(self) -> None:
        # Preserve race-control settings across a data reset.
        settings = (self.recompute_positions, self.auto_pitlane, self.hide_team_penalties,
                    self.team_story_config, self.min_pit_s, self.max_stint_s)
        self.__init__(self.slot)
        (self.recompute_positions, self.auto_pitlane, self.hide_team_penalties,
         self.team_story_config, self.min_pit_s, self.max_stint_s) = settings

    # ------------------------------------------------------- penalties & warnings

    def add_penalty(
        self, kart_no: str, kind: str, *, seconds: int = 0, laps: int = 0, reason: str = ""
    ) -> Penalty:
        self._penalty_id += 1
        pen = Penalty(
            id=self._penalty_id,
            kart_no=kart_no,
            kind=kind,  # type: ignore[arg-type]
            seconds=seconds,
            laps=laps,
            reason=reason,
        )
        self.penalties.append(pen)
        return pen

    def find_penalty(self, penalty_id: int) -> Penalty | None:
        for pen in self.penalties:
            if pen.id == penalty_id:
                return pen
        return None

    def set_penalty_served(self, penalty_id: int, served: bool) -> Penalty | None:
        pen = self.find_penalty(penalty_id)
        if pen is not None:
            pen.served = served
        return pen

    def remove_penalty(self, penalty_id: int) -> Penalty | None:
        pen = self.find_penalty(penalty_id)
        if pen is not None:
            self.penalties.remove(pen)
        return pen

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
            if self._is_partial_refresh(drivers):
                # MyWeR periodically emits a full-metadata frame carrying only a
                # stale subset of the field. It must not replace the live
                # standings (the table would collapse to those few karts for a
                # frame); the next full frame ~1s later carries everyone.
                log.debug(
                    "slot %d: ignoring partial driver refresh (%d of %d karts)",
                    self.slot, len(drivers), len(self.drivers),
                )
                self.updated_at = now
                return
            if self._laps_regressed(drivers):
                self._reset_session_state("lap counts regressed")
            if self.recompute_positions:
                drivers = self._recompute_order(drivers)
            for row in drivers:
                self._track_laps(row, now)
                if not self.auto_pitlane:
                    self._infer_pit(row, now)
                self._track_stint(row, now)
                if self.auto_pitlane:
                    self._track_pit_board(row, now)
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

    def _is_partial_refresh(self, drivers: list[DriverRow]) -> bool:
        """True for a frame that covers far less of the field than we are
        already tracking — MyWeR's periodic full-metadata refresh ships only a
        stale two-kart subset. Inert on the first population (nothing tracked)
        and on genuinely small fields, so a real field shrink still lands."""
        tracked = len(self.drivers)
        return tracked >= 4 and len(drivers) * 2 < tracked

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
        self.session_generation += 1
        self.lap_history.clear()
        self.pit_stops.clear()
        self._lap_pits.clear()
        self._cross_ts.clear()
        self._cross_ms.clear()
        self._clean_lap_ms.clear()
        self._pit_counts.clear()
        self._stint_started.clear()
        self._auto_pits.clear()
        for board in (self._pit_times, self._pit_confirmed, self._pit_pending, self._pit_seen_ms,
                      self._pit_entry, self._was_in_pit, self._prev_stint, self._stints):
            board.clear()
        # A genuine new session voids the previous session's penalties/warnings.
        self.penalties.clear()
        self.session_best_ms = None
        self.session_best_kart = ""

    def _track_laps(self, row: DriverRow, now: float) -> None:
        history = self.lap_history.setdefault(row.kart_no, [])
        last_recorded = history[-1].lap_no if history else 0
        if row.laps > last_recorded and row.last_lap_ms:
            # The feed reported a completed pit (its counter went up): record the
            # lap + its measured duration for the pit-stops table (gate venues).
            feed_pit = row.pits > self._lap_pits.get(row.kart_no, row.pits)
            if feed_pit:
                self.pit_stops.setdefault(row.kart_no, []).append(
                    (row.laps, row.last_pit_ms or 0)
                )
            pitted = feed_pit or row.in_pit
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

    def _track_pit_board(self, row: DriverRow, now: float) -> None:
        """Gate venues: each pit stop's duration and each stint's length, for the
        Race Control pit board (min pit time / max stint checks).

        A stop's time is the feed's own `last_pit_ms` when it reports one (the
        gates measure it); otherwise our in->out measurement. The feed may update
        `last_pit_ms` before or after its in-pit flag drops, so a feed time seen
        while in the pit is held until the exit, and one seen after the exit
        replaces the measured value."""
        kart = row.kart_no
        times = self._pit_times.setdefault(kart, [])
        stints = self._stints.setdefault(kart, [])
        was_in = self._was_in_pit.get(kart, False)

        # Entering the pit: the stint that just ended, and the stop's start.
        if row.in_pit and not was_in:
            self._pit_entry[kart] = now
            self._pit_pending.pop(kart, None)
            # Feeds differ on whether their since-pit clock resets at pit entry
            # or exit: take the larger of this frame's and the last on-track one.
            ended = max(row.stint_seconds or 0, self._prev_stint.get(kart, 0))
            # (< 10 s: a kart first seen just before it pits — not a stint.)
            if ended >= 10 and kart in self._was_in_pit:
                stints.append(ended)
        # Leaving: the stop is complete.
        if was_in and not row.in_pit:
            entry = self._pit_entry.pop(kart, None)
            pending = self._pit_pending.pop(kart, None)
            if pending:
                times.append(pending)
                self._pit_confirmed[kart] = True
            elif entry is not None:
                times.append(int((now - entry) * 1000))
                self._pit_confirmed[kart] = False

        # The feed's own time for the latest stop.
        feed = row.last_pit_ms or 0
        if feed and feed != self._pit_seen_ms.get(kart):
            first_sight = kart not in self._pit_seen_ms
            self._pit_seen_ms[kart] = feed
            if row.in_pit:
                self._pit_pending[kart] = feed
            elif times and not self._pit_confirmed.get(kart, True):
                times[-1] = feed
                self._pit_confirmed[kart] = True
            elif not (first_sight and not row.pits):
                # A stop we never saw go in/out (e.g. connected mid-race).
                times.append(feed)
                self._pit_confirmed[kart] = True

        self._was_in_pit[kart] = row.in_pit
        if not row.in_pit:
            self._prev_stint[kart] = row.stint_seconds or 0
        if row.in_pit and kart in self._pit_entry:
            row.pit_since_ts = self._pit_entry[kart]
        row.pit_times_ms = list(times)
        row.stints_s = list(stints)

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

    def snapshot(self, source: SourceStatus, *, public: bool = False) -> EventSnapshot:
        """The dashboards' state. `public` = for anyone but staff: while race
        control holds penalties back, they are left out entirely (not merely
        hidden by the UI) — the public page and its feed are open to everyone.
        Saved records and staff sockets use the full version."""
        held = public and self.hide_team_penalties
        return EventSnapshot(
            slot=self.slot,
            race=self.effective_race(),
            drivers=self.drivers,
            source=source,
            flag_override=self.flag_override,
            recompute_positions=self.recompute_positions,
            auto_pitlane=self.auto_pitlane,
            hide_team_penalties=self.hide_team_penalties,
            min_pit_s=self.min_pit_s,
            max_stint_s=self.max_stint_s,
            team_story_config=dict(self.team_story_config),
            session_best_ms=self.session_best_ms,
            session_best_kart=self.session_best_kart,
            penalties=[] if held else list(self.penalties),
            updated_at=self.updated_at,
            server_ts=time.time(),
        )

    # ----------------------------------------------- snapshot persistence seam
    # A saved snapshot is the live EventSnapshot plus the two collections the
    # snapshot omits but the PDF needs (lap_history, pit_stops) and the penalty
    # id counter (so amendments after a reload don't collide). The eight private
    # tracking dicts are live-frame scratch only — a static saved snapshot never
    # processes new frames, so they are deliberately dropped.

    def export_state(self, source: SourceStatus) -> dict:
        return {
            "snapshot": self.snapshot(source).model_dump(),
            "lap_history": {
                k: [r.model_dump() for r in v] for k, v in self.lap_history.items()
            },
            "pit_stops": {k: [list(t) for t in v] for k, v in self.pit_stops.items()},
            "penalty_seq": self._penalty_id,
        }

    @classmethod
    def hydrate(cls, data: dict) -> "EventState":
        """Rebuild a static EventState from `export_state` output — enough to
        regenerate the PDF (classification, lap grid, pit/stint, penalties)."""
        snap = data.get("snapshot", {})
        st = cls(int(snap.get("slot", 0)))
        # snap["race"] is already the effective race (flag override folded in),
        # so leave flag_override at None — it only matters for live frames.
        st.race = RaceInfo.model_validate(snap.get("race", {}))
        st.drivers = [DriverRow.model_validate(d) for d in snap.get("drivers", [])]
        st.session_best_ms = snap.get("session_best_ms")
        st.session_best_kart = snap.get("session_best_kart", "")
        st.recompute_positions = snap.get("recompute_positions", False)
        st.auto_pitlane = snap.get("auto_pitlane", True)
        st.hide_team_penalties = snap.get("hide_team_penalties", False)
        st.min_pit_s = int(snap.get("min_pit_s") or 0)
        st.max_stint_s = int(snap.get("max_stint_s") or 0)
        st.penalties = [Penalty.model_validate(p) for p in snap.get("penalties", [])]
        st._penalty_id = int(data.get("penalty_seq", len(st.penalties)))
        st.lap_history = {
            k: [LapRecord.model_validate(r) for r in v]
            for k, v in data.get("lap_history", {}).items()
        }
        st.pit_stops = {
            k: [tuple(t) for t in v] for k, v in data.get("pit_stops", {}).items()
        }
        st.updated_at = snap.get("updated_at", 0.0)
        return st

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
            # The driver's own penalties/warnings (compact driver payload) —
            # withheld while race control is holding penalties from teams.
            "penalties": [] if self.hide_team_penalties else [
                p.model_dump() for p in self.penalties if p.kart_no == kart_no
            ],
            "updated_at": self.updated_at,
            # The server's clock now. `updated_at` stalls while the feed is idle,
            # so it can't anchor "how old is this message" on the driver screen.
            "server_ts": time.time(),
        }

    def lap_chart(self, karts: list[str] | None = None, last_n: int = 300) -> dict:
        """Lap history for team-manager analysis charts + the PDF timesheet.

        Pit laps come straight from the stored `pit` flag, which on gate venues
        (`auto_pitlane` on) is exactly what the feed reported — we never second-
        guess it with a pace heuristic there. Only when `auto_pitlane` is OFF (no
        pit-lane timing) do we OR in `infer_pit_laps`, a stateless pass over the
        lap times that recovers pit laps the live incremental detector missed
        (e.g. laps right after a session reset, before a clean baseline existed).
        """
        selected = karts or self.kart_numbers()
        result: dict = {}
        for kart in selected:
            recs = self.lap_history.get(kart, [])[-last_n:]
            # Feed-timed venues: trust the feed's pit flag only, no inference.
            pit_laps = set() if self.auto_pitlane else infer_pit_laps(recs)
            result[kart] = [
                {
                    "lap": rec.lap_no, "ms": rec.lap_ms, "pos": rec.position,
                    "pit": rec.pit or rec.lap_no in pit_laps, "ts": rec.ts,
                }
                for rec in recs
            ]
        return result
