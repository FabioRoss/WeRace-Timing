from app.models import DriverRow, Flag, RaceInfo, SourceStatus
from app.security import make_token, resolve_token
from app.state import EventState


def rows(*specs):
    return [
        DriverRow(
            kart_no=k, position=p, laps=laps, last_lap_ms=last, best_lap_ms=best,
            gap_ahead=gap, pits=pits,
        )
        for (k, p, laps, last, best, gap, pits) in specs
    ]


def test_tokens_differ_by_slot_role_kart():
    t = make_token(1, "driver", "7")
    assert t == make_token(1, "driver", "7")
    assert t == make_token(1, "driver", " 7 ")        # normalized
    assert t != make_token(2, "driver", "7")          # per-slot
    assert t != make_token(1, "team", "7")            # per-role
    assert t != make_token(1, "driver", "8")
    assert len(t) == 16


def test_resolve_token():
    karts = ["5", "7", "12"]
    token = make_token(1, "team", "12")
    assert resolve_token(1, "team", token, karts) == "12"
    assert resolve_token(1, "driver", token, karts) is None
    assert resolve_token(1, "team", "0" * 16, karts) is None


def test_state_lap_history_and_session_best():
    state = EventState(1)
    state.update(RaceInfo(flag=Flag.GREEN), rows(("7", 1, 10, 53000, 52000, "", 0)))
    state.update(None, rows(("7", 1, 11, 52500, 52000, "", 0)))
    state.update(None, rows(("7", 1, 11, 52500, 52000, "", 0)))   # same lap, no dup
    history = state.lap_history["7"]
    assert [r.lap_no for r in history] == [10, 11]
    assert state.session_best_ms == 52000
    assert state.session_best_kart == "7"


def test_driver_view_gaps_and_neighbors():
    state = EventState(1)
    state.update(
        RaceInfo(flag=Flag.GREEN, time_to_go="55:00"),
        rows(
            ("7", 1, 20, 52000, 51500, "", 1),
            ("12", 2, 20, 52400, 51900, "1.2", 0),
            ("3", 3, 19, 53000, 52200, "4.5", 2),
        ),
    )
    view = state.driver_view("12")
    assert view["found"] is True
    assert view["position"] == 2
    assert view["total_karts"] == 3
    assert view["gap_ahead"] == "1.2"
    assert view["gap_behind"] == "4.5"     # gap_ahead of the kart behind
    assert view["kart_ahead"] == "7"
    assert view["kart_behind"] == "3"
    assert view["time_to_go"] == "55:00"

    leader = state.driver_view("7")
    assert leader["gap_ahead"] == ""
    assert leader["gap_behind"] == "1.2"

    ghost = state.driver_view("99")
    assert ghost["found"] is False


def test_stint_fallback_resets_on_pit():
    state = EventState(1)
    state.update(None, rows(("7", 1, 10, 52000, 51500, "", 0)))
    first = state.driver_view("7")["stint_seconds"]
    assert first is not None and first >= 0
    # Pit count increase resets the fallback stint clock
    state.update(None, rows(("7", 1, 11, 90000, 51500, "", 1)))
    after_pit = state.driver_view("7")["stint_seconds"]
    assert after_pit is not None and after_pit <= first + 1


def test_stint_prefers_source_value():
    state = EventState(1)
    driver = DriverRow(kart_no="7", position=1, laps=5, stint_time="00:25:11")
    state.update(None, [driver])
    assert state.driver_view("7")["stint_seconds"] == 25 * 60 + 11


def test_penalty_store_add_serve_remove():
    state = EventState(1)
    p1 = state.add_penalty("7", "time", seconds=10, reason="Contact")
    p2 = state.add_penalty("12", "lap", laps=1, reason="Track limits")
    p3 = state.add_penalty("7", "warning", reason="Aggressive driving")
    assert [p.id for p in state.penalties] == [1, 2, 3]
    assert p1.seconds == 10 and p2.laps == 1 and p3.kind == "warning"
    assert state.find_penalty(2) is p2

    state.set_penalty_served(1, True)
    assert state.find_penalty(1).served is True
    state.set_penalty_served(1, False)
    assert state.find_penalty(1).served is False

    assert state.remove_penalty(3) is p3
    assert [p.id for p in state.penalties] == [1, 2]
    assert state.remove_penalty(999) is None


def test_penalties_in_snapshot_and_driver_view():
    state = EventState(1)
    state.update(None, rows(("7", 1, 5, 52000, 51000, "", 0), ("12", 2, 5, 53000, 51500, "", 0)))
    state.add_penalty("7", "time", seconds=5, reason="Contact")
    state.add_penalty("12", "warning", reason="Track limits")

    snap = state.snapshot(SourceStatus())
    assert [p.kart_no for p in snap.penalties] == ["7", "12"]

    # driver_view carries only that kart's penalties
    own = state.driver_view("7")["penalties"]
    assert len(own) == 1 and own[0]["kart_no"] == "7"
    assert state.driver_view("12")["penalties"][0]["kind"] == "warning"


def test_penalties_cleared_on_session_rollover():
    state = EventState(1)
    state.update(RaceInfo(run_type="R", session_kind="race"),
                 rows(("7", 1, 40, 52000, 51000, "", 0)))
    state.add_penalty("7", "time", seconds=10, reason="Contact")
    assert state.penalties
    state._reset_session_state("test")
    assert state.penalties == []
