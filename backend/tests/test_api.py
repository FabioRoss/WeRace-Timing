import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models import DriverRow, Flag, RaceInfo
from app.events import get_manager
from app.security import make_token


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c
    # Clean slate between tests
    for event in get_manager().events.values():
        event.reset()


def seed(slot: int = 1):
    event = get_manager().get(slot)
    event.state.update(
        RaceInfo(flag=Flag.GREEN, time_to_go="45:00", event_name="Test Cup"),
        [
            DriverRow(kart_no="7", name="Team A", position=1, laps=10, best_lap_ms=52000),
            DriverRow(kart_no="12", name="Team B", position=2, laps=10, gap_ahead="1.5"),
        ],
    )
    return event


def test_state_endpoint(client):
    seed()
    body = client.get("/e/1/api/state").json()
    assert body["race"]["event_name"] == "Test Cup"
    assert [d["kart_no"] for d in body["drivers"]] == ["7", "12"]


def test_admin_requires_safeword(client):
    assert client.get("/api/admin/tracks").status_code == 401
    assert client.get("/api/admin/tracks", headers={"X-Safeword": "wrong"}).status_code == 401


SAFEWORD = {"X-Safeword": "boxbox"}


def test_recordings_list_and_delete(client, tmp_path, monkeypatch):
    from app.config import get_settings
    settings = get_settings()
    monkeypatch.setattr(settings, "recordings_dir", tmp_path)
    (tmp_path / "slot1-20260101-000000-Test.ndjson").write_text('{"ts":1,"payload":"x"}\n')

    listed = client.get("/api/admin/recordings", headers=SAFEWORD).json()["recordings"]
    assert [r["name"] for r in listed] == ["slot1-20260101-000000-Test.ndjson"]
    assert listed[0]["size_bytes"] > 0 and listed[0]["modified"] > 0

    # path traversal / non-ndjson are rejected without touching the disk
    # (a slash-bearing name never even routes to the handler)
    assert client.delete("/api/admin/recordings/..%2Fsecret.ndjson", headers=SAFEWORD).status_code in (404, 405, 422)
    assert client.delete("/api/admin/recordings/notes.txt", headers=SAFEWORD).status_code == 422
    assert client.delete("/api/admin/recordings/missing.ndjson", headers=SAFEWORD).status_code == 404

    r = client.delete("/api/admin/recordings/slot1-20260101-000000-Test.ndjson", headers=SAFEWORD)
    assert r.status_code == 200 and r.json()["ok"] is True
    assert client.get("/api/admin/recordings", headers=SAFEWORD).json()["recordings"] == []


def test_recording_in_progress_is_not_deletable(client, tmp_path, monkeypatch):
    from app.config import get_settings
    settings = get_settings()
    monkeypatch.setattr(settings, "recordings_dir", tmp_path)
    event = get_manager().get(1)
    event.recorder.directory = tmp_path
    path = event.recorder.start(1, "live")
    try:
        r = client.delete(f"/api/admin/recordings/{path.name}", headers=SAFEWORD)
        assert r.status_code == 409
    finally:
        event.recorder.stop()
    ok = client.get("/api/admin/tracks", headers={"X-Safeword": "boxbox"})
    assert ok.status_code == 200
    assert any(c["kind"] == "simulator" for c in ok.json()["catalog"])


def _png_bytes(w: int = 32, h: int = 32, color=(200, 40, 40)) -> bytes:
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, format="PNG")
    return buf.getvalue()


