"""Sector-anchored progress events, pit tracking, speed-trap column sanity,
session-kind inference, and pit-flagged lap history."""

import pytest
from fastapi.testclient import TestClient

import app.sources.apex as apex_mod
from app.events import get_manager
from app.main import app
from app.models import DriverRow, RaceInfo
from app.sources.apex import ApexGrid
from app.state import EventState

from .test_apex import replay_fixture


def row_of(grid: ApexGrid, kart: str) -> DriverRow:
    return next(d for d in grid.standings() if d.kart_no == kart)


# ------------------------------------------------------------- progress events

def test_progress_sequence_matches_apex_sector_events():
    grid = ApexGrid()
    grid.apply("r59c9|tn|1:34.890")

    # crossing: completed lap 94890 ms, expected s1 = 32697 ms
    grid.apply("r59|*|94890|32697")
    d = row_of(grid, "59")
    assert d.prog_from == 0.0
    assert d.prog_ms == 32697
    assert d.prog_to == pytest.approx(32697 / 94890)
    assert d.prog_ts is not None

    # sector 1 posted (32.697), expected s2 = 38563 ms
    grid.apply("r59c6|ti|32.697")
    grid.apply("r59|*i1|38563")
    d = row_of(grid, "59")
    assert d.prog_from == pytest.approx(32697 / 94890)
    assert d.prog_to == pytest.approx((32697 + 38563) / 94890)
    assert d.prog_ms == 38563

    # sector 2 posted (38.478), expected s3 = 23801 ms -> runs to the line
    grid.apply("r59c7|tn|38.478")
    grid.apply("r59|*i2|23801")
    d = row_of(grid, "59")
    assert d.prog_from == pytest.approx((32697 + 38478) / 94890)
    assert d.prog_to == 1.0
    assert d.prog_ms == 23801


def test_progress_empty_ref_holds_position():
    grid = ApexGrid()
    grid.apply("r7c9|tn|1:40.000")
    grid.apply("r7|*|100000|33000")
    grid.apply("r7c6|tn|33.100")
    grid.apply("r7|*i1|")            # empty reference (seen in captures)
    d = row_of(grid, "7")
    assert d.prog_ms is None
    assert d.prog_from == pytest.approx(33100 / 100000)
    assert d.prog_to == d.prog_from  # frontend holds here


def test_sector_times_exposed():
    grid = ApexGrid()
    grid.apply("r7c9|tn|1:40.000")
    grid.apply("r7c6|tn|33.100")
    grid.apply("r7c7|tn|39.500")
    grid.apply("r7c8|tn|27.400")
    d = row_of(grid, "7")
    assert (d.s1_ms, d.s2_ms, d.s3_ms) == (33100, 39500, 27400)


# ---------------------------------------------------------------- pit tracking

def test_pit_state_machine_and_durations(monkeypatch):
    clock = {"t": 1000.0}
    monkeypatch.setattr(apex_mod.time, "time", lambda: clock["t"])
    grid = ApexGrid()
    grid.apply("r5c9|tn|1:40.000")

    grid.apply("r5c2|si|")
    grid.apply("r5|*in|0")
    d = row_of(grid, "5")
    assert d.in_pit and d.pit_state == "in"
    assert d.prog_ts is None          # bar cleared in pit

    clock["t"] += 42.5                # 42.5 s in the pit lane
    grid.apply("r5c2|so|")
    grid.apply("r5|*out|0")
    d = row_of(grid, "5")
    assert not d.in_pit and d.pit_state == "out"
    assert d.pits == 1
    assert d.last_pit_ms == 42500
    assert d.total_pit_ms == 42500

    grid.apply("r5|*|100000|33000")   # next crossing clears the out-lap state
    d = row_of(grid, "5")
    assert d.pit_state == ""


# -------------------------------------------------- speed-trap column sanity

