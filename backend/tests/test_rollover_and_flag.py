"""Session rollover detection and race-control flag override."""

from fastapi.testclient import TestClient

from app.events import get_manager
from app.main import app
from app.models import DriverRow, Flag, RaceInfo
from app.state import EventState

SAFEWORD = {"X-Safeword": "boxbox"}


def rows(*laps_by_kart: tuple[str, int]) -> list[DriverRow]:
    return [
        DriverRow(kart_no=k, position=i + 1, laps=laps, last_lap_ms=90000)
        for i, (k, laps) in enumerate(laps_by_kart)
    ]


def test_lap_regression_resets_history():
    state = EventState(1)
    state.update(RaceInfo(), rows(("7", 10), ("9", 9)))
    state.update(RaceInfo(), rows(("7", 11), ("9", 10)))
    assert len(state.lap_history["7"]) == 2
    state.session_best_ms = 88000

    # new session: everyone drops back to lap 1
    state.update(RaceInfo(), rows(("7", 1), ("9", 1)))
    assert state.lap_history == {"7": [state.lap_history["7"][0]]} or "7" in state.lap_history
    # history restarted (only the new lap-1 records remain)
    assert all(rec.lap_no <= 1 for h in state.lap_history.values() for rec in h)
    assert state.session_best_ms != 88000 or state.session_best_ms is None

    # laps keep recording in the new session
    state.update(RaceInfo(), rows(("7", 2), ("9", 2)))
    assert [r.lap_no for r in state.lap_history["7"]] == [1, 2]


def test_single_kart_glitch_does_not_reset():
    state = EventState(1)
    state.update(RaceInfo(), rows(("7", 10), ("9", 9), ("11", 8)))
    state.update(RaceInfo(), rows(("7", 11), ("9", 10), ("11", 9)))
    history_len = len(state.lap_history["7"])
    # one kart glitches backwards; others keep counting
    state.update(RaceInfo(), rows(("7", 5), ("9", 11), ("11", 10)))
    assert len(state.lap_history["7"]) == history_len   # not wiped


def test_stale_subset_refresh_does_not_reset():
    """MyWeR periodically emits a full-metadata frame carrying only a stale
    SUBSET of the field (a couple of karts whose lap counts lag by one). This
    must not be read as a session rollover — the real dump wiped 138 laps of
    history this way. Reproduce the recorded moment (christel, ~lap 139)."""
    state = EventState(1)
    field = [("21", 137), ("22", 136), ("36", 138), ("34", 94), ("25", 138),
             ("26", 135), ("27", 133), ("28", 137), ("39", 130), ("30", 132),
             ("32", 139), ("33", 135)]
    state.update(RaceInfo(), rows(*field))
    state.update(RaceInfo(), rows(*[(k, n + 1) for k, n in field]))
    before = {k: len(state.lap_history[k]) for k, _ in field}
    assert all(v >= 1 for v in before.values())

    # the anomalous frame: only karts 34 and 33, each one lap behind the live count
    state.update(RaceInfo(), rows(("34", 94), ("33", 135)))
    after = {k: len(state.lap_history.get(k, [])) for k, _ in field}
    assert after == before          # nothing wiped
    assert state.lap_history          # history intact


def test_run_type_change_resets():
    state = EventState(1)
    state.update(RaceInfo(run_type="10.2"), rows(("7", 10)))
    state.update(RaceInfo(run_type="10.2"), rows(("7", 11)))
    assert len(state.lap_history["7"]) == 2
    state.update(RaceInfo(run_type="11.1"), None)
    assert state.lap_history == {}


def test_flag_override_in_snapshot_and_driver_view():
    state = EventState(1)
    state.update(RaceInfo(flag=Flag.GREEN), rows(("7", 3)))
    state.flag_override = Flag.YELLOW

    from app.models import SourceStatus
    snap = state.snapshot(SourceStatus())
    assert snap.race.flag == Flag.YELLOW
    assert snap.flag_override == Flag.YELLOW
    assert state.race.flag == Flag.GREEN         # source state untouched
    assert state.driver_view("7")["flag"] == Flag.YELLOW

    state.flag_override = None
    assert state.snapshot(SourceStatus()).race.flag == Flag.GREEN


