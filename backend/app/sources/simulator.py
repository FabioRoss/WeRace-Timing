"""Synthetic endurance race generator for demos and end-to-end testing."""

from __future__ import annotations

import asyncio
import random

from ..models import DriverRow, Flag, RaceInfo
from .base import BaseSource

TEAM_NAMES = [
    "Apex Predators", "Boxbox Racing", "Kerb Crushers", "Late Brakers",
    "Pit Perfect", "Slipstream Society", "Torque Titans", "Vortex Veloce",
    "Grip Gang", "Oversteer Bros", "Chicane Charmers", "Draft Kings",
]


class _SimKart:
    def __init__(self, kart_no: str, name: str, pace_ms: int) -> None:
        self.kart_no = kart_no
        self.name = name
        self.pace_ms = pace_ms                  # base lap pace
        self.laps = 0
        self.total_ms = random.randint(0, 3000)  # staggered start
        self.next_lap_ms = self._sample_lap()
        self.last_lap_ms: int | None = None
        self.best_lap_ms: int | None = None
        self.best_lap_no: int | None = None
        self.pits = 0
        self.stint_ms = 0
        self.in_pit = False
        self.pit_at_lap = random.randint(22, 30)

    def _sample_lap(self) -> int:
        return self.pace_ms + random.randint(-400, 900)

    def advance(self, dt_ms: int, under_yellow: bool) -> None:
        self.stint_ms += dt_ms
        step = dt_ms if not under_yellow else int(dt_ms * 0.55)
        self.total_ms += dt_ms
        self.next_lap_ms -= step
        self.in_pit = False
        while self.next_lap_ms <= 0:
            self.laps += 1
            lap = self._sample_lap()
            if self.laps % self.pit_at_lap == 0:
                lap += random.randint(35000, 70000)   # pit stop
                self.pits += 1
                self.stint_ms = 0
                self.in_pit = True
            self.last_lap_ms = lap
            if self.best_lap_ms is None or (lap < self.best_lap_ms and not self.in_pit):
                self.best_lap_ms = lap
                self.best_lap_no = self.laps
            self.next_lap_ms += lap


def _fmt_clock(total_seconds: int) -> str:
    total_seconds = max(0, total_seconds)
    h, rem = divmod(total_seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def _fmt_gap(ms: int) -> str:
    return f"{ms / 1000:.1f}"


class SimulatorSource(BaseSource):
    RACE_SECONDS = 2 * 60 * 60
    TICK = 1.0

    async def _run(self) -> None:
        random.seed()
        karts = [
            _SimKart(str(no), name, pace_ms=random.randint(51500, 54500))
            for no, name in zip(range(2, 2 + len(TEAM_NAMES)), TEAM_NAMES)
        ]
        elapsed = 0
        yellow_until = 0
        speed = max(self.config.speed or 1.0, 0.1)
        self.status.connected = True
        self.status.error = ""

        try:
            while elapsed < self.RACE_SECONDS:
                await asyncio.sleep(self.TICK / speed)
                elapsed += int(self.TICK)
                self._record("")  # counts frames for the status panel

                if yellow_until <= elapsed and random.random() < 0.0015:
                    yellow_until = elapsed + random.randint(60, 180)
                under_yellow = elapsed < yellow_until

                for kart in karts:
                    kart.advance(int(self.TICK * 1000), under_yellow)

                order = sorted(karts, key=lambda k: (-k.laps, k.total_ms - k.next_lap_ms))
                leader = order[0]
                drivers: list[DriverRow] = []
                for pos, kart in enumerate(order, start=1):
                    if pos == 1:
                        gap_ahead = gap_leader = ""
                    else:
                        prev = order[pos - 2]
                        lap_diff_prev = prev.laps - kart.laps
                        lap_diff_lead = leader.laps - kart.laps
                        gap_ahead = (
                            f"{lap_diff_prev} L" if lap_diff_prev > 0
                            else _fmt_gap(abs(prev.next_lap_ms - kart.next_lap_ms) + random.randint(0, 200))
                        )
                        gap_leader = (
                            f"{lap_diff_lead} L" if lap_diff_lead > 0
                            else _fmt_gap(abs(leader.next_lap_ms - kart.next_lap_ms))
                        )
                    drivers.append(
                        DriverRow(
                            kart_no=kart.kart_no,
                            name=kart.name,
                            position=pos,
                            last_lap_ms=kart.last_lap_ms,
                            best_lap_ms=kart.best_lap_ms,
                            best_lap_no=kart.best_lap_no,
                            gap_ahead=gap_ahead,
                            gap_leader=gap_leader,
                            laps=kart.laps,
                            pits=kart.pits,
                            stint_time=_fmt_clock(kart.stint_ms // 1000),
                            in_pit=kart.in_pit,
                        )
                    )

                race = RaceInfo(
                    track_name="Simulation Raceway",
                    event_name="Demo Endurance Cup",
                    run_type="Race",
                    flag=Flag.YELLOW if under_yellow else Flag.GREEN,
                    race_time=_fmt_clock(elapsed),
                    time_to_go=_fmt_clock(self.RACE_SECONDS - elapsed),
                    ended=False,
                )
                await self.on_data(race, drivers)

            final = RaceInfo(
                track_name="Simulation Raceway",
                event_name="Demo Endurance Cup",
                run_type="Race",
                flag=Flag.FINISH,
                race_time=_fmt_clock(self.RACE_SECONDS),
                time_to_go="00:00",
                ended=True,
            )
            await self.on_data(final, None)
        finally:
            self.status.connected = False
