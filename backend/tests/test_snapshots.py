"""Saved-snapshot store + EventState export/hydrate round-trip."""
import time

import pytest

from app import snapshots
from app.config import get_settings
from app.models import DriverRow, Flag, RaceInfo, SourceStatus
from app.state import EventState


@pytest.fixture
def snap_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "snapshots_dir", tmp_path)
    return tmp_path


def _seed_state() -> EventState:
    st = EventState(1)
    st.update(
        RaceInfo(event_name="Test Cup", track_name="Christel", run_type="E", ended=True),
        [
            DriverRow(kart_no="7", name="A", position=1, laps=20, total_time_ms=1_000_000,
                      best_lap_ms=52000),
            DriverRow(kart_no="12", name="B", position=2, laps=20, total_time_ms=1_000_500,
                      best_lap_ms=51000),
        ],
    )
    for lap in range(1, 6):
        for kart, base in [("7", 52100), ("12", 51200)]:
            row = st.find(kart)
            row.laps = lap
            row.last_lap_ms = base + lap
            st._track_laps(row, time.time())
    st.add_penalty("7", "time", seconds=10, reason="Contact")
    return st


def test_export_hydrate_roundtrip():
    st = _seed_state()
    data = st.export_state(SourceStatus())
    rebuilt = EventState.hydrate(data)
    assert [d.kart_no for d in rebuilt.drivers] == ["7", "12"]
    assert rebuilt.lap_history["7"][-1].lap_no == 5
    assert rebuilt.penalties[0].seconds == 10
    assert rebuilt._penalty_id == st._penalty_id
    assert rebuilt.race.event_name == "Test Cup" and rebuilt.race.ended is True
    # hydrated state still drives the PDF builder
    from app.routers.export import build_timesheet_pdf
    pdf = build_timesheet_pdf(rebuilt, include_penalties=True)
    assert pdf[:5] == b"%PDF-"


def test_save_list_load_delete(snap_dir):
    rec = {"id": snapshots.make_id("Test Cup Final"), "created_at": time.time(),
           "name": "Test Cup Final", "snapshot": {"drivers": []}}
    snapshots.write_record(rec)
    assert (snap_dir / f"{rec['id']}.json").is_file()
    listed = snapshots.list_records()
    assert [r["id"] for r in listed] == [rec["id"]]
    assert snapshots.load_record(rec["id"])["name"] == "Test Cup Final"
    assert snapshots.delete_record(rec["id"]) is True
    assert snapshots.load_record(rec["id"]) is None
    assert snapshots.delete_record(rec["id"]) is False


def test_path_traversal_rejected(snap_dir):
    for bad in ["../secret", "a/b", "..", "foo.json", "x/../y"]:
        with pytest.raises(ValueError):
            snapshots.resolve_path(bad)
    assert snapshots.load_record("../secret") is None


def test_gc_only_removes_expired_unkept(snap_dir):
    now = time.time()
    recs = [
        {"id": "fresh-000001", "created_at": now, "expires_at": now + 1000, "keep": False},
        {"id": "stale-000002", "created_at": now, "expires_at": now - 1000, "keep": False},
        {"id": "kept-0000003", "created_at": now, "expires_at": now - 1000, "keep": True},
        {"id": "noexp-000004", "created_at": now, "expires_at": None, "keep": False},
    ]
    for r in recs:
        r["snapshot"] = {"drivers": []}
        snapshots.write_record(r)
    removed = snapshots.gc_expired(now)
    assert removed == 1
    remaining = {r["id"] for r in snapshots.list_records()}
    assert remaining == {"fresh-000001", "kept-0000003", "noexp-000004"}


def test_auto_save_on_ended_edge(snap_dir):
    import asyncio
    from app.events import Event
    ev = Event(1)
    running = RaceInfo(event_name="Cup", track_name="T", run_type="R", ended=False)
    asyncio.run(ev._on_data(running, [DriverRow(kart_no="7", position=1, laps=5)]))
    assert snapshots.list_records() == []            # not ended yet
    asyncio.run(ev._on_data(running, None))          # still running: no save
    assert snapshots.list_records() == []
    # The ended edge saves exactly one record
    ended = running.model_copy(update={"ended": True})
    asyncio.run(ev._on_data(ended, None))
    recs = snapshots.list_records()
    assert len(recs) == 1 and recs[0]["trigger"] == "auto"
    asyncio.run(ev._on_data(ended, None))            # staying ended: no re-save
    assert len(snapshots.list_records()) == 1


def test_build_record_shape(snap_dir):
    from app.events import Event
    ev = Event(2)
    ev.state = _seed_state()
    rec = ev.build_record("manual")
    assert rec["version"] == snapshots.SNAPSHOT_VERSION
    assert rec["trigger"] == "manual" and rec["keep"] is False and rec["published"] is False
    assert rec["expires_at"] > rec["created_at"]
    assert rec["track"] == "Christel"
    assert rec["snapshot"]["drivers"][0]["kart_no"] == "7"
    assert rec["original_penalties"][0]["seconds"] == 10


def test_meta_and_public_view_strip_private():
    st = _seed_state()
    rec = {
        "id": "x-000001", "name": "n", "track": "Christel", "created_at": 1.0,
        "private_notes": "secret", "public_notes": "hello",
        **st.export_state(SourceStatus()),
    }
    meta = snapshots.meta_of(rec)
    assert meta["driver_count"] == 2
    assert [p["kart_no"] for p in meta["podium"]] == ["7", "12"]
    assert "private_notes" not in meta and "snapshot" not in meta
    pub = snapshots.public_view(rec)
    assert pub["public_notes"] == "hello" and "private_notes" not in pub
    assert pub["snapshot"]["drivers"][0]["kart_no"] == "7"
