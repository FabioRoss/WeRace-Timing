"""MyWeR (time2race) decoder.

The feed sends JSON snapshots shaped like (fields per the ESP32 reference):

    {"timestamp": ..., "data": {
        "race": {"racetime", "timetogo", "flag", "timeofday",
                 "trackname", "eventname", "runtype", "endrace"},
        "drivers": [{"position", "transp1", "raceno", "fullname",
                     "besttime", "lasttime", "gap", "difference", "laps",
                     "bestinlap", "lastpittime", "totpittime", "sincepit",
                     "nopitstops", "end"}, ...]}}

Lap/pit times come as "HH:MM:SS.ffffff" with all-zeros meaning "no time".
"""

from __future__ import annotations

import json
import logging

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


def decode_mywer(text: str) -> tuple[RaceInfo | None, list[DriverRow] | None]:
    doc = json.loads(text)
    data = doc.get("data") or {}

    race: RaceInfo | None = None
    if "race" in data:
        r = data["race"] or {}
        race = RaceInfo(
            track_name=r.get("trackname") or "",
            event_name=r.get("eventname") or "",
            run_type=r.get("runtype") or "",
            flag=FLAG_MAP.get(str(r.get("flag") or "").upper(), Flag.NONE),
            race_time=format_hms(r.get("racetime") or ""),
            time_to_go=format_hms(r.get("timetogo") or ""),
            time_of_day=r.get("timeofday") or "",
            ended=bool(r.get("endrace")),
        )

    drivers: list[DriverRow] | None = None
    if "drivers" in data:
        drivers = []
        for d in data["drivers"] or []:
            kart_no = str(d.get("raceno") or "").strip()
            if not kart_no:
                continue
            drivers.append(
                DriverRow(
                    kart_no=kart_no,
                    name=str(d.get("fullname") or "").strip(),
                    position=int(d.get("position") or 0),
                    transponder=d.get("transp1"),
                    last_lap_ms=parse_duration_ms(d.get("lasttime")),
                    best_lap_ms=parse_duration_ms(d.get("besttime")),
                    best_lap_no=d.get("bestinlap"),
                    gap_ahead=str(d.get("gap") or "").strip(),
                    gap_leader=str(d.get("difference") or "").strip(),
                    laps=int(d.get("laps") or 0),
                    pits=int(d.get("nopitstops") or 0),
                    last_pit_ms=parse_duration_ms(d.get("lastpittime")),
                    total_pit_ms=parse_duration_ms(d.get("totpittime")),
                    stint_time=str(d.get("sincepit") or "").strip(),
                    finished=bool(d.get("end")),
                )
            )
    return race, drivers


class MyWerSource(WebSocketSource):
    async def handle_frame(self, text: str) -> None:
        if len(text) <= 2:
            return
        try:
            race, drivers = decode_mywer(text)
        except (json.JSONDecodeError, ValueError) as exc:
            log.warning("mywer: undecodable frame (%s): %.200s", exc, text)
            return
        if race is not None or drivers is not None:
            await self.on_data(race, drivers)
