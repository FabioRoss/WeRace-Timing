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


def test_pdf_config_sanitize_and_effective():
    # Unknown keys dropped, bools coerced, strings clamped.
    cleaned = snapshots.sanitize_pdf_config(
        {"charts": 1, "grid": 0, "penalties": True, "bogus": "x",
         "accent": "#123456", "event": "E" * 500}
    )
    assert cleaned == {"charts": True, "grid": False, "penalties": True,
                       "accent": "#123456", "event": "E" * 120}
    # effective_pdf_config fills every key from the defaults, saved values win.
    eff = snapshots.effective_pdf_config({"pdf_config": {"grid": False, "pits": True}})
    assert eff["grid"] is False and eff["pits"] is True
    assert eff["penalties"] is True and eff["accent"] == "#e10600"
    assert set(eff) == set(snapshots.PDF_CONFIG_DEFAULTS)
    # A record with no saved config is exactly the defaults.
    assert snapshots.effective_pdf_config({}) == snapshots.PDF_CONFIG_DEFAULTS


def test_team_story_config_sanitize_and_effective():
    # Unknown keys dropped, strings clamped, stats limited to known keys (max 4).
    cleaned = snapshots.sanitize_team_story_config(
        {"title": "T" * 500, "accent": "#39ff14", "bogus": "x",
         "stats": ["best", "laps", "junk", "best", "time", "pits", "gap"]}
    )
    assert cleaned["title"] == "T" * 120 and cleaned["accent"] == "#39ff14"
    assert cleaned["stats"] == ["best", "laps", "time", "pits"]  # deduped, ≤4, known only
    # effective merges over the defaults; saved values win.
    eff = snapshots.effective_team_story_config({"team_story_config": {"label": "Final"}})
    assert eff["label"] == "Final" and eff["accent"] == "#e10600"
    assert eff["stats"] == ["best", "laps", "time"]
    assert set(eff) == set(snapshots.TEAM_STORY_DEFAULTS)
    assert snapshots.effective_team_story_config({}) == snapshots.TEAM_STORY_DEFAULTS


def _src_with_terminal(flags):
    from app.models import SourceStatus

    class _Src:
        status = SourceStatus(connected=True)
        terminal_flags = flags
    return _Src()


def test_mywer_stopped_saves_once_and_rearms_on_warmup(snap_dir):
    import asyncio
    from app.events import Event
    from app.models import Flag
    ev = Event(1)
    ev.source = _src_with_terminal({Flag.FINISH, Flag.STOPPED})

    warmup = RaceInfo(run_type="R", flag=Flag.WARMUP)
    green = RaceInfo(run_type="R", flag=Flag.GREEN)
    stopped = RaceInfo(run_type="R", flag=Flag.STOPPED)

    asyncio.run(ev._on_data(warmup, [DriverRow(kart_no="7", position=1, laps=0)]))
    asyncio.run(ev._on_data(green, [DriverRow(kart_no="7", position=1, laps=8)]))
    assert snapshots.list_records() == []
    # STOPPED is a session end for MyWeR -> one save.
    asyncio.run(ev._on_data(stopped, None))
    assert len(snapshots.list_records()) == 1
    # Staying stopped does not re-save.
    asyncio.run(ev._on_data(stopped, None))
    assert len(snapshots.list_records()) == 1
    # The next session warms up (same generation) -> re-arm; its STOPPED saves.
    asyncio.run(ev._on_data(warmup, [DriverRow(kart_no="7", position=1, laps=0)]))
    asyncio.run(ev._on_data(green, [DriverRow(kart_no="7", position=1, laps=9)]))
    asyncio.run(ev._on_data(stopped, None))
    assert len(snapshots.list_records()) == 2


