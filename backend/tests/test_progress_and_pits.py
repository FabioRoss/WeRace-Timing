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


def test_pit_stops_history_records_feed_pits():
    # A feed that reports pits (gate venue) → per-stop lap + measured duration.
    state = EventState(1)
    state.update(RaceInfo(), [make_row(laps=1, last_lap_ms=40000)])
    state.update(RaceInfo(), [make_row(laps=2, last_lap_ms=40500)])
    state.update(RaceInfo(), [make_row(laps=3, last_lap_ms=41000, pits=1, last_pit_ms=25000)])
    state.update(RaceInfo(), [make_row(laps=7, last_lap_ms=40800, pits=2, last_pit_ms=23000)])
    assert state.pit_stops["7"] == [(3, 25000), (7, 23000)]


def test_lap_chart_infers_pits_only_without_gates():
    # A long lap (a stop the feed didn't flag) is only inferred when there are NO
    # pit-lane gates. With auto_pitlane ON, lap_chart trusts the feed's pit flag
    # only and never second-guesses it — so this venue's dashboards/PDF show
    # exactly the feed's pits, no pace-heuristic guesses.
    laps = [(1, 40000), (2, 40500), (3, 39800), (4, 95000), (5, 40200)]

    gated = EventState(1)
    gated.auto_pitlane = True
    for lap, ms in laps:
        gated.update(RaceInfo(), [make_row(laps=lap, last_lap_ms=ms)])
    assert not any(rec.pit for rec in gated.lap_history["7"])   # feed flagged none
    chart = gated.lap_chart(karts=["7"])
    assert [p["lap"] for p in chart["7"] if p["pit"]] == []     # and none inferred

    ungated = EventState(2)
    ungated.auto_pitlane = False
    for lap, ms in laps:
        ungated.update(RaceInfo(), [make_row(laps=lap, last_lap_ms=ms)])
    chart = ungated.lap_chart(karts=["7"])
    assert [p["lap"] for p in chart["7"] if p["pit"]] == [4]    # inferred here


def test_laps_api_includes_pit_flag():
    with TestClient(app) as client:
        event = get_manager().get(1)
        event.state.update(RaceInfo(), [make_row(laps=1, last_lap_ms=95000)])
        event.state.update(RaceInfo(), [make_row(laps=2, last_lap_ms=140000, pits=1)])
        body = client.get("/e/1/api/laps?karts=7").json()
        assert body["laps"]["7"][-1]["pit"] is True
        assert body["laps"]["7"][0]["pit"] is False
        event.reset()

class _Clock:
    def __init__(self, monkeypatch, start=1000.0):
        self.t = start
        import app.state as state_mod
        monkeypatch.setattr(state_mod.time, "time", lambda: self.t)


def test_pit_board_measures_stops_and_stints(monkeypatch):
    """Gate venue: stop times (feed value wins over our measurement, whichever
    order it arrives in) and completed stint lengths for the RC pit board."""
    clock = _Clock(monkeypatch)
    state = EventState(1)

    def frame(**kw):
        row = make_row(**kw)
        state.update(RaceInfo(), [row])
        return row

    frame(laps=1, last_lap_ms=40000)
    clock.t += 600
    frame(laps=15, last_lap_ms=40000)                       # 10-minute stint so far
    clock.t += 5
    row = frame(laps=15, last_lap_ms=40000, in_pit=True)     # enters the pit
    assert row.pit_since_ts == clock.t
    assert row.stints_s == []                                # not a stop until the counter moves
    clock.t += 62
    row = frame(laps=15, last_lap_ms=40000, pits=1)          # out, feed time not yet in
    assert row.pit_times_ms == [62000]
    assert row.stints_s == [605]
    row = frame(laps=15, last_lap_ms=40000, pits=1, last_pit_ms=61480)
    assert row.pit_times_ms == [61480]                       # feed value replaces ours

    clock.t += 300
    frame(laps=22, last_lap_ms=40000, pits=1, last_pit_ms=61480)
    frame(laps=22, last_lap_ms=40000, pits=1, last_pit_ms=61480, in_pit=True)
    clock.t += 45
    # feed counts the stop and publishes its time while the kart is still in the pit
    row = frame(laps=22, last_lap_ms=40000, pits=2, last_pit_ms=44900, in_pit=True)
    assert row.stints_s == [605, 300]
    row = frame(laps=22, last_lap_ms=40000, pits=2, last_pit_ms=44900)
    assert row.pit_times_ms == [61480, 44900]


