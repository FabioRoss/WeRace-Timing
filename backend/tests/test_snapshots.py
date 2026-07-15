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


def test_auto_save_on_finish_flag(snap_dir):
    import asyncio
    from app.events import Event
    from app.models import Flag
    ev = Event(1)
    running = RaceInfo(run_type="R", flag=Flag.GREEN)
    asyncio.run(ev._on_data(running, [DriverRow(kart_no="7", position=1, laps=8)]))
    assert snapshots.list_records() == []
    # Checkered flag (no `ended`) is inferred as the end — saves once.
    finish = running.model_copy(update={"flag": Flag.FINISH})
    asyncio.run(ev._on_data(finish, None))
    assert len(snapshots.list_records()) == 1
    asyncio.run(ev._on_data(finish, None))
    assert len(snapshots.list_records()) == 1


def test_auto_save_on_idle_but_not_empty(snap_dir, monkeypatch):
    from app.config import get_settings
    from app.events import Event
    from app.models import SourceStatus
    monkeypatch.setattr(get_settings(), "autosave_idle_s", 5.0)
    ev = Event(1)

    class _Src:  # stand-in for a connected source
        status = SourceStatus(connected=True)
    ev.source = _Src()

    # A session with no laps is never saved on idle (guards empty/bad data).
    ev.state.update(RaceInfo(run_type="R"), [DriverRow(kart_no="7", position=1, laps=0)])
    ev.state.updated_at = time.time() - 999
    ev._auto_save_if_ended(time.time(), idle=True)
    assert snapshots.list_records() == []

    # Real racing that has gone quiet past the window -> inferred end, one save.
    ev.state.update(RaceInfo(run_type="R"), [DriverRow(kart_no="7", position=1, laps=9)])
    ev.state.updated_at = time.time() - 10
    ev._auto_save_if_ended(time.time(), idle=True)
    assert len(snapshots.list_records()) == 1
    # Fresh data (not idle) does not add a second record for the same session.
    ev.state.updated_at = time.time()
    ev._auto_save_if_ended(time.time(), idle=True)
    assert len(snapshots.list_records()) == 1


def test_rollover_rearms_auto_save(snap_dir):
    import asyncio
    from app.events import Event
    ev = Event(1)
    # Session 1 ends -> one save.
    asyncio.run(ev._on_data(RaceInfo(run_type="R", ended=True),
                            [DriverRow(kart_no="7", position=1, laps=6)]))
    assert len(snapshots.list_records()) == 1
    # A new session (run_type changes) bumps session_generation and re-arms.
    asyncio.run(ev._on_data(RaceInfo(run_type="F"),
                            [DriverRow(kart_no="7", position=1, laps=3)]))
    asyncio.run(ev._on_data(RaceInfo(run_type="F", ended=True), None))
    assert len(snapshots.list_records()) == 2


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


# ------------------------------------------------------ admin snapshot API

from fastapi.testclient import TestClient  # noqa: E402
from app.main import app  # noqa: E402
from app.events import get_manager  # noqa: E402

SAFE = {"X-Safeword": "boxbox"}


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "snapshots_dir", tmp_path)
    with TestClient(app) as c:
        yield c
    for ev in get_manager().events.values():
        ev.reset()


def _save_one(api) -> str:
    ev = get_manager().get(1)
    ev.state = _seed_state()
    return api.post("/e/1/api/admin/snapshots", headers=SAFE).json()["snapshot"]["id"]


def test_admin_snapshot_crud_and_patch(api):
    sid = _save_one(api)
    assert [s["id"] for s in api.get("/api/admin/snapshots", headers=SAFE).json()["snapshots"]] == [sid]
    full = api.get(f"/api/admin/snapshots/{sid}", headers=SAFE).json()
    assert full["snapshot"]["drivers"][0]["kart_no"] == "7"

    # publish -> keep True, expiry cleared
    r = api.patch(f"/api/admin/snapshots/{sid}", headers=SAFE,
                  json={"published": True, "name": "Grand Final", "public_notes": "gg"})
    meta = r.json()["snapshot"]
    assert meta["published"] and meta["keep"] and meta["name"] == "Grand Final"
    assert snapshots.load_record(sid)["expires_at"] is None
    # unkeep -> expiry restored
    api.patch(f"/api/admin/snapshots/{sid}", headers=SAFE, json={"keep": False})
    assert snapshots.load_record(sid)["expires_at"] is not None

    assert api.delete(f"/api/admin/snapshots/{sid}", headers=SAFE).status_code == 200
    assert api.get(f"/api/admin/snapshots/{sid}", headers=SAFE).status_code == 404
    assert api.delete(f"/api/admin/snapshots/{sid}", headers=SAFE).status_code == 404


