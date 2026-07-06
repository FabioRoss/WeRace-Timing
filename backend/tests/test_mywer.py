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