def test_pit_board_off_without_gates_and_limits_setting(monkeypatch):
    state = EventState(1)
    state.auto_pitlane = False
    state.update(RaceInfo(), [make_row(laps=1, last_lap_ms=40000)])
    row = make_row(laps=1, last_lap_ms=40000, in_pit=True)
    state.update(RaceInfo(), [row])
    assert row.pit_times_ms == [] and row.stints_s == []
    # limits are race settings: survive a data reset and reach the snapshot
    state.min_pit_s, state.max_stint_s, state.min_pits = 90, 1800, 2
    state.reset()
    assert state.min_pits == 2
    snap = state.snapshot(__import__("app.models", fromlist=["SourceStatus"]).SourceStatus())
    assert (snap.min_pit_s, snap.max_stint_s) == (90, 1800)


def test_settings_endpoint_sets_limits():
    with TestClient(app) as client:
        h = {"X-Safeword": "boxbox"}
        r = client.post("/e/1/api/admin/settings", headers=h, json={"min_pit_s": 120, "max_stint_s": 2400, "min_pits": 3})
        assert r.status_code == 200 and r.json()["min_pit_s"] == 120
        state = client.get("/e/1/api/state").json()
        assert state["max_stint_s"] == 2400 and state["min_pits"] == 3
        assert client.post("/e/1/api/admin/settings", headers=h, json={"min_pits": 51}).status_code == 422
        assert client.post("/e/1/api/admin/settings", headers=h, json={"min_pit_s": -1}).status_code == 422
        client.post("/e/1/api/admin/settings", headers=h, json={"min_pit_s": 0, "max_stint_s": 0, "min_pits": 0})
    get_manager().get(1).reset()


def test_pit_board_ignores_mywer_noise(monkeypatch):
    """MyWeR (Rozzano): the in-pit flag blips and the last-pit time jitters to
    sub-second values on ordinary laps. Only the pit counter makes stops."""
    clock = _Clock(monkeypatch)
    state = EventState(1)

    def frame(**kw):
        row = make_row(**kw)
        state.update(RaceInfo(), [row])
        return row

    frame(laps=1, last_lap_ms=60000)
    laps, pits, real = 1, 0, 0
    for lap in range(2, 30):
        clock.t += 60
        laps += 1
        # every lap: a one-frame pit blip and a junk last-pit time
        frame(laps=laps, last_lap_ms=60000, pits=pits, last_pit_ms=600 + lap * 50, in_pit=True)
        clock.t += 1
        frame(laps=laps, last_lap_ms=60000, pits=pits, last_pit_ms=real or 300)
        if lap in (10, 20):                     # the two real stops
            clock.t += 2
            for _ in range(60):
                clock.t += 1
                frame(laps=laps, last_lap_ms=60000, pits=pits, last_pit_ms=real or 300, in_pit=True)
            clock.t += 1
            pits += 1
            real = 61300 if lap == 10 else 61800
            frame(laps=laps, last_lap_ms=60000, pits=pits, last_pit_ms=real)
    row = frame(laps=laps, last_lap_ms=60000, pits=pits, last_pit_ms=real)
    assert row.pit_times_ms == [61300, 61800]
    assert len(row.stints_s) == 2 and all(s > 400 for s in row.stints_s)


def test_pit_managed_endpoint():
    with TestClient(app) as client:
        h = {"X-Safeword": "boxbox"}
        assert client.post("/e/1/api/admin/pit-managed", headers=h, json={"key": "7:pit:0"}).status_code == 200
        assert client.get("/e/1/api/state").json()["pit_managed"] == ["7:pit:0"]
        client.post("/e/1/api/admin/pit-managed", headers=h, json={"key": "7:pit:0", "managed": False})
        assert client.get("/e/1/api/state").json()["pit_managed"] == []
        assert client.post("/e/1/api/admin/pit-managed", headers=h, json={"key": "7:bogus:0"}).status_code == 422
        assert client.post("/e/1/api/admin/pit-managed", json={"key": "7:pit:0"}).status_code == 401
    get_manager().get(1).reset()


def test_pit_board_drops_stops_under_20s(monkeypatch):
    """A counted stop whose only time is under 20 s (feed noise) has no
    duration: it can't be judged as a short pit."""
    clock = _Clock(monkeypatch)
    state = EventState(1)

    def frame(**kw):
        row = make_row(**kw)
        state.update(RaceInfo(), [row])
        return row

    frame(laps=1, last_lap_ms=60000)
    clock.t += 300
    frame(laps=6, last_lap_ms=60000)
    clock.t += 1
    row = frame(laps=6, last_lap_ms=60000, pits=1, last_pit_ms=14200)   # 14.2 s: noise
    assert row.pit_times_ms == [0]
    clock.t += 5
    row = frame(laps=6, last_lap_ms=60000, pits=1, last_pit_ms=62400)   # real time arrives
    assert row.pit_times_ms == [62400]


