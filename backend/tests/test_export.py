"""PDF timesheet export endpoint."""

import time

import pytest
from fastapi.testclient import TestClient

from app.events import get_manager
from app.main import app
from app.models import DriverRow, Flag, RaceInfo


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c
    for event in get_manager().events.values():
        event.reset()


def _seed_with_laps(slot: int = 1):
    event = get_manager().get(slot)
    event.state.update(
        RaceInfo(event_name="Test Cup", track_name="Christel", run_type="E",
                 flag=Flag.FINISH, ended=True),
        [
            DriverRow(kart_no="32", name="JORDAN", position=1, laps=0,
                      best_lap_ms=38714, best_lap_no=8, pits=2, total_time_ms=8250000),
            DriverRow(kart_no="36", name="ZAKSPEED", position=2, laps=0,
                      best_lap_ms=38391, best_lap_no=5, pits=1, gap_leader="10.351"),
        ],
    )
    # Record a handful of laps so the grid + charts have data.
    for lap in range(1, 11):
        for kart, base in [("32", 39200), ("36", 39000)]:
            row = event.state.find(kart)
            row.laps = lap
            row.last_lap_ms = base + (lap % 4) * 90
            event.state._track_laps(row, time.time())
    return event


def test_timesheet_pdf_downloads(client):
    _seed_with_laps()
    r = client.get("/e/1/api/export/timesheet.pdf")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/pdf"
    assert "attachment" in r.headers.get("content-disposition", "")
    # Filename derives from the event + session (run) + date.
    assert "Test-Cup" in r.headers.get("content-disposition", "")
    assert r.content[:5] == b"%PDF-"
    assert len(r.content) > 1000       # a real multi-element document


def test_timesheet_pdf_custom_names_in_filename(client):
    _seed_with_laps()
    r = client.get("/e/1/api/export/timesheet.pdf?event=Summer%20Trophy&session=Final%20A")
    assert r.status_code == 200
    disp = r.headers.get("content-disposition", "")
    assert "Summer-Trophy" in disp and "Final-A" in disp


def test_timesheet_pdf_empty_slot_is_valid(client):
    # No source connected / no data: must still return a valid PDF, not a 500.
    r = client.get("/e/1/api/export/timesheet.pdf")
    assert r.status_code == 200
    assert r.content[:5] == b"%PDF-"


def test_timesheet_pdf_unknown_slot_404(client):
    assert client.get("/e/99/api/export/timesheet.pdf").status_code == 404


def test_timesheet_pdf_is_not_cacheable(client):
    _seed_with_laps()
    r = client.get("/e/1/api/export/timesheet.pdf")
    assert "no-store" in r.headers.get("cache-control", "")


def test_timesheet_pdf_reflects_current_state(client):
    # Regenerated per request: a state change must change the bytes (no cache).
    event = _seed_with_laps()
    first = client.get("/e/1/api/export/timesheet.pdf").content
    event.state.update(None, [
        DriverRow(kart_no="99", name="LATE ENTRY", position=1, laps=5, best_lap_ms=40000),
    ])
    second = client.get("/e/1/api/export/timesheet.pdf").content
    assert first != second


def test_timesheet_pdf_customization_params(client):
    _seed_with_laps()
    # Charts on, and grid off: both must still yield a valid PDF.
    r1 = client.get("/e/1/api/export/timesheet.pdf?charts=1")
    assert r1.status_code == 200 and r1.content[:5] == b"%PDF-"
    r2 = client.get("/e/1/api/export/timesheet.pdf?charts=0&grid=0")
    assert r2.status_code == 200 and r2.content[:5] == b"%PDF-"


def test_timesheet_pdf_pit_and_stint_tables(client):
    event = _seed_with_laps()
    event.state.auto_pitlane = False  # no gates: inferred pit laps + estimate
    # a clearly-anomalous lap so a pit is inferred and a stint boundary exists
    for kart in ("32", "36"):
        row = event.state.find(kart)
        row.laps = 11
        row.last_lap_ms = 95000
        event.state._track_laps(row, time.time())
    r = client.get("/e/1/api/export/timesheet.pdf?pits=1&stints=1&pitest=1")
    assert r.status_code == 200 and r.content[:5] == b"%PDF-"
    # both tables on their own still produce a valid PDF
    assert client.get("/e/1/api/export/timesheet.pdf?pits=1").content[:5] == b"%PDF-"
    assert client.get("/e/1/api/export/timesheet.pdf?stints=1").content[:5] == b"%PDF-"


def test_timesheet_pdf_accent_param(client):
    _seed_with_laps()
    # A light accent (needs contrast handling) and a bad one both render a PDF.
    assert client.get("/e/1/api/export/timesheet.pdf?accent=%2339ff14").content[:5] == b"%PDF-"
    assert client.get("/e/1/api/export/timesheet.pdf?accent=nope").content[:5] == b"%PDF-"


def test_clean_accent():
    from app.routers.export import _clean_accent
    assert _clean_accent("#39ff14") == "#39ff14"
    assert _clean_accent("39ff14") == "#39ff14"
    assert _clean_accent("f00") == "#f00"
    assert _clean_accent("nope") == "#e10600"
    assert _clean_accent("") == "#e10600"


