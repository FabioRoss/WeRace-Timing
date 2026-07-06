from app.models import DriverRow, Flag, RaceInfo
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