def test_speed_trap_demotes_laps_column_and_remaps():
    grid = ApexGrid()
    grid.apply("r5c9|tn|1:40.000")
    grid.apply("r5c13|in|264.7")      # decimal in the laps column -> speed trap
    assert grid.fallback_columns[13] == "speed"

    for row in ("r5", "r6", "r7"):
        grid.apply(f"{row}c14||42")
    assert grid.fallback_columns[14] == "laps"

    d = row_of(grid, "5")
    assert d.speed == "264.7"
    assert d.laps == 42


# ------------------------------------------------------------- session kind

def test_practice_capture_is_timed_session():
    grid = replay_fixture("cremona_practice.ndjson")
    grid.standings()
    assert grid.race.session_kind == "timed"


def test_inverted_best_order_is_race():
    grid = ApexGrid()
    # 8 positioned karts whose best laps are NOT monotonic -> race ranking
    bests = ["1:40.0", "1:39.0", "1:41.0", "1:38.5", "1:42.0", "1:39.5", "1:43.0", "1:38.0"]
    for i, best in enumerate(bests, start=1):
        grid.apply(f"r{i}c10|ib|{best}")
        grid.apply(f"r{i}|#|{i}")
    grid.standings()
    assert grid.race.session_kind == "race"


def test_title2_sets_session_kind():
    grid = ApexGrid()
    grid.apply("title2||Gara Endurance 2h")
    assert grid.race.session_kind == "race"
    grid2 = ApexGrid()
    grid2.apply("title2||Prove Libere")
    assert grid2.race.session_kind == "timed"


# ------------------------------------------------ lap history: pit flags, API

def make_row(**kw) -> DriverRow:
    base = dict(kart_no="7", position=1, laps=0, pits=0, last_lap_ms=None)
    base.update(kw)
    return DriverRow(**base)


def test_lap_history_flags_pit_laps_and_prog_fallback():
    state = EventState(1)
    state.update(RaceInfo(), [make_row(laps=1, last_lap_ms=95000)])
    state.update(RaceInfo(), [make_row(laps=2, last_lap_ms=96000)])
    # kart pits during lap 3 (pits counter increments before the crossing)
    state.update(RaceInfo(), [make_row(laps=3, last_lap_ms=150000, pits=1)])
    state.update(RaceInfo(), [make_row(laps=4, last_lap_ms=95500, pits=1)])

    history = state.lap_history["7"]
    assert [rec.pit for rec in history] == [False, False, True, False]

    # prog fallback anchored at the recorded crossing for plain sources
    row = make_row(laps=4, last_lap_ms=95500, pits=1)
    state.update(RaceInfo(), [row])
    assert row.prog_ts is not None
    assert (row.prog_from, row.prog_to, row.prog_ms) == (0.0, 1.0, 95500)


def test_lap_chart_recomputes_missed_pit_laps():
    # auto_pitlane on (gates) → the feed reports no pits, so no pit is flagged
    # live; but lap_chart recomputes from the lap times, so an anomalously long
    # lap (e.g. a driver change / stop, or a pit missed after a session reset)
    # is still marked. This is what feeds both the dashboard and the PDF.
    state = EventState(1)
    state.auto_pitlane = True
    for lap, ms in [(1, 40000), (2, 40500), (3, 39800), (4, 95000), (5, 40200)]:
        state.update(RaceInfo(), [make_row(laps=lap, last_lap_ms=ms)])

    assert not any(rec.pit for rec in state.lap_history["7"])  # nothing stored live
    chart = state.lap_chart(karts=["7"])
    assert [p["lap"] for p in chart["7"] if p["pit"]] == [4]


def test_laps_api_includes_pit_flag():
    with TestClient(app) as client:
        event = get_manager().get(1)
        event.state.update(RaceInfo(), [make_row(laps=1, last_lap_ms=95000)])
        event.state.update(RaceInfo(), [make_row(laps=2, last_lap_ms=140000, pits=1)])
        body = client.get("/e/1/api/laps?karts=7").json()
        assert body["laps"]["7"][-1]["pit"] is True
        assert body["laps"]["7"][0]["pit"] is False
        event.reset()