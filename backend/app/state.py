from __future__ import annotations

import logging
import statistics
import time
from dataclasses import dataclass, field

from .models import DriverRow, EventSnapshot, Flag, LapRecord, Penalty, RaceInfo, SourceStatus
from .timeparse import parse_duration_ms

log = logging.getLogger(__name__)

MAX_LAPS_PER_KART = 2000

# Pit board: a "stop" shorter than this is feed noise (MyWeR sends sub-second
# and few-second pit times on ordinary laps), not a real pit stop.
PIT_STOP_MIN_S = 20.0
# A stint shorter than this isn't one (kart first seen just before it pits).
STINT_MIN_S = 10.0
# In-pit flag gaps shorter than this are the same pit visit.
PIT_GRACE_S = 10.0
# How long after a counted stop the feed may still deliver its pit time.
PIT_FEED_WAIT_S = 30.0
# A live (counting-up) feed pit time may run ahead of our clock by this much.
PIT_LIVE_SLACK_S = 10.0
# A live pit time that stopped growing for this long is final (kart left).
# MyWeR updates it every ~2.5 s, with gaps up to ~7 s.
PIT_SETTLE_S = 12.0


@dataclass
class _PitTrack:
    """Per-kart pit board bookkeeping (see EventState._track_pit_board)."""
    kart: str = ""
    times: list[int] = field(default_factory=list)      # stop durations, 0 = unknown yet
    # stints[n] = the stint that ended at stop n, seconds (0 = unknown)
    stints: list[int] = field(default_factory=list)
    track_since: float | None = None                    # current stint start (None = unknown)
    prev_pits: int | None = None
    prev_laps: int = 0
    feed_used_ms: int = 0                               # feed pit time already given to a stop
    visit_start: float | None = None
    visit_last_in: float = 0.0
    visit_out: float | None = None
    visit_counted: int | None = None                    # stop index this visit was counted as
    feed_stint_s: int = 0                               # feed's since-pit, last frame on track
    # The stop being timed from the feed (counter moved, time not final yet).
    open_idx: int | None = None
    open_ts: float = 0.0                                # when the counter moved
    open_live: bool = False                             # feed time counting up during the stop
    open_max: int = 0                                   # highest live time seen
    open_inc_ts: float = 0.0                            # when it last grew
    open_entry_ts: float = 0.0                          # pit entry per the feed's own clock
    exit_ts: float | None = None                        # pit exit of a live-timed stop


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
        self.min_pits: int = 0          # mandatory pit stops per kart (0 = none)
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
        # Pit board (gate venues): per-kart stops and stints, see _track_pit_board.
        self._boards: dict[str, _PitTrack] = {}
        self._feed_counts_pits = False   # the feed's pit counter has moved this session
        self._feed_pit_times = False     # the feed sends its own pit times this session
        # Rule breaks race control marked as dealt with ("<kart>:<kind>:<n>").
        self.pit_managed: set[str] = set()
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
                    self.team_story_config, self.min_pit_s, self.max_stint_s, self.min_pits)
        self.__init__(self.slot)
        (self.recompute_positions, self.auto_pitlane, self.hide_team_penalties,
         self.team_story_config, self.min_pit_s, self.max_stint_s, self.min_pits) = settings

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
        self._boards.clear()
        self._feed_counts_pits = False
        self._feed_pit_times = False
        self.pit_managed.clear()
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
            # (Per-stop lap + duration for the PDF: kept by _track_pit_board.)
            feed_pit = row.pits > self._lap_pits.get(row.kart_no, row.pits)
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
        Race Control pit board (min pit time / max stint / min stops checks).

        Only the feed's pit COUNTER makes a stop: MyWeR's in-pit flag blips and
        its last-pit-time field jitters to sub-second values on ordinary laps,
        so neither may create stops on its own. A stop's duration is the feed's
        last-pit time when it updates around the counter (≥ PIT_STOP_MIN_S), else our
        in→out measurement. In-pit flag blips within PIT_GRACE_S are one visit;
        a visit with no counter move is dropped as noise — except on feeds with
        no pit counter at all, where a visit ≥ PIT_STOP_MIN_S counts."""
        b = self._boards.get(row.kart_no)
        if b is None:
            b = self._boards[row.kart_no] = _PitTrack(kart=row.kart_no)
            # Stint start: known only if we see the kart from the start.
            if row.laps <= 1 and not row.in_pit:
                b.track_since = now - (row.stint_seconds or 0)
            b.prev_pits = row.pits
            b.prev_laps = row.laps
            b.feed_used_ms = row.last_pit_ms or 0          # belongs to an earlier stop

        # Close a finished visit: out of the pit for longer than the grace, or
        # already counted and the counter moves again (a new stop — e.g. a
        # replay running faster than real time).
        counter_up = b.prev_pits is not None and row.pits > b.prev_pits
        if b.visit_start is not None and b.visit_out is not None and (
            now - b.visit_out >= PIT_GRACE_S or (counter_up and b.visit_counted is not None)
        ):
            out = b.visit_out
            if b.visit_counted is not None:
                # Our measurement only for feeds that never send pit times
                # (MyWeR's in-pit flag covers just part of the stop).
                if b.times[b.visit_counted] <= 0 and not self._feed_pit_times:
                    self._set_stop(b, row.kart_no, b.visit_counted, int((out - b.visit_start) * 1000))
                b.track_since = out
            elif not self._feed_counts_pits and out - b.visit_start >= PIT_STOP_MIN_S:
                self._board_stop(b, row.kart_no, row.laps + 1, b.visit_start,
                                 int((out - b.visit_start) * 1000))
                b.track_since = out
            b.visit_start = b.visit_out = b.visit_counted = None

        # The feed's own since-pit clock (when it sends one), frozen at pit entry
        # (and read again once a counted stop's kart is back out).
        if not row.in_pit and (b.visit_start is None or (b.visit_counted is not None and b.visit_out is not None)):
            ms = parse_duration_ms(row.stint_time) if row.stint_time else None
            b.feed_stint_s = ms // 1000 if ms else 0

        # Pit-lane visit (flag blips inside the grace extend the same visit).
        if row.in_pit:
            if b.visit_start is None:
                b.visit_start = now
            b.visit_last_in = now
            b.visit_out = None
        elif b.visit_start is not None and b.visit_out is None:
            b.visit_out = now

        # The feed's pit time for the stop. Two styles: a FINAL time delivered
        # around the counter (gates that count at pit exit), or — MyWeR — a
        # counter that moves at pit ENTRY and a time that then counts up live
        # (with stale frames jumping back) until the kart leaves.
        feed = row.last_pit_ms or 0
        if feed >= PIT_STOP_MIN_S * 1000:
            self._feed_pit_times = True

        if counter_up:
            self._feed_counts_pits = True
            self._settle_open(b, now, force=True)
            if b.visit_start is not None:
                end = b.visit_out if b.visit_out is not None else (b.visit_last_in if not row.in_pit else now)
                measured = int((end - b.visit_start) * 1000)
                entry = b.visit_start
            else:
                measured = 0
                entry = now
            dur = measured if (not self._feed_pit_times and measured >= PIT_STOP_MIN_S * 1000) else 0
            # The lap the stop falls in: this frame's lap if the counter moved
            # with a crossing (gates reporting at the line), else the next one.
            lap = row.laps if row.laps > b.prev_laps else row.laps + 1
            idx = self._board_stop(b, row.kart_no, lap, entry, dur)
            b.open_idx, b.open_ts, b.open_live, b.open_max, b.open_inc_ts = idx, now, False, 0, now
            b.exit_ts = None
            if b.visit_start is not None:
                b.visit_counted = idx

        if b.open_idx is not None:
            elapsed_ms = (now - b.open_ts) * 1000
            if feed and feed != b.feed_used_ms:
                if feed >= PIT_STOP_MIN_S * 1000 and feed > elapsed_ms + PIT_LIVE_SLACK_S * 1000:
                    # Too long to have been counted since the counter: the final time.
                    self._set_stop(b, row.kart_no, b.open_idx, feed)
                    b.feed_used_ms = feed
                    self._close_open(b, exit_ts=now)
                elif feed <= elapsed_ms + PIT_LIVE_SLACK_S * 1000 and feed > b.open_max:
                    if not b.open_live:
                        # The feed had been timing the stop before the counter moved.
                        b.open_entry_ts = now - feed / 1000
                    b.open_live = True
                    b.open_max = feed
                    b.open_inc_ts = now
            if b.open_idx is not None:
                self._settle_open(b, now)
            if b.open_idx is not None and b.open_live:
                # Still counting: the kart is in the pit lane (MyWeR's own pit
                # flag doesn't move).
                row.in_pit = True
                row.pit_since_ts = b.open_entry_ts
                row.pit_live_ms = b.open_max
                row.pit_live_ts = b.open_inc_ts
        b.prev_pits = row.pits
        b.prev_laps = row.laps

        if row.in_pit and b.visit_start is not None:
            row.pit_since_ts = b.visit_start
        # Live-timed stops: the counter moved at pit ENTRY, so the server's
        # stint clock (which restarts on the counter) includes the stop. Without
        # a feed since-pit, count the stint from the pit exit instead.
        if b.exit_ts is not None and not row.in_pit and b.feed_stint_s == 0 and not row.stint_time.strip("0:. "):
            row.stint_seconds = max(0, int(now - b.exit_ts))
        row.pit_times_ms = list(b.times)          # 0 = stop counted, time not known
        row.stints_s = list(b.stints)

    @staticmethod
    def _close_open(b: "_PitTrack", exit_ts: float) -> None:
        b.open_idx = None
        b.open_live = False
        if b.visit_start is None:       # no in-pit flag visit to take the exit from
            b.track_since = exit_ts

    def _settle_open(self, b: "_PitTrack", now: float, force: bool = False) -> None:
        """Finish the open stop once its live time stopped growing (or a new
        stop starts), or give up waiting for a feed time."""
        if b.open_idx is None:
            return
        if b.open_live:
            if force or now - b.open_inc_ts >= PIT_SETTLE_S:
                if b.open_max >= PIT_STOP_MIN_S * 1000:
                    self._set_stop(b, b.kart, b.open_idx, b.open_max)
                b.feed_used_ms = b.open_max
                exit_ts = b.open_entry_ts + b.open_max / 1000
                b.exit_ts = exit_ts
                self._close_open(b, exit_ts)
        elif force or now - b.open_ts > PIT_FEED_WAIT_S:
            self._close_open(b, b.open_ts)

    def _board_stop(self, b: "_PitTrack", kart: str, lap: int, entry: float, dur_ms: int) -> int:
        """Record a stop (0 = duration not known yet) and the stint it ended:
        the feed's since-pit at pit entry when it sends one, else our clock.
        `stints` stays aligned with the stops (0 = stint length unknown, e.g.
        joined mid-race). Mirrored into `pit_stops` (lap, ms) for the PDF."""
        stint = b.feed_stint_s or (entry - b.track_since if b.track_since is not None else 0)
        b.stints.append(int(stint) if stint >= STINT_MIN_S else 0)
        b.track_since = None
        b.feed_stint_s = 0
        b.times.append(dur_ms)
        self.pit_stops.setdefault(kart, []).append((lap, dur_ms))
        return len(b.times) - 1

    def _set_stop(self, b: "_PitTrack", kart: str, idx: int, ms: int) -> None:
        """A stop's duration became known (feed final / live count settled)."""
        b.times[idx] = ms
        stops = self.pit_stops.get(kart, [])
        if idx < len(stops):
            stops[idx] = (stops[idx][0], ms)

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
            min_pits=self.min_pits,
            pit_managed=sorted(self.pit_managed),
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
        st.min_pits = int(snap.get("min_pits") or 0)
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
