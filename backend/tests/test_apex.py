import json
from pathlib import Path

from app.models import Flag
from app.sources.apex import ApexGrid

FIXTURES = Path(__file__).parent / "fixtures"

GRID_HTML = """
<table>
<tr data-id="r0">
  <td data-id="r0c0" data-type="sta"></td>
  <td data-id="r0c1" data-type="rk">Clt</td>
  <td data-id="r0c2" data-type="no">No</td>
  <td data-id="r0c3" data-type="dr">Team</td>
  <td data-id="r0c4" data-type="llp">Last</td>
  <td data-id="r0c5" data-type="blp">Best</td>
  <td data-id="r0c6" data-type="gap">Gap</td>
  <td data-id="r0c7" data-type="int">Interv.</td>
  <td data-id="r0c8" data-type="lap">Laps</td>
</tr>
<tr data-id="r1">
  <td data-id="r1c0"></td>
  <td data-id="r1c1"><p>1</p></td>
  <td data-id="r1c2">7</td>
  <td data-id="r1c3">Team Rocket</td>
  <td data-id="r1c4">53.456</td>
  <td data-id="r1c5">52.123</td>
  <td data-id="r1c6"></td>
  <td data-id="r1c7"></td>
  <td data-id="r1c8">45</td>
</tr>
<tr data-id="r2">
  <td data-id="r2c0"></td>
  <td data-id="r2c1"><p>2</p></td>
  <td data-id="r2c2">12</td>
  <td data-id="r2c3">Slow &amp; Steady</td>
  <td data-id="r2c4">54.001</td>
  <td data-id="r2c5">52.900</td>
  <td data-id="r2c6">3.456</td>
  <td data-id="r2c7">3.456</td>
  <td data-id="r2c8">45</td>
</tr>
</table>
"""


def make_grid() -> ApexGrid:
    grid = ApexGrid()
    grid.apply("grid|" + GRID_HTML.replace("\n", ""))
    return grid


def test_grid_parse():
    grid = make_grid()
    rows = grid.standings()
    assert len(rows) == 2
    p1, p2 = rows
    assert p1.kart_no == "7"
    assert p1.position == 1
    assert p1.name == "Team Rocket"
    assert p1.last_lap_ms == 53456
    assert p1.best_lap_ms == 52123
    assert p1.laps == 45
    assert p2.kart_no == "12"
    assert p2.gap_leader == "3.456"
    assert p2.gap_ahead == "3.456"


def test_cell_update_changes_value():
    grid = make_grid()
    grid.apply("r1c4|ti|52.999")
    rows = grid.standings()
    assert rows[0].last_lap_ms == 52999


def test_cell_update_without_class_keeps_class():
    grid = make_grid()
    grid.apply("r1c4|ti|52.999")
    grid.apply("r1c4||53.500")
    assert grid.cells[(1, 4)]["class"] == "ti"
    assert grid.standings()[0].last_lap_ms == 53500


def test_update_with_html_value():
    grid = make_grid()
    grid.apply("r2c1||<p>1</p>")
    grid.apply("r1c1||<p>2</p>")
    rows = grid.standings()
    assert rows[0].kart_no == "12"      # positions swapped
    assert rows[1].kart_no == "7"


def test_row_hash_reorders():
    grid = make_grid()
    grid.apply("r1|#|2")
    grid.apply("r2|#|1")
    rows = grid.standings()
    assert rows[0].kart_no == "12"
    assert rows[0].position == 1
    assert rows[1].kart_no == "7"


def test_pit_in_out_row_commands():
    grid = make_grid()
    grid.apply("r1|*in|0")
    assert grid.standings()[0].in_pit
    grid.apply("r1|*out|0")
    assert not grid.standings()[0].in_pit


def test_pit_from_status_class():
    grid = make_grid()
    grid.apply("r1c0|si|")              # c0 is the status (sta) column
    assert grid.standings()[0].in_pit
    grid.apply("r1c0|so|")
    assert not grid.standings()[0].in_pit


def test_lap_reference_commands_ignored():
    grid = make_grid()
    grid.apply("r1|*|94890|32697")
    grid.apply("r1|*i1|38563")
    grid.apply("r1|*i2|")
    grid.apply("br5c3|in|1:34.409")
    assert len(grid.standings()) == 2


def test_header_by_label_when_no_data_type():
    grid = ApexGrid()
    html = (
        '<table><tr data-id="r0">'
        '<td data-id="r0c0">Pos</td><td data-id="r0c1">Kart</td>'
        '<td data-id="r0c2">Pilote</td><td data-id="r0c3">Dernier tour</td></tr>'
        '<tr data-id="r1"><td data-id="r1c0">1</td><td data-id="r1c1">42</td>'
        '<td data-id="r1c2">Equipe X</td><td data-id="r1c3">1:02.345</td></tr></table>'
    )
    grid.apply("grid|" + html)
    rows = grid.standings()
    assert rows[0].kart_no == "42"
    assert rows[0].last_lap_ms == 62345


def test_dyn_and_light_and_title():
    grid = make_grid()
    grid.apply("dyn1|<b>1:17:50</b>")
    grid.apply("title1||Endurance Cup")
    grid.apply("light|lg|")
    assert grid.race.time_to_go == "1:17:50"
    assert grid.race.event_name == "Endurance Cup"
    assert grid.race.flag == Flag.GREEN

    grid.apply("light|chk|")
    assert grid.race.flag == Flag.FINISH
    assert grid.race.ended


def test_dyn_count_up_is_elapsed_time():
    grid = make_grid()
    grid.apply("dyn1|count|20899537")
    assert grid.race.race_time == "5:48:19"
    grid.apply("dyn1|count|20914613")
    assert grid.race.race_time == "5:48:34"
    assert grid.race.time_to_go == ""


