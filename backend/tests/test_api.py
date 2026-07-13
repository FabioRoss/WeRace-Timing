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
