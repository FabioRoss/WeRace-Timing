import json

from app.models import Flag
from app.sources.mywer import decode_mywer


def make_payload():
    return {
        "timestamp": 1720000000,
        "data": {
            "race": {
                "racetime": "00:42:10",
                "timetogo": "01:17:50",
                "flag": "G",
                "timeofday": "15:22:11",
                "trackname": "Kartodromo Test",
                "eventname": "Endurance 2h",
                "runtype": "F",
                "endrace": False,
            },
            "drivers": [
                {
                    "position": 1,
                    "transp1": 4001,
                    "raceno": "7",
                    "fullname": "Team Rocket",
                    "besttime": "00:00:52.123000",
                    "lasttime": "00:00:53.456000",
                    "gap": "",
                    "difference": "",
                    "laps": 45,
                    "bestinlap": 12,
                    "lastpittime": "00:01:05.000000",
                    "totpittime": "00:02:10.000000",
                    "sincepit": "00:25:11",
                    "nopitstops": 2,
                    "end": False,
                },
                {
                    "position": 2,
                    "transp1": 4002,
                    "raceno": "12",
                    "fullname": "Slow & Steady",
                    "besttime": "00:00:52.900000",
                    "lasttime": "00:00:00.000000",
                    "gap": "3.456",
                    "difference": "3.456",
                    "laps": 45,
                    "bestinlap": 30,
                    "lastpittime": "00:00:00.000000",
                    "totpittime": "00:00:00.000000",
                    "sincepit": "",
                    "nopitstops": 0,
                    "end": False,
                },
            ],
        },
    }


def test_decode_full_snapshot():
    race, drivers = decode_mywer(json.dumps(make_payload()))
    assert race is not None
    assert race.flag == Flag.GREEN
    assert race.time_to_go == "01:17:50"
    assert race.race_time == "42:10"
    assert race.track_name == "Kartodromo Test"
    assert not race.ended

    assert drivers is not None and len(drivers) == 2
    p1, p2 = drivers
    assert p1.kart_no == "7"
    assert p1.best_lap_ms == 52123
    assert p1.last_lap_ms == 53456
    assert p1.pits == 2
    assert p1.stint_time == "00:25:11"
    assert p2.last_lap_ms is None            # all-zero time means absent
    assert p2.gap_ahead == "3.456"


def test_race_only_message():
    payload = {"data": {"race": {"racetime": "00:10:00", "flag": "Y"}}}
    race, drivers = decode_mywer(json.dumps(payload))
    assert race is not None and race.flag == Flag.YELLOW
    assert drivers is None


def test_flag_mapping():
    for raw, expected in [("W", Flag.WARMUP), ("S", Flag.STOPPED), ("F", Flag.FINISH), ("C", Flag.FINISH)]:
        payload = {"data": {"race": {"flag": raw}}}
        race, _ = decode_mywer(json.dumps(payload))
        assert race.flag == expected


# ------------------------------------------------- lap-limited races & merging

from pathlib import Path

from app.sources.mywer import MyWerDecoder

FIXTURES = Path(__file__).parent / "fixtures"


def race_frame(fields: dict) -> str:
    return json.dumps({"data": {"race": fields}})


def test_lap_limited_session_is_race_with_laps_to_go():
    dec = MyWerDecoder()
    race, _ = dec.decode(race_frame({
        "runtype": "Q", "duralaps": 13, "duratime": "00:00:00",
        "lapstogo": 13, "timetogo": "23:59:58", "flag": "G",
    }))
    assert race.session_kind == "race"
    assert race.time_to_go == "13 laps"
    assert race.togo_ms is None              # no time countdown for lap races


def test_partial_frames_keep_merged_race_state():
    dec = MyWerDecoder()
    dec.decode(race_frame({
        "runtype": "Q", "runname": "10.2", "duralaps": 13,
        "duratime": "00:00:00", "lapstogo": 13, "flag": "W",
        "trackname": "go-kart Rozzano",
    }))
    # partial frame: only dynamic fields, everything else null (as observed)
    race, _ = dec.decode(race_frame({
        "runtype": None, "duralaps": None, "duratime": None,
        "lapstogo": 5, "flag": "G", "timetogo": "23:55:00",
    }))
    assert race.session_kind == "race"
    assert race.time_to_go == "5 laps"
    assert race.track_name == "go-kart Rozzano"
    assert race.run_type == "10.2"


def test_endurance_runtype_is_a_race():
    """Christel runs endurance by-laps sessions the software reports as
    runtype 'E' with duralaps 0 (lap target enforced by an external timer
    reset). 'E' must classify as a race so the order toggle and ring lapped
    coloring work, not fall through to 'unknown'."""
    dec = MyWerDecoder()
    race, _ = dec.decode(race_frame({
        "runtype": "E", "runname": "RACE 124 Laps", "duralaps": 0,
        "duratime": "00:02:04", "flag": "G",
    }))
    assert race.session_kind == "race"


