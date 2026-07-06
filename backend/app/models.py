from __future__ import annotations

import time
from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field


class Flag(str, Enum):
    NONE = "none"
    GREEN = "green"
    YELLOW = "yellow"
    RED = "red"
    FINISH = "finish"       # checkered
    WARMUP = "warmup"
    STOPPED = "stopped"


class RaceInfo(BaseModel):
    track_name: str = ""
    event_name: str = ""
    run_type: str = ""              # e.g. Q / F / free text from the source
    flag: Flag = Flag.NONE
    race_time: str = ""             # elapsed, source formatted "HH:MM:SS"
    time_to_go: str = ""            # remaining, source formatted "HH:MM:SS"
    time_of_day: str = ""
    ended: bool = False


class DriverRow(BaseModel):
    kart_no: str                    # race number: the stable key for a team/kart
    name: str = ""
    position: int = 0
    transponder: int | None = None
    last_lap_ms: int | None = None
    best_lap_ms: int | None = None
    best_lap_no: int | None = None
    gap_ahead: str = ""             # gap to the kart in front (source formatted)
    gap_leader: str = ""            # gap/difference to the leader
    laps: int = 0
    pits: int = 0
    last_pit_ms: int | None = None
    total_pit_ms: int | None = None
    stint_time: str = ""            # time since last pit if the source provides it
    in_pit: bool = False
    finished: bool = False


class LapRecord(BaseModel):
    kart_no: str
    lap_no: int
    lap_ms: int
    position: int
    ts: float = Field(default_factory=time.time)


class Message(BaseModel):
    id: int
    ts: float = Field(default_factory=time.time)
    sender: Literal["race_control", "team_manager"]
    target: list[str] | None = None     # kart numbers; None = everyone
    text: str
    priority: Literal["info", "warning", "urgent"] = "info"


class SourceStatus(BaseModel):
    kind: str = ""                  # mywer | apex | simulator | replay
    label: str = ""
    url: str = ""
    connected: bool = False
    last_frame_ts: float | None = None
    frames_received: int = 0
    error: str = ""
    recording: bool = False
    recording_file: str = ""


class EventSnapshot(BaseModel):
    """Full state pushed to dashboards over the live websocket."""

    type: Literal["snapshot"] = "snapshot"
    slot: int
    race: RaceInfo = RaceInfo()
    drivers: list[DriverRow] = []
    source: SourceStatus = SourceStatus()
    session_best_ms: int | None = None
    session_best_kart: str = ""
    updated_at: float = 0.0


class SourceConfig(BaseModel):
    """What Race Control submits to connect a slot to a timing feed."""

    kind: Literal["mywer", "apex", "simulator", "replay"]
    label: str = ""
    # For mywer/apex: full wss URL (catalog entries pre-fill this).
    url: str = ""
    origin: str = ""                # Origin header override (catalog pre-fills)
    # For replay: recording filename inside recordings dir.
    file: str = ""
    speed: float = 1.0              # replay speed multiplier