def test_flag_endpoint_set_and_clear():
    with TestClient(app) as client:
        r = client.post("/e/1/api/admin/flag", headers=SAFEWORD, json={"flag": "yellow"})
        assert r.json() == {"ok": True, "flag_override": "yellow"}
        status = client.get("/e/1/api/admin/status", headers=SAFEWORD).json()
        assert status["flag_override"] == "yellow"

        r = client.post("/e/1/api/admin/flag", headers=SAFEWORD, json={"flag": None})
        assert r.json()["flag_override"] is None

        r = client.post("/e/1/api/admin/flag", headers=SAFEWORD, json={"flag": "sparkly"})
        assert r.status_code == 422
        get_manager().get(1).reset()


def test_laps_api_includes_ts():
    with TestClient(app) as client:
        event = get_manager().get(1)
        event.state.update(RaceInfo(), rows(("7", 1)))
        body = client.get("/e/1/api/laps?karts=7").json()
        assert body["laps"]["7"][0]["ts"] > 0
        event.reset()


def test_state_drops_duplicate_kart_rows():
    state = EventState(1)
    state.update(RaceInfo(), [
        DriverRow(kart_no="33", position=4, laps=25, last_lap_ms=50100),
        DriverRow(kart_no="33", position=0, laps=10, last_lap_ms=52000),
        DriverRow(kart_no="7", position=1, laps=26, last_lap_ms=49000),
    ])
    karts = [d.kart_no for d in state.drivers]
    assert sorted(karts) == ["33", "7"]
    kept = next(d for d in state.drivers if d.kart_no == "33")
    assert kept.position == 4                     # best-positioned entry kept


def test_out_lap_uses_previous_clean_lap_as_pace_reference():
    state = EventState(1)
    mk = lambda laps, ms, pits=0: DriverRow(
        kart_no="7", position=1, laps=laps, last_lap_ms=ms, pits=pits,
    )
    state.update(RaceInfo(), [mk(1, 95000)])
    state.update(RaceInfo(), [mk(2, 95400)])
    # pit lap: lap time includes the stop
    state.update(RaceInfo(), [mk(3, 150000, pits=1)])
    row = mk(3, 150000, pits=1)
    state.update(RaceInfo(), [row])
    # fallback anchor must use the last clean lap + 1s, not the inflated lap
    assert row.prog_ms == 96400
    # next clean lap goes back to the real time
    row2 = mk(4, 96000, pits=1)
    state.update(RaceInfo(), [row2])
    assert row2.prog_ms == 96000


def test_stint_seconds_falls_back_when_feed_is_zero(monkeypatch):
    import app.state as state_mod
    clock = {"t": 1000.0}
    monkeypatch.setattr(state_mod.time, "time", lambda: clock["t"])
    state = EventState(1)
    mk = lambda pits, laps: DriverRow(
        kart_no="7", position=1, laps=laps, last_lap_ms=90000, pits=pits,
        stint_time="00:00:00.000000",   # MyWeR sends all-zeros at this venue
    )
    state.update(RaceInfo(), [mk(0, 1)])
    assert state.drivers[0].stint_seconds == 0
    clock["t"] += 45
    state.update(RaceInfo(), [mk(0, 2)])
    assert state.drivers[0].stint_seconds == 45         # rises with wall time
    # a pit stop resets the stint
    clock["t"] += 30
    state.update(RaceInfo(), [mk(1, 3)])
    assert state.drivers[0].stint_seconds == 0


def test_stint_seconds_uses_feed_value_when_present():
    state = EventState(1)
    state.update(RaceInfo(), [DriverRow(
        kart_no="7", position=1, laps=5, last_lap_ms=90000,
        stint_time="00:12:30.000000",
    )])
    assert state.drivers[0].stint_seconds == 750


# --------------------------------------------------- recompute positions

from pathlib import Path
from app.sources.mywer import MyWerDecoder

FIXTURES = Path(__file__).parent / "fixtures"


def _replay_christel_last():
    dec = MyWerDecoder()
    race = drivers = None
    for line in (FIXTURES / "christel.ndjson").open(encoding="utf-8"):
        import json as _json
        r, d = dec.decode(_json.loads(line)["payload"])
        if r is not None: race = r
        if d is not None: drivers = d
    return race, drivers