def test_backgrounds_round_trip(client, tmp_path, monkeypatch):
    from app.config import get_settings
    settings = get_settings()
    monkeypatch.setattr(settings, "backgrounds_dir", tmp_path)

    assert client.get("/api/admin/backgrounds", headers=SAFEWORD).json()["backgrounds"] == []

    # Save an oversized image → it is accepted and downscaled to <= 2000px.
    r = client.post(
        "/api/admin/backgrounds",
        headers=SAFEWORD,
        files={"file": ("shot.png", _png_bytes(3000, 1500), "image/png")},
    )
    assert r.status_code == 200
    saved = r.json()["backgrounds"]
    assert len(saved) == 1
    name = saved[0]["name"]

    # Serve it back and confirm it is a real, bounded image.
    got = client.get(f"/api/admin/backgrounds/{name}", headers=SAFEWORD)
    assert got.status_code == 200 and got.content[:4] in (b"\xff\xd8\xff\xe0", b"\x89PNG")
    import io

    from PIL import Image

    assert max(Image.open(io.BytesIO(got.content)).size) <= 2000

    # Delete → the store empties.
    d = client.delete(f"/api/admin/backgrounds/{name}", headers=SAFEWORD)
    assert d.status_code == 200 and d.json()["backgrounds"] == []


def test_backgrounds_limit_and_validation(client, tmp_path, monkeypatch):
    from app.config import get_settings
    settings = get_settings()
    monkeypatch.setattr(settings, "backgrounds_dir", tmp_path)

    for _ in range(5):
        r = client.post(
            "/api/admin/backgrounds",
            headers=SAFEWORD,
            files={"file": ("s.png", _png_bytes(), "image/png")},
        )
        assert r.status_code == 200
    # The sixth is refused until one is deleted.
    r = client.post(
        "/api/admin/backgrounds",
        headers=SAFEWORD,
        files={"file": ("s.png", _png_bytes(), "image/png")},
    )
    assert r.status_code == 409

    # A non-image body is rejected.
    monkeypatch.setattr(settings, "backgrounds_dir", tmp_path / "empty")
    r = client.post(
        "/api/admin/backgrounds",
        headers=SAFEWORD,
        files={"file": ("evil.png", b"not really an image", "image/png")},
    )
    assert r.status_code == 422

    # Traversal / bad names never resolve to a file outside the dir.
    assert client.delete("/api/admin/backgrounds/..%2Fsecret.png", headers=SAFEWORD).status_code in (404, 405, 422)
    assert client.delete("/api/admin/backgrounds/notes.txt", headers=SAFEWORD).status_code == 422
    assert client.get("/api/admin/backgrounds/missing.png", headers=SAFEWORD).status_code == 404


def test_backgrounds_require_safeword(client):
    assert client.get("/api/admin/backgrounds").status_code == 401


def test_links_and_team_flow(client):
    seed()
    links = client.get("/e/1/api/admin/links", headers={"X-Safeword": "boxbox"}).json()
    entry = next(k for k in links["karts"] if k["kart_no"] == "12")
    assert "/e/1/driver/" in entry["driver_url"]

    info = client.get(f"/e/1/api/team/{entry['team_token']}").json()
    assert info["found"] and info["kart_no"] == "12"
    assert info["driver_token"] == entry["driver_token"]

    # TM message reaches only its own kart's channel; bad token rejected
    r = client.post(f"/e/1/api/team/{entry['team_token']}/message", json={"text": "Box now"})
    assert r.status_code == 200
    r = client.post("/e/1/api/team/deadbeefdeadbeef/message", json={"text": "hack"})
    assert r.status_code == 409


def test_driver_ws_and_rc_message(client):
    seed()
    token = make_token(1, "driver", "7")
    with client.websocket_connect(f"/e/1/ws/driver/{token}") as ws:
        first = ws.receive_json()
        assert first["type"] == "driver"
        assert first["found"] and first["position"] == 1

        client.post(
            "/e/1/api/admin/message",
            headers={"X-Safeword": "boxbox"},
            json={"text": "Yellow flag sector 2", "priority": "warning"},
        )
        msg = ws.receive_json()
        assert msg["type"] == "message"
        assert msg["text"] == "Yellow flag sector 2"
        assert msg["sender"] == "race_control"