def test_admin_snapshot_penalty_amend_and_revert(api):
    sid = _save_one(api)   # seeded state already has one +10s penalty (id 1)
    # add a lap penalty
    r = api.post(f"/api/admin/snapshots/{sid}/penalty", headers=SAFE,
                 json={"kart_no": "12", "kind": "lap", "laps": 1, "reason": "Cut"})
    assert r.status_code == 200 and r.json()["penalty"]["id"] == 2
    pens = snapshots.load_record(sid)["snapshot"]["penalties"]
    assert len(pens) == 2
    # serve the first, then remove it
    api.post(f"/api/admin/snapshots/{sid}/penalty/1/served", headers=SAFE, json={"served": True})
    assert snapshots.load_record(sid)["snapshot"]["penalties"][0]["served"] is True
    api.delete(f"/api/admin/snapshots/{sid}/penalty/1", headers=SAFE)
    assert [p["id"] for p in snapshots.load_record(sid)["snapshot"]["penalties"]] == [2]
    assert api.delete(f"/api/admin/snapshots/{sid}/penalty/1", headers=SAFE).status_code == 404
    # revert -> back to the single as-finished penalty
    api.post(f"/api/admin/snapshots/{sid}/penalty/revert", headers=SAFE)
    reverted = snapshots.load_record(sid)["snapshot"]["penalties"]
    assert [p["id"] for p in reverted] == [1] and reverted[0]["seconds"] == 10


def test_admin_snapshot_pdf(api):
    sid = _save_one(api)
    r = api.get(f"/api/admin/snapshots/{sid}/timesheet.pdf?penalties=1", headers=SAFE)
    assert r.status_code == 200 and r.content[:5] == b"%PDF-"
    assert api.get("/api/admin/snapshots/missing/timesheet.pdf", headers=SAFE).status_code == 404
    # safeword required
    assert api.get(f"/api/admin/snapshots/{sid}/timesheet.pdf").status_code == 401


def test_og_meta_and_card(api):
    sid = _save_one(api)
    rec = snapshots.load_record(sid)
    og = snapshots.og_meta(rec)
    assert og["image_path"] == f"/api/results/{sid}/card.png"
    assert og["url_path"] == f"/results/{sid}"
    assert "#7" in og["description"] and og["title"]

    # card is published-only PNG
    assert api.get(f"/api/results/{sid}/card.png").status_code == 404   # not published yet
    api.patch(f"/api/admin/snapshots/{sid}", headers=SAFE, json={"published": True})
    card = api.get(f"/api/results/{sid}/card.png")
    assert card.status_code == 200 and card.content[:8] == b"\x89PNG\r\n\x1a\n"
    assert card.headers["content-type"] == "image/png"


def test_results_html_injects_og_when_published(api):
    from app.main import FRONTEND_DIST
    if not FRONTEND_DIST.is_dir():
        pytest.skip("frontend/dist not built")
    sid = _save_one(api)
    api.patch(f"/api/admin/snapshots/{sid}", headers=SAFE, json={"published": True})
    html = api.get(f"/results/{sid}").text
    assert 'property="og:title"' in html and 'name="twitter:card"' in html
    assert f"/api/results/{sid}/card.png" in html
    # unpublished / unknown -> plain shell (no OG injection)
    api.patch(f"/api/admin/snapshots/{sid}", headers=SAFE, json={"published": False})
    assert 'property="og:title"' not in api.get(f"/results/{sid}").text


def test_public_results_only_published_and_no_private(api):
    sid = _save_one(api)
    # private + public notes set; not yet published
    api.patch(f"/api/admin/snapshots/{sid}", headers=SAFE,
              json={"private_notes": "steward only", "public_notes": "great race"})
    # unpublished: invisible to the public API (no safeword)
    assert api.get("/api/results").json()["results"] == []
    assert api.get(f"/api/results/{sid}").status_code == 404
    assert api.get(f"/api/results/{sid}/timesheet.pdf").status_code == 404

    api.patch(f"/api/admin/snapshots/{sid}", headers=SAFE, json={"published": True})
    listed = api.get("/api/results").json()["results"]
    assert [r["id"] for r in listed] == [sid]
    detail = api.get(f"/api/results/{sid}").json()
    assert detail["public_notes"] == "great race"
    assert "private_notes" not in detail
    # private notes never appear anywhere in the public payload
    assert "steward only" not in api.get(f"/api/results/{sid}").text
    assert detail["snapshot"]["drivers"][0]["kart_no"] == "7"
    assert api.get(f"/api/results/{sid}/timesheet.pdf?penalties=1").content[:5] == b"%PDF-"
