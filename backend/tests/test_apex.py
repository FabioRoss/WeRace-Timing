from app.models import Flag
from app.sources.apex import ApexGrid

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
    grid.apply("update|r1c4|52.999|ti")
    rows = grid.standings()
    assert rows[0].last_lap_ms == 52999


def test_update_with_html_value():
    grid = make_grid()
    grid.apply("update|r2c1|<p>1</p>|")
    grid.apply("update|r1c1|<p>2</p>|")
    rows = grid.standings()
    assert rows[0].kart_no == "12"      # positions swapped
    assert rows[1].kart_no == "7"


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
    grid.apply("title|Endurance Cup")
    grid.apply("light|lg green")
    assert grid.race.time_to_go == "1:17:50"
    assert grid.race.event_name == "Endurance Cup"
    assert grid.race.flag == Flag.GREEN

    grid.apply("light|chk")
    assert grid.race.flag == Flag.FINISH
    assert grid.race.ended


def test_clear_resets_grid():
    grid = make_grid()
    grid.apply("clear|")
    assert grid.standings() == []


def test_unknown_commands_ignored():
    grid = make_grid()
    grid.apply("wtf|whatever|x")
    grid.apply("css|r1c4|ti")
    assert len(grid.standings()) == 2