def test_pit_board_feed_time_before_counter(monkeypatch):
    """Rozzano (MyWeR, live 27/11): lastpittime updates a frame BEFORE
    nopitstops, and the pit flag is on for only ~12 s of a ~61 s stop. The
    stop must carry the feed's 61 s, never our 12 s flag measurement."""
    clock = _Clock(monkeypatch)
    state = EventState(1)

    def frame(**kw):
        row = make_row(**kw)
        state.update(RaceInfo(), [row])
        return row

    frame(laps=1, last_lap_ms=43000)
    pits, last = 0, 0
    for stop, feed in enumerate((61090, 62300, 60700)):
        clock.t += 900
        frame(laps=20 * (stop + 1), last_lap_ms=43000, pits=pits, last_pit_ms=last)
        for _ in range(12):                                   # flag on ~12 s
            clock.t += 1
            frame(laps=20 * (stop + 1), last_lap_ms=43000, pits=pits, last_pit_ms=last, in_pit=True)
        clock.t += 49                                         # rest of the stop, flag off
        last = feed
        frame(laps=20 * (stop + 1), last_lap_ms=43000, pits=pits, last_pit_ms=last)   # time first
        clock.t += 1
        pits += 1
        row = frame(laps=20 * (stop + 1), last_lap_ms=43000, pits=pits, last_pit_ms=last)  # then counter
    assert row.pit_times_ms == [61090, 62300, 60700]


def test_pit_board_feed_time_after_counter_waits(monkeypatch):
    clock = _Clock(monkeypatch)
    state = EventState(1)
    state.update(RaceInfo(), [make_row(laps=1, last_lap_ms=43000, last_pit_ms=0)])
    clock.t += 600
    state.update(RaceInfo(), [make_row(laps=14, last_lap_ms=43000, last_pit_ms=58000)])  # earlier stop's time? no: first real
    clock.t += 100
    row = make_row(laps=16, last_lap_ms=43000, pits=1, last_pit_ms=58000)
    state.update(RaceInfo(), [row])
    assert row.pit_times_ms == [58000]                        # fresh time, unused so far
    clock.t += 900
    row = make_row(laps=36, last_lap_ms=43000, pits=2, last_pit_ms=58000)   # counter, stale time
    state.update(RaceInfo(), [row])
    assert row.pit_times_ms == [58000, 0]                     # unknown, not the old 58 s
    clock.t += 2
    row = make_row(laps=36, last_lap_ms=43000, pits=2, last_pit_ms=63400)
    state.update(RaceInfo(), [row])
    assert row.pit_times_ms == [58000, 63400]


def test_pit_board_rozzano_live_stop(monkeypatch):
    """Real MyWeR frames (Rozzano, 27/11/2026): kart 5's 5th stop. nopitstops
    moves at pit ENTRY, lastpittime then counts up live (3.3 → … → 60.7 s,
    with stale frames jumping back) and the pit flag never moves. The board
    must show the kart in the pit while it counts and keep the final 60.737 s."""
    import json
    from app.sources.mywer import MyWerDecoder
    from .test_apex import FIXTURES

    clock = _Clock(monkeypatch)
    state = EventState(1)
    dec = MyWerDecoder()
    seen_in_pit = []
    with (FIXTURES / "rozzano_pitstop.ndjson").open(encoding="utf-8") as fh:
        for line in fh:
            rec = json.loads(line)
            clock.t = rec["ts"]
            race, rows = dec.decode(rec["payload"])
            if rows is None:
                continue
            state.update(race or state.race, rows)
            k5 = next(d for d in state.drivers if d.kart_no == "5")
            seen_in_pit.append(k5.in_pit)
    k5 = next(d for d in state.drivers if d.kart_no == "5")
    assert k5.pits == 5
    # joined mid-race: earlier stops unknown; the one we saw = the feed's final time
    assert k5.pit_times_ms == [60737]
    assert any(seen_in_pit) and not k5.in_pit                               # in pit while timing, out after
    # the stint after the stop counts from the pit exit, not the pit entry
    assert k5.stint_seconds is not None and k5.stint_seconds < 60