def test_targeted_message_skips_other_karts(client):
    seed()
    t7 = make_token(1, "driver", "7")
    t12 = make_token(1, "driver", "12")
    with client.websocket_connect(f"/e/1/ws/driver/{t7}") as ws7, \
         client.websocket_connect(f"/e/1/ws/driver/{t12}") as ws12:
        ws7.receive_json()
        ws12.receive_json()
        client.post(
            "/e/1/api/admin/message",
            headers={"X-Safeword": "boxbox"},
            json={"text": "only for 12", "target": ["12"]},
        )
        assert ws12.receive_json()["text"] == "only for 12"
        # kart 7 gets nothing: sending another broadcast proves ordering
        client.post(
            "/e/1/api/admin/message",
            headers={"X-Safeword": "boxbox"},
            json={"text": "for everyone"},
        )
        assert ws7.receive_json()["text"] == "for everyone"


def test_slot_isolation(client):
    seed(1)
    body2 = client.get("/e/2/api/state").json()
    assert body2["drivers"] == []
    assert client.get("/e/99/api/state").status_code == 404


def test_live_ws_snapshot(client):
    seed()
    with client.websocket_connect("/e/1/ws/live") as ws:
        snap = ws.receive_json()
        assert snap["type"] == "snapshot"
        assert len(snap["drivers"]) == 2


def test_penalty_crud_and_validation(client):
    seed()
    # bad kind / missing amount are rejected
    assert client.post("/e/1/api/admin/penalty", headers=SAFEWORD,
                       json={"kart_no": "7", "kind": "bogus"}).status_code == 422
    assert client.post("/e/1/api/admin/penalty", headers=SAFEWORD,
                       json={"kart_no": "7", "kind": "time", "seconds": 0}).status_code == 422
    assert client.post("/e/1/api/admin/penalty", headers=SAFEWORD,
                       json={"kart_no": "7", "kind": "lap", "laps": 0}).status_code == 422

    r = client.post("/e/1/api/admin/penalty", headers=SAFEWORD,
                    json={"kart_no": "7", "kind": "time", "seconds": 10, "reason": "Contact"})
    assert r.status_code == 200
    pid = r.json()["penalty"]["id"]

    snap = client.get("/e/1/api/state").json()
    assert [p["kart_no"] for p in snap["penalties"]] == ["7"]
    assert snap["penalties"][0]["seconds"] == 10 and snap["penalties"][0]["served"] is False

    # mark served
    assert client.post(f"/e/1/api/admin/penalty/{pid}/served", headers=SAFEWORD,
                       json={"served": True}).status_code == 200
    assert client.get("/e/1/api/state").json()["penalties"][0]["served"] is True

    # delete
    assert client.delete(f"/e/1/api/admin/penalty/{pid}", headers=SAFEWORD).status_code == 200
    assert client.get("/e/1/api/state").json()["penalties"] == []
    # deleting / serving a missing penalty 404s
    assert client.delete(f"/e/1/api/admin/penalty/{pid}", headers=SAFEWORD).status_code == 404
    assert client.post(f"/e/1/api/admin/penalty/{pid}/served", headers=SAFEWORD,
                       json={"served": True}).status_code == 404


def test_penalty_notification_delivered_after_delay(client, monkeypatch):
    from app.config import get_settings
    monkeypatch.setattr(get_settings(), "penalty_notify_delay_s", 0.05)
    seed()
    token = make_token(1, "driver", "7")
    with client.websocket_connect(f"/e/1/ws/driver/{token}") as ws:
        assert ws.receive_json()["type"] == "driver"
        client.post("/e/1/api/admin/penalty", headers=SAFEWORD,
                    json={"kart_no": "7", "kind": "time", "seconds": 10, "reason": "Contact"})
        # After the grace delay the team gets a targeted message frame.
        for _ in range(10):
            frame = ws.receive_json()
            if frame["type"] == "message":
                break
        assert frame["type"] == "message"
        assert "Penalty: +10s" in frame["text"] and "Contact" in frame["text"]
        assert frame["priority"] == "urgent"