def test_apex_stopped_is_not_a_session_end(snap_dir):
    import asyncio
    from app.events import Event
    from app.models import Flag
    ev = Event(1)
    ev.source = _src_with_terminal({Flag.FINISH})  # Apex: only FINISH ends
    asyncio.run(ev._on_data(RaceInfo(run_type="R", flag=Flag.GREEN),
                            [DriverRow(kart_no="7", position=1, laps=8)]))
    # A mid-race stop must NOT auto-save for a FINISH-only source.
    asyncio.run(ev._on_data(RaceInfo(run_type="R", flag=Flag.STOPPED), None))
    assert snapshots.list_records() == []
    # But the checkered flag still does.
    asyncio.run(ev._on_data(RaceInfo(run_type="R", flag=Flag.FINISH), None))
    assert len(snapshots.list_records()) == 1


def test_rozzano_capture_autosaves_each_stopped_session(snap_dir):
    """Real MyWeR capture (Rozzano): endrace is always false and the flag never
    reaches FINISH, so nothing saved before STOPPED was treated as a session
    end. Replaying it now yields one snapshot per stopped session, each holding
    real standings."""
    import asyncio
    import json
    from pathlib import Path
    from app.events import Event
    from app.models import Flag
    from app.sources.mywer import MyWerDecoder

    ev = Event(1)
    ev.source = _src_with_terminal({Flag.FINISH, Flag.STOPPED})
    dec = MyWerDecoder()
    fixture = Path(__file__).parent / "fixtures" / "rozzano.ndjson"

    async def run():
        for line in fixture.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            payload = (json.loads(line).get("payload") or "")
            if not payload:
                continue
            try:
                race, drivers = dec.decode(payload)
            except Exception:
                continue
            await ev._on_data(race, drivers)

    asyncio.run(run())
    recs = snapshots.list_records()
    assert len(recs) >= 2                       # multiple stopped sessions saved
    assert all(r["trigger"] == "auto" for r in recs)
    for r in recs:                              # each holds a real, raced field
        drivers = r["snapshot"]["drivers"]
        assert drivers and any(d["laps"] > 0 for d in drivers)


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


def test_snapshot_team_story_config_patch_and_public_view(api):
    sid = _save_one(api)
    # Patch a team-story look; junk keys are dropped, stats capped at 4.
    api.patch(f"/api/admin/snapshots/{sid}", headers=SAFE,
              json={"published": True, "team_story_config": {
                  "accent": "#39ff14", "label": "Final", "junk": 1,
                  "stats": ["best", "laps", "time", "pits", "gap"]}})
    rec = snapshots.load_record(sid)
    assert rec["team_story_config"] == {"accent": "#39ff14", "label": "Final",
                                        "stats": ["best", "laps", "time", "pits"]}
    # The public view exposes the effective (defaults-merged) config.
    pub = api.get(f"/api/results/{sid}").json()
    assert pub["team_story_config"]["accent"] == "#39ff14"
    assert pub["team_story_config"]["footer_text"] == "timing.we-race.it"


def test_public_background_serve(api, tmp_path, monkeypatch):
    from PIL import Image
    bg_dir = tmp_path / "bg"
    bg_dir.mkdir()
    monkeypatch.setattr(get_settings(), "backgrounds_dir", bg_dir)
    Image.new("RGB", (8, 8), "red").save(bg_dir / "bg-abc.jpg")
    r = api.get("/api/backgrounds/bg-abc.jpg")
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    assert api.get("/api/backgrounds/missing.jpg").status_code == 404
    # A non-image extension is rejected before any disk access.
    assert api.get("/api/backgrounds/secrets.txt").status_code == 422


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


