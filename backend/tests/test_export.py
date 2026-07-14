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


def test_timesheet_pdf_503_when_reportlab_missing(client, monkeypatch):
    # If reportlab is ever absent from the image the endpoint must 503, not
    # crash the app (the app still imports because the dep is guarded).
    from app.routers import export
    monkeypatch.setattr(export, "_REPORTLAB_OK", False)
    r = client.get("/e/1/api/export/timesheet.pdf")
    assert r.status_code == 503