def test_manual_snapshot_save(client, tmp_path, monkeypatch):
    from app.config import get_settings
    from app import snapshots
    monkeypatch.setattr(get_settings(), "snapshots_dir", tmp_path)
    # No data yet -> 422
    assert client.post("/e/1/api/admin/snapshots", headers=SAFEWORD).status_code == 422
    seed()
    r = client.post("/e/1/api/admin/snapshots", headers=SAFEWORD)
    assert r.status_code == 200
    meta = r.json()["snapshot"]
    assert meta["trigger"] == "manual" and meta["driver_count"] == 2
    assert snapshots.load_record(meta["id"])["snapshot"]["drivers"][0]["kart_no"] == "7"


def test_snapshot_pdf_config_saved_and_applied(client, tmp_path, monkeypatch):
    from app.config import get_settings
    from app import snapshots
    monkeypatch.setattr(get_settings(), "snapshots_dir", tmp_path)
    seed()
    sid = client.post("/e/1/api/admin/snapshots", headers=SAFEWORD).json()["snapshot"]["id"]

    # Persist a public PDF layout; unknown keys are dropped, values coerced.
    r = client.patch(f"/api/admin/snapshots/{sid}", headers=SAFEWORD,
                     json={"pdf_config": {"grid": False, "charts": True, "bogus": 1},
                           "published": True})
    assert r.status_code == 200
    assert snapshots.load_record(sid)["pdf_config"] == {"grid": False, "charts": True}

    # Public download works with no params (uses the saved layout as default)…
    assert client.get(f"/api/results/{sid}/timesheet.pdf").content[:5] == b"%PDF-"
    # …and an explicit query param still overrides it.
    assert client.get(f"/api/results/{sid}/timesheet.pdf?grid=1").content[:5] == b"%PDF-"


def test_snapshot_laps_endpoints(client, tmp_path, monkeypatch):
    from app.config import get_settings
    monkeypatch.setattr(get_settings(), "snapshots_dir", tmp_path)
    event = seed()
    # Give kart 7 a couple of tracked laps so lap_chart has points.
    import time as _t
    for lap in range(1, 4):
        row = event.state.find("7")
        row.laps = lap
        row.last_lap_ms = 52000 + lap
        event.state._track_laps(row, _t.time())
    sid = client.post("/e/1/api/admin/snapshots", headers=SAFEWORD).json()["snapshot"]["id"]

    # Admin laps (safeword) returns per-kart points.
    r = client.get(f"/api/admin/snapshots/{sid}/laps?karts=7", headers=SAFEWORD)
    assert r.status_code == 200
    assert len(r.json()["laps"]["7"]) == 3

    # Public laps are gated on publication.
    assert client.get(f"/api/results/{sid}/laps").status_code == 404
    client.patch(f"/api/admin/snapshots/{sid}", headers=SAFEWORD, json={"published": True})
    pub = client.get(f"/api/results/{sid}/laps?karts=7")
    assert pub.status_code == 200 and len(pub.json()["laps"]["7"]) == 3


def test_penalty_delete_cancels_pending_notification(client, monkeypatch):
    from app.config import get_settings
    monkeypatch.setattr(get_settings(), "penalty_notify_delay_s", 30.0)
    seed()
    event = get_manager().get(1)
    pid = client.post("/e/1/api/admin/penalty", headers=SAFEWORD,
                      json={"kart_no": "7", "kind": "warning", "reason": "Track limits"}
                      ).json()["penalty"]["id"]
    assert pid in event._pending_notify
    client.delete(f"/e/1/api/admin/penalty/{pid}", headers=SAFEWORD)
    # The pending notification is cancelled and forgotten (team never notified).
    assert pid not in event._pending_notify