def test_admin_snapshot_time_adjustment(api):
    sid = _save_one(api)
    # A neutral, signed time adjustment is stored like any other item and can be
    # reverted away with the penalties.
    r = api.post(f"/api/admin/snapshots/{sid}/penalty", headers=SAFE,
                 json={"kart_no": "12", "kind": "adjust", "seconds": -5, "reason": "Held too long"})
    assert r.status_code == 200
    assert r.json()["penalty"]["kind"] == "adjust" and r.json()["penalty"]["seconds"] == -5
    kinds = [p["kind"] for p in snapshots.load_record(sid)["snapshot"]["penalties"]]
    assert "adjust" in kinds
    # zero adjustment rejected
    bad = api.post(f"/api/admin/snapshots/{sid}/penalty", headers=SAFE,
                   json={"kart_no": "12", "kind": "adjust", "seconds": 0})
    assert bad.status_code == 422
    # the public PDF renders with the adjustment applied
    api.patch(f"/api/admin/snapshots/{sid}", headers=SAFE, json={"published": True})
    pdf = api.get(f"/api/results/{sid}/timesheet.pdf?penalties=1")
    assert pdf.status_code == 200 and pdf.content[:5] == b"%PDF-"


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


_PNG = b"\x89PNG\r\n\x1a\n"


def test_og_cards_brand_event_dashboard(api):
    # Brand card is always available.
    brand = api.get("/api/card.png")
    assert brand.status_code == 200 and brand.content[:8] == _PNG

    # Live dashboard card renders from current state (seed one slot).
    get_manager().get(1).state.update(
        RaceInfo(flag=Flag.GREEN, event_name="Cup", track_name="Christel"),
        [DriverRow(kart_no="7", name="A", position=1, laps=5)],
    )
    dash = api.get("/api/e/1/card.png")
    assert dash.status_code == 200 and dash.content[:8] == _PNG
    assert api.get("/api/e/99/card.png").status_code == 404   # no such slot

    # Event card: published-only, 404 until an event exists.
    sid = _save_one(api)
    assert api.get("/api/events/none-x/card.png").status_code == 404
    api.patch(f"/api/admin/snapshots/{sid}", headers=SAFE, json={"published": True})
    gid = api.post("/api/admin/snapshot-groups/assign", headers=SAFE,
                   json={"snapshot_ids": [sid], "group_name": "Round 1"}).json()["group"]["id"]
    ev = api.get(f"/api/events/{gid}/card.png")
    assert ev.status_code == 200 and ev.content[:8] == _PNG


def test_results_html_injects_og_when_published(api):
    from app.main import FRONTEND_DIST
    if not FRONTEND_DIST.is_dir():
        pytest.skip("frontend/dist not built")
    sid = _save_one(api)
    api.patch(f"/api/admin/snapshots/{sid}", headers=SAFE, json={"published": True})
    html = api.get(f"/results/{sid}").text
    assert 'property="og:title"' in html and 'name="twitter:card"' in html
    assert f"/api/results/{sid}/card.png" in html
    # unpublished -> brand OG fallback (tags present, but not the per-result card)
    api.patch(f"/api/admin/snapshots/{sid}", headers=SAFE, json={"published": False})
    plain = api.get(f"/results/{sid}").text
    assert 'property="og:title"' in plain
    assert f"/api/results/{sid}/card.png" not in plain and "/api/card.png" in plain


def test_og_injected_on_every_public_page(api):
    from app.main import FRONTEND_DIST
    if not FRONTEND_DIST.is_dir():
        pytest.skip("frontend/dist not built")
    # Landing, results index and a dashboard all preview (brand or live meta).
    for path in ("/", "/results", "/e/1"):
        html = api.get(path).text
        assert 'property="og:image"' in html and 'property="og:title"' in html
    # Dashboard route points at the live card; landing at the brand card.
    assert "/api/e/1/card.png" in api.get("/e/1").text
    assert "/api/card.png" in api.get("/").text
    # A published event previews with its event card.
    sid = _save_one(api)
    api.patch(f"/api/admin/snapshots/{sid}", headers=SAFE, json={"published": True})
    gid = api.post("/api/admin/snapshot-groups/assign", headers=SAFE,
                   json={"snapshot_ids": [sid], "group_name": "Round 1"}).json()["group"]["id"]
    html = api.get(f"/events/{gid}").text
    assert f"/api/events/{gid}/card.png" in html and "Round 1" in html


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
