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