def test_classification_interval_between_same_lap_karts(client):
    # Two karts both a lap down but on the same lap → a time interval, not +N L.
    event = get_manager().get(1)
    event.state.update(
        RaceInfo(event_name="Cup", run_type="R"),
        [
            DriverRow(kart_no="1", name="Leader", position=1, laps=20, total_time_ms=800000),
            DriverRow(kart_no="2", name="A", position=2, laps=19, total_time_ms=790000),
            DriverRow(kart_no="3", name="B", position=3, laps=19, total_time_ms=795000),
        ],
    )
    # The endpoint renders (the interval for #3 vs #2 is 5.000s, both 1 lap down).
    r = client.get("/e/1/api/export/timesheet.pdf")
    assert r.status_code == 200 and r.content[:5] == b"%PDF-"


def test_timesheet_pdf_503_when_reportlab_missing(client, monkeypatch):
    # If reportlab is ever absent from the image the endpoint must 503, not
    # crash the app (the app still imports because the dep is guarded).
    from app.routers import export
    monkeypatch.setattr(export, "_REPORTLAB_OK", False)
    r = client.get("/e/1/api/export/timesheet.pdf")
    assert r.status_code == 503


def _seed_two_close(slot: int = 1):
    """Two karts on the same lap, kart 7 leading by 0.5s."""
    event = get_manager().get(slot)
    event.state.update(
        RaceInfo(event_name="Test", track_name="Christel", run_type="R"),
        [
            DriverRow(kart_no="7", name="ALPHA", position=1, laps=20, total_time_ms=1_000_000),
            DriverRow(kart_no="12", name="BRAVO", position=2, laps=20, total_time_ms=1_000_500),
        ],
    )
    return event


def test_penalty_time_penalty_reorders_same_lap(client):
    from app.routers.export import _penalty_adjusted_drivers
    event = _seed_two_close()
    pen = event.state.add_penalty("7", "time", seconds=10, reason="Contact")
    adj = _penalty_adjusted_drivers(event.state)
    assert [d.kart_no for d in adj] == ["12", "7"]
    assert adj[0].position == 1 and adj[1].position == 2
    # A served penalty is no longer applied to the result.
    event.state.set_penalty_served(pen.id, True)
    assert [d.kart_no for d in _penalty_adjusted_drivers(event.state)] == ["7", "12"]


def test_penalty_lap_penalty_drops_kart(client):
    from app.routers.export import _penalty_adjusted_drivers
    event = _seed_two_close()
    event.state.add_penalty("7", "lap", laps=1, reason="Cutting")
    adj = _penalty_adjusted_drivers(event.state)
    assert [d.kart_no for d in adj] == ["12", "7"]
    assert adj[1].kart_no == "7" and adj[1].laps == 19


def test_penalty_warning_and_served_excluded_from_summary(client):
    from app.routers.export import _outstanding_penalties
    event = _seed_two_close()
    event.state.add_penalty("7", "warning", reason="Track limits")
    served = event.state.add_penalty("12", "time", seconds=5, reason="Contact")
    event.state.set_penalty_served(served.id, True)
    event.state.add_penalty("7", "time", seconds=10, reason="Contact")
    out = _outstanding_penalties(event.state)
    assert set(out) == {"7"} and out["7"]["seconds"] == 10


def test_timesheet_penalties_param_renders(client):
    event = _seed_two_close()
    # Kart 7 carries two time penalties + a lap penalty → exercises the grouped
    # summary path (one tinted driver row + a detail row per penalty).
    event.state.add_penalty("7", "time", seconds=5, reason="Contact")
    event.state.add_penalty("7", "time", seconds=10, reason="Aggressive driving")
    event.state.add_penalty("7", "lap", laps=1, reason="Jump start")
    event.state.add_penalty("12", "lap", laps=1, reason="Jump start")
    r = client.get("/e/1/api/export/timesheet.pdf?penalties=1")
    assert r.status_code == 200
    assert r.content[:5] == b"%PDF-"
    assert len(r.content) > 1000


def test_penalties_summary_groups_by_kart(client):
    from app.routers.export import _penalties_summary_table, _accent_kit
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    event = _seed_two_close()
    event.state.add_penalty("7", "time", seconds=5, reason="Contact")
    event.state.add_penalty("7", "time", seconds=10, reason="Aggressive driving")
    base = getSampleStyleSheet()
    kit = _accent_kit("#e10600")
    styles = {
        "Cell": ParagraphStyle("Cell", parent=base["Normal"], fontSize=9),
        "SectionHead": base["Heading2"], "Legend": base["Normal"],
        "accent": kit["accent"], "accent_text": kit["text"], "accent_tint": kit["tint"],
    }
    flow = _penalties_summary_table(event.state, styles)
    table = flow[-1]
    rows = table._cellvalues
    # header + 1 summary row + 2 detail rows
    assert len(rows) == 4
    assert rows[1][0] == "7" and rows[1][2] == "+15s"        # summed total
    assert [rows[2][2], rows[3][2]] == ["+5s", "+10s"]        # per-penalty detail