def test_dyn_count_down_is_countdown():
    grid = make_grid()
    grid.apply("dyn1|count|3600000")
    assert grid.race.race_time == "1:00:00"
    grid.apply("dyn1|count|3540000")
    assert grid.race.time_to_go == "59:00"
    assert grid.race.race_time == ""


def test_clear_resets_grid():
    grid = make_grid()
    grid.apply("clear|")
    assert grid.standings() == []


def test_unknown_commands_ignored():
    grid = make_grid()
    grid.apply("wtf|whatever|x")
    grid.apply("css|r1c4|ti")
    assert len(grid.standings()) == 2


# ---------------------------------------------------------------- live capture

def replay_fixture(name: str) -> ApexGrid:
    """Replay a real capture (mid-session join, no grid frame)."""
    grid = ApexGrid()
    with (FIXTURES / name).open(encoding="utf-8") as fh:
        for line in fh:
            rec = json.loads(line)
            for cmd in rec["payload"].replace("\r", "").split("\n"):
                cmd = cmd.strip()
                if cmd:
                    grid.apply(cmd)
    return grid


def replay_cremona() -> ApexGrid:
    return replay_fixture("cremona.ndjson")


def test_cremona_replay_decodes_laps_and_positions():
    grid = replay_cremona()
    rows = {d.kart_no: d for d in grid.standings()}

    # header-less stream -> fallback columns, rows keyed by grid row id
    assert not grid.columns

    r59 = rows["59"]
    assert r59.last_lap_ms == 95309          # final r59c9 = 1:35.309
    assert r59.best_lap_ms == 94890          # r59c10 = 1:34.890
    assert r59.laps == 32
    assert r59.gap_leader == "0.339"

    r71 = rows["71"]
    assert r71.position == 7                 # r71|#|7
    assert r71.best_lap_ms == 95957
    assert rows["62"].position == 14
    assert rows["86"].position == 24
    assert rows["50"].position == 26


def test_cremona_replay_pit_state():
    grid = replay_cremona()
    rows = {d.kart_no: d for d in grid.standings()}
    # r71/r62 pitted (*in) and came back out (*out)
    assert not rows["71"].in_pit
    assert not rows["62"].in_pit
    # r3/r44 pitted at the end of the capture and never came out
    assert rows["3"].in_pit
    assert rows["44"].in_pit


def test_cremona_replay_session_clock():
    grid = replay_cremona()
    # dyn1|count increases in wall time -> elapsed session time
    assert grid.race.race_time == "5:53:05"  # 21185325 ms
    assert grid.race.time_to_go == ""


def test_cremona_replay_ranking_order():
    grid = replay_cremona()
    order = [d.kart_no for d in grid.standings()]
    assert order.index("71") < order.index("62") < order.index("86")


# ------------------------------------------------- practice session capture

def test_practice_replay_positions_are_consistent():
    grid = replay_fixture("cremona_practice.ndjson")
    rows = grid.standings()
    positions = [d.position for d in rows]
    assert positions == sorted(positions)
    assert len(set(positions)) == len(positions), "positions must be unique"
    assert rows[0].kart_no == "59"
    assert rows[0].best_lap_ms == 94288          # 1:34.288


def test_practice_replay_best_lap_monotonic_for_positioned():
    """This session ranks by best lap; server-positioned rows must reflect it."""
    grid = replay_fixture("cremona_practice.ndjson")
    positioned = [
        d for d in grid.standings()
        if grid.row_pos.get(int(d.kart_no)) and d.best_lap_ms
    ]
    bests = [d.best_lap_ms for d in positioned]
    assert len(bests) > 20
    assert bests == sorted(bests), "positioned karts out of best-lap order"


def test_practice_replay_unpositioned_sorted_by_best():
    grid = replay_fixture("cremona_practice.ndjson")
    rows = grid.standings()
    known = max(grid.row_pos.values())
    tail = [d for d in rows if d.position > known]
    tail_bests = [d.best_lap_ms for d in tail if d.best_lap_ms]
    assert tail_bests == sorted(tail_bests)


def test_headerless_practice_orders_by_best_lap():
    """No positions at all (fresh mid-session join) -> fastest kart first."""
    grid = ApexGrid()
    grid.apply("r5c9|tn|1:02.000")
    grid.apply("r5c10|ib|1:01.000")
    grid.apply("r5c13|in|10")
    grid.apply("r7c9|tn|59.000")
    grid.apply("r7c10|ib|58.500")
    grid.apply("r7c13|in|12")
    grid.apply("r9c13|in|3")                     # no best lap yet
    rows = grid.standings()
    assert [d.kart_no for d in rows] == ["7", "5", "9"]
    assert [d.position for d in rows] == [1, 2, 3]


def test_repeated_grid_html_does_not_duplicate_rows():
    """Grid/page HTML can contain the table twice (desktop + mobile copies)."""
    html = (
        '<table><tr data-id="r0"><td data-id="r0c1" data-type="rk">Pos</td>'
        '<td data-id="r0c2" data-type="no">No</td></tr>'
        '<tr data-id="r1"><td data-id="r1c1">1</td><td data-id="r1c2">607</td></tr>'
        '<tr data-id="r2"><td data-id="r2c1">2</td><td data-id="r2c2">318</td></tr></table>'
        '<table><tr data-id="r0"><td data-id="r0c1" data-type="rk">Pos</td></tr>'
        '<tr data-id="r1"><td data-id="r1c1">1</td></tr>'
        '<tr data-id="r2"><td data-id="r2c1">2</td></tr></table>'
    )
    grid = ApexGrid()
    grid.apply("grid|" + html)
    assert grid.row_order == sorted(set(grid.row_order))
    karts = [d.kart_no for d in grid.standings()]
    assert karts == ["607", "318"]