def test_single_lap_singular():
    dec = MyWerDecoder()
    race, _ = dec.decode(race_frame({"duralaps": 10, "duratime": "00:00:00", "lapstogo": 1}))
    assert race.time_to_go == "1 lap"


def test_timed_session_countdown_anchor_and_clamp():
    dec = MyWerDecoder()
    race, _ = dec.decode(race_frame({
        "runtype": "Q", "duralaps": 0, "duratime": "00:08:00",
        "timetogo": "00:07:39", "flag": "G",
    }))
    assert race.session_kind == "timed"
    assert race.time_to_go == "07:39"
    assert race.togo_ms == 459000
    assert race.togo_ts is not None
    assert race.counting is True

    # expired clock wraps to a 23:xx garbage counter -> clamp to zero
    race, _ = dec.decode(race_frame({"timetogo": "23:59:57"}))
    assert race.time_to_go == "00:00"
    assert race.togo_ms == 0
    assert race.counting is False


def test_waiting_flag_freezes_countdown():
    dec = MyWerDecoder()
    race, _ = dec.decode(race_frame({
        "duralaps": 0, "duratime": "00:08:00", "timetogo": "00:08:00", "flag": "W",
    }))
    assert race.togo_ms == 480000
    assert race.counting is False


def test_pit_flag_and_sectors():
    payload = {"data": {"drivers": [{
        "raceno": "9", "fullname": "T", "position": 3, "laps": 4,
        "pit": 1,
        "interm": [{"t1": "00:00:21.100000", "t2": "00:00:18.200000", "t3": "", "t4": ""}],
    }]}}
    _, drivers = decode_mywer(json.dumps(payload))
    d = drivers[0]
    assert d.in_pit and d.pit_state == "in"
    assert (d.s1_ms, d.s2_ms, d.s3_ms) == (21100, 18200, None)


def test_rozzano_fixture_replay():
    dec = MyWerDecoder()
    race = None
    kinds = []
    with (FIXTURES / "rozzano.ndjson").open(encoding="utf-8") as fh:
        for line in fh:
            rec = json.loads(line)
            r, _ = dec.decode(rec["payload"])
            if r is not None:
                race = r
                if not kinds or kinds[-1] != r.session_kind:
                    kinds.append(r.session_kind)
    # session A (13-lap race) then session B (8-minute timed session)
    assert kinds[0] == "race"
    assert kinds[-1] == "timed"
    # final frame: timed session ended, garbage 23:xx clock clamped
    assert race.time_to_go == "00:00"
    assert race.togo_ms == 0


# ----------------------------------------------- multi-driver entry collapse

def test_duplicate_racenos_collapse_to_current_entry():
    """Team sessions list one entry per registered DRIVER: same raceno,
    different id/drv. Only the kart's current state must survive."""
    payload = {"data": {"drivers": [
        {   # stale entry: previous driver, no position, fewer laps
            "id": 1, "drv": 0, "raceno": "33", "fullname": "Driver A",
            "position": 0, "laps": 10, "time": 1000,
            "lasttime": "00:00:52.000000", "besttime": "00:00:51.000000",
        },
        {   # current entry
            "id": 2, "drv": 1, "raceno": "33", "fullname": "Driver B",
            "position": 4, "laps": 25, "time": 2000,
            "lasttime": "00:00:50.100000", "besttime": "00:00:49.900000",
        },
        {   # another kart, single driver
            "id": 3, "drv": 0, "raceno": "7", "fullname": "Solo",
            "position": 1, "laps": 26, "time": 2000,
            "lasttime": "00:00:49.000000", "besttime": "00:00:48.500000",
        },
    ]}}
    _, drivers = decode_mywer(json.dumps(payload))
    karts = [d.kart_no for d in drivers]
    assert sorted(karts) == ["33", "7"]          # no duplicates
    row33 = next(d for d in drivers if d.kart_no == "33")
    assert row33.name == "Driver B"
    assert row33.position == 4
    assert row33.laps == 25


def test_duplicate_racenos_tiebreak_by_time():
    payload = {"data": {"drivers": [
        {"id": 1, "raceno": "9", "fullname": "Old", "position": 2, "laps": 5, "time": 100},
        {"id": 2, "raceno": "9", "fullname": "New", "position": 2, "laps": 5, "time": 200},
    ]}}
    _, drivers = decode_mywer(json.dumps(payload))
    assert len(drivers) == 1
    assert drivers[0].name == "New"
