"""MyWeR (time2race) decoder.

The feed sends JSON snapshots shaped like:

    {"timestamp": ..., "data": {
        "race": {...},
        "drivers": [{...}, ...]}}

Verified against a live Rozzano capture (tests/fixtures/rozzano.ndjson):

- Most frames carry a PARTIAL race object (dynamic fields only); the full
  metadata (runtype, duralaps, duratime, names) arrives only occasionally, so
  race state must be merged across frames, never rebuilt.
- Lap-limited sessions: duralaps > 0 with duratime "00:00:00"; "lapstogo"
  counts down as the leader laps; "timetogo" is a garbage 23:xx wrap counter
  and must not be shown. These sessions are races (duration in laps).
- Time-limited sessions: duratime > 0; "timetogo" counts down correctly but
  wraps to 23:59:xx after expiry — clamp to zero.
- Driver "pit" flags an in-pit kart; interm[0].t1..t3 carry sector times when
  the venue is configured for them.

Lap/pit times come as "HH:MM:SS.ffffff" with all-zeros meaning "no time".
"""

from __future__ import annotations

import json
import logging
import time

from ..models import DriverRow, Flag, RaceInfo
from ..timeparse import format_hms, parse_duration_ms
from .base import WebSocketSource

log = logging.getLogger(__name__)

FLAG_MAP = {
    "G": Flag.GREEN,
    "Y": Flag.YELLOW,
    "R": Flag.RED,
    "F": Flag.FINISH,
    "C": Flag.FINISH,
    "W": Flag.WARMUP,
    "S": Flag.STOPPED,
}

RACE_RUNTYPES = {"R", "G", "F"}          # race / gara / final
TIMED_RUNTYPES = {"Q", "P", "W"}         # qualifying / practice / warmup

TWELVE_HOURS_MS = 12 * 3600 * 1000


class MyWerDecoder:
    """Stateful decoder: merges partial race frames into a running state."""

    def __init__(self) -> None:
        self._race: dict = {}

    def decode(self, text: str) -> tuple[RaceInfo | None, list[DriverRow] | None]:
        doc = json.loads(text)
        data = doc.get("data") or {}

        race: RaceInfo | None = None
        if "race" in data:
            for key, value in (data["race"] or {}).items():
                if value is not None:
                    self._race[key] = value
            race = self._build_race()

        drivers: list[DriverRow] | None = None
        if "drivers" in data:
            drivers = []
            for d in data["drivers"] or []:
                row = self._build_driver(d)
                if row is not None:
                    drivers.append(row)
        return race, drivers

    def _build_race(self) -> RaceInfo:
        r = self._race
        duralaps = int(r.get("duralaps") or 0)
        duratime_ms = parse_duration_ms(str(r.get("duratime") or "")) or 0
        lap_limited = duralaps > 0 and duratime_ms == 0

        runtype = str(r.get("runtype") or "").upper()
        if lap_limited or runtype in RACE_RUNTYPES:
            kind = "race"
        elif runtype in TIMED_RUNTYPES:
            kind = "timed"
        else:
            kind = "unknown"

        flag = FLAG_MAP.get(str(r.get("flag") or "").upper(), Flag.NONE)
        ended = bool(r.get("endrace"))

        togo_ms: int | None = None
        counting = False
        if lap_limited:
            togo = int(r.get("lapstogo") or 0) or duralaps
            time_to_go = f"{togo} lap" + ("" if togo == 1 else "s")
        else:
            time_to_go = format_hms(str(r.get("timetogo") or ""))
            remaining_ms = parse_duration_ms(str(r.get("timetogo") or ""))
            if remaining_ms is not None:
                # After expiry the counter wraps to 23:xx:xx — clamp to zero.
                limit = duratime_ms or TWELVE_HOURS_MS
                if remaining_ms > limit:
                    remaining_ms = 0
                    time_to_go = "00:00"
                togo_ms = remaining_ms
                counting = remaining_ms > 0 and flag == Flag.GREEN and not ended

        return RaceInfo(
            track_name=r.get("trackname") or "",
            event_name=r.get("eventname") or r.get("runname") or "",
            run_type=r.get("runname") or runtype,
            session_kind=kind,
            flag=flag,
            race_time=format_hms(str(r.get("racetime") or "")),
            time_to_go=time_to_go,
            togo_ms=togo_ms,
            togo_ts=time.time() if togo_ms is not None else None,
            counting=counting,
            time_of_day=str(r.get("timeofday") or ""),
            ended=ended,
        )

    @staticmethod
    def _build_driver(d: dict) -> DriverRow | None:
        kart_no = str(d.get("raceno") or "").strip()
        if not kart_no:
            return None
        interm = (d.get("interm") or [{}])[0] or {}
        in_pit = bool(d.get("pit"))
        return DriverRow(
            kart_no=kart_no,
            name=str(d.get("fullname") or "").strip(),
            position=int(d.get("position") or 0),
            transponder=d.get("transp1"),
            last_lap_ms=parse_duration_ms(d.get("lasttime")),
            best_lap_ms=parse_duration_ms(d.get("besttime")),
            best_lap_no=d.get("bestinlap"),
            s1_ms=parse_duration_ms(interm.get("t1")),
            s2_ms=parse_duration_ms(interm.get("t2")),
            s3_ms=parse_duration_ms(interm.get("t3")),
            gap_ahead=str(d.get("gap") or "").strip(),
            gap_leader=str(d.get("difference") or "").strip(),
            laps=int(d.get("laps") or 0),
            pits=int(d.get("nopitstops") or 0),
            last_pit_ms=parse_duration_ms(d.get("lastpittime")),
            total_pit_ms=parse_duration_ms(d.get("totpittime")),
            stint_time=str(d.get("sincepit") or "").strip(),
            in_pit=in_pit,
            pit_state="in" if in_pit else "",
            finished=bool(d.get("end")),
        )


def decode_mywer(text: str) -> tuple[RaceInfo | None, list[DriverRow] | None]:
    """One-shot decode (no cross-frame merging); mainly for tests."""
    return MyWerDecoder().decode(text)


class MyWerSource(WebSocketSource):
    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.decoder = MyWerDecoder()

    async def handle_frame(self, text: str) -> None:
        if len(text) <= 2:
            return
        try:
            race, drivers = self.decoder.decode(text)
        except (json.JSONDecodeError, ValueError) as exc:
            log.warning("mywer: undecodable frame (%s): %.200s", exc, text)
            return
        if race is not None or drivers is not None:
            await self.on_data(race, drivers)