def test_recompute_positions_reorders_by_laps_and_time():
    race, drivers = _replay_christel_last()
    state = EventState(1)
    state.recompute_positions = True
    state.update(race, drivers)
    out = state.drivers
    # positions are a clean 1..N with no gaps/dupes
    assert [d.position for d in out] == list(range(1, len(out) + 1))
    # leader is the most-laps kart (feed had it mid-grid)
    leader = out[0]
    assert leader.laps == max(d.laps for d in out)
    # order respects (-laps, total_time_ms)
    keys = [(-d.laps, d.total_time_ms or float("inf")) for d in out]
    assert keys == sorted(keys)
    # same-lap gap to leader is a seconds string, not the feed's 0.000
    same_lap = next((d for d in out[1:] if d.laps == leader.laps), None)
    if same_lap:
        assert same_lap.gap_leader and same_lap.gap_leader != "00.000"


def test_recompute_disabled_keeps_feed_order():
    race, drivers = _replay_christel_last()
    state = EventState(1)                       # recompute off (default)
    state.update(race, drivers)
    # feed order preserved (sorted by feed position, as before)
    feed_positions = [d.position for d in state.drivers]
    assert feed_positions == sorted(feed_positions)


def test_settings_survive_reset():
    state = EventState(1)
    state.recompute_positions = True
    state.auto_pitlane = False
    state.reset()
    assert state.recompute_positions is True
    assert state.auto_pitlane is False


def test_settings_endpoint():
    with TestClient(app) as client:
        r = client.post("/e/1/api/admin/settings", headers=SAFEWORD,
                        json={"recompute_positions": True, "auto_pitlane": False})
        assert r.json() == {"ok": True, "recompute_positions": True, "auto_pitlane": False}
        status = client.get("/e/1/api/admin/status", headers=SAFEWORD).json()
        assert status["recompute_positions"] is True and status["auto_pitlane"] is False
        get_manager().get(1).reset()
        get_manager().get(1).state.recompute_positions = False
        get_manager().get(1).state.auto_pitlane = True


# ---------------------------------------------- inferred pits (no gates)

def test_infers_pit_from_long_lap_without_gates(monkeypatch):
    import app.state as state_mod
    clock = {"t": 1000.0}
    monkeypatch.setattr(state_mod.time, "time", lambda: clock["t"])
    state = EventState(1)
    state.auto_pitlane = False
    mk = lambda laps, ms: DriverRow(kart_no="7", position=1, laps=laps, last_lap_ms=ms)
    for lap, ms in [(1, 40000), (2, 40500), (3, 40200)]:
        clock["t"] += 40
        state.update(RaceInfo(), [mk(lap, ms)])
    assert state.drivers[0].pits == 0
    # a 120s lap = a pit stop the feed never reported
    clock["t"] += 120
    state.update(RaceInfo(), [mk(4, 120000)])
    row = state.drivers[0]
    assert row.pits == 1
    assert state.lap_history["7"][-1].pit is True
    # stint reset by the inferred pit
    assert row.stint_seconds == 0


def test_infers_currently_in_pit_when_overdue(monkeypatch):
    import app.state as state_mod
    clock = {"t": 1000.0}
    monkeypatch.setattr(state_mod.time, "time", lambda: clock["t"])
    state = EventState(1)
    state.auto_pitlane = False
    mk = lambda laps: DriverRow(kart_no="7", position=1, laps=laps, last_lap_ms=40000)
    clock["t"] += 40; state.update(RaceInfo(), [mk(1)])
    clock["t"] += 40; state.update(RaceInfo(), [mk(2)])   # clean pace ~40s
    # no new crossing for way longer than a lap -> in pit
    clock["t"] += 90
    state.update(RaceInfo(), [mk(2)])
    row = state.drivers[0]
    assert row.in_pit and row.pit_state == "in"
    assert row.pit_since_ts is not None


def test_gated_venue_keeps_feed_pits():
    state = EventState(1)               # auto_pitlane True (default)
    state.update(RaceInfo(), [DriverRow(kart_no="7", position=1, laps=5, last_lap_ms=200000, pits=2)])
    assert state.drivers[0].pits == 2   # feed value untouched, no inference
