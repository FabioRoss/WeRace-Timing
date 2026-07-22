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
    # race = ranked by laps/track position; timed = ranked by best lap
    # (practice/qualifying); unknown until the source can tell.
    session_kind: Literal["unknown", "race", "timed"] = "unknown"
    flag: Flag = Flag.NONE
    race_time: str = ""             # elapsed, source formatted "HH:MM:SS"
    time_to_go: str = ""            # remaining, source formatted (or "N laps")
    # Countdown anchor: togo_ms remaining at server wall time togo_ts; clients
    # tick it down locally while `counting` and re-sync on every update.
    togo_ms: int | None = None
    togo_ts: float | None = None
    counting: bool = False
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
    s1_ms: int | None = None        # current-lap sector times
    s2_ms: int | None = None
    s3_ms: int | None = None
    speed: str = ""                 # speed-trap reading (source formatted)
    gap_ahead: str = ""             # gap to the kart in front (source formatted)
    gap_leader: str = ""            # gap/difference to the leader
    total_time_ms: int | None = None  # cumulative running time (for reordering)
    laps: int = 0
    pits: int = 0
    last_pit_ms: int | None = None
    total_pit_ms: int | None = None
    stint_time: str = ""            # time since last pit if the source provides it
    stint_seconds: int | None = None  # normalized stint (feed value or server-tracked)
    in_pit: bool = False
    pit_state: Literal["", "in", "out"] = ""   # in = in pit lane, out = out-lap
    finished: bool = False
    # Lap-progress anchor: at prog_ts (wall time) the kart was at lap fraction
    # prog_from, expected to reach prog_to after prog_ms (Apex sector events).
    prog_ts: float | None = None
    prog_from: float = 0.0
    prog_to: float = 1.0
    prog_ms: int | None = None
    # Server clock when an inferred pit stop actually began (missed crossing),
    # so the rejoin forecast keeps the stationary-on-line time.
    pit_since_ts: float | None = None


class LapRecord(BaseModel):
    kart_no: str
    lap_no: int
    lap_ms: int
    position: int
    pit: bool = False               # kart visited the pit lane during this lap
    ts: float = Field(default_factory=time.time)


class Message(BaseModel):
    id: int
    ts: float = Field(default_factory=time.time)
    sender: Literal["race_control", "team_manager"]
    target: list[str] | None = None     # kart numbers; None = everyone
    text: str
    priority: Literal["info", "warning", "urgent"] = "info"


class Penalty(BaseModel):
    """A race-control penalty, warning, or time adjustment against a single kart.

    Kinds:
      - "time":    +`seconds` added to the kart's total time in the final
                   (penalty-adjusted) classification. Served in the pit lane;
                   once `served` it is NOT applied to the result.
      - "lap":     `laps` subtracted from the kart's lap count in the final
                   classification. Results-only (no pit serving); applies while
                   present, removed by deleting it.
      - "warning": no effect on the result; a formal notice only.
      - "adjust":  a neutral **correction** (not a sanction), always applied
                   (never "served") and rendered neutrally. Either a time
                   correction — SIGNED `seconds` folded into total time like a
                   time penalty — or a lap correction — SIGNED `laps` ADDED to
                   the kart's lap count (e.g. +2 to give back laps a transponder
                   missed, −1 to remove a double-counted one). Used for
                   organizer-side timing errors.
    Only UNSERVED time/lap penalties + adjustments are applied to the PDF result.
    """

    id: int
    ts: float = Field(default_factory=time.time)
    kart_no: str
    kind: Literal["time", "lap", "warning", "adjust"]
    seconds: int = 0                    # time penalties / adjustments: seconds added (adjust: signed)
    laps: int = 0                       # lap penalties: laps subtracted; lap adjustments: signed laps added
    reason: str = ""
    served: bool = False                # time penalties: served in the pit lane
    # Whether the delayed team notification has already been sent. Staff get a
    # short grace window (Settings.penalty_notify_delay_s) to delete a mistake
    # before the team is notified; deleting before then cancels the notice.
    notified: bool = False


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
    # Replay progress (only set while a recording is playing back) so Race
    # Control can show a seek timeline: current frame index, total frames, and
    # the recording-time elapsed / duration in seconds.
    replay_pos: int | None = None
    replay_count: int | None = None
    replay_elapsed_s: float | None = None
    replay_duration_s: float | None = None


class EventSnapshot(BaseModel):
    """Full state pushed to dashboards over the live websocket."""

    type: Literal["snapshot"] = "snapshot"
    slot: int
    race: RaceInfo = RaceInfo()
    drivers: list[DriverRow] = []
    source: SourceStatus = SourceStatus()
    # Active race-control flag override (None = mirroring the feed)
    flag_override: Flag | None = None
    # Race-control settings that affect how the feed is interpreted
    recompute_positions: bool = False
    auto_pitlane: bool = True
    hide_team_penalties: bool = False
    # Staff-chosen defaults for the team Instagram-story graphic (blank = the
    # renderer's own fallbacks). Read by the team dashboard's preview/download.
    team_story_config: dict = {}
    session_best_ms: int | None = None
    session_best_kart: str = ""
    # Race-control penalties & warnings (full current list every broadcast).
    penalties: list[Penalty] = []
    updated_at: float = 0.0


class SourceConfig(BaseModel):
    """What Race Control submits to connect a slot to a timing feed."""

    kind: Literal["mywer", "apex", "simulator", "replay"]
    label: str = ""
    # Optional display name for the track. When set (in the TRACK_CATALOG entry)
    # it overrides whatever the feed reports as the track name, everywhere the
    # session is shown/exported. Empty = use the feed's track name.
    track_name: str = ""
    # For mywer/apex: full wss URL (catalog entries pre-fill this).
    url: str = ""
    origin: str = ""                # Origin header override (catalog pre-fills)
    # Public live-timing page; fetched once at connect to bootstrap the grid
    # (kart numbers / team names / column headers) when the ws doesn't send it.
    page: str = ""
    # For replay: recording filename inside recordings dir.
    file: str = ""
    speed: float = 1.0              # replay speed multiplier
    # Optional Race-Control defaults loaded onto the slot when this entry is
    # connected (set per TRACK_CATALOG entry in tracks.py). None = leave the
    # slot's current value untouched; a bool applies it as the starting value,
    # which the operator can still override live in the RC config tab.
    auto_pitlane: bool | None = None
    recompute_positions: bool | None = None
    hide_team_penalties: bool | None = None
