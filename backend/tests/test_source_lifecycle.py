"""Connect/disconnect lifecycle: error reporting and status broadcasting."""

import ssl
import time

import pytest
from fastapi.testclient import TestClient

from app.events import Event, get_manager
from app.main import app
from app.models import SourceConfig
from app.sources.base import _is_tls_error

SAFEWORD = {"X-Safeword": "boxbox"}
DEAD_URL = "ws://127.0.0.1:1/"


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c
    for event in get_manager().events.values():
        event.reset()


async def test_connect_reports_first_attempt_error():
    event = Event(1)
    status = await event.connect_source(
        SourceConfig(kind="mywer", label="Dead", url=DEAD_URL)
    )
    assert status.connected is False
    assert status.error, "a refused connection must surface an error"
    await event.disconnect_source()


def test_connect_loads_track_config_defaults():
    # A catalog entry may pre-set RC defaults; connecting applies them so the
    # slot is ready. Fields left None must not clobber the current values.
    event = Event(1)
    event.state.auto_pitlane = True
    event.state.recompute_positions = False
    event.state.hide_team_penalties = True

    event._apply_config_defaults(SourceConfig(
        kind="mywer", label="Christel", url=DEAD_URL,
        auto_pitlane=False, recompute_positions=True,   # hide_team_penalties=None
    ))
    assert event.state.auto_pitlane is False            # applied
    assert event.state.recompute_positions is True      # applied
    assert event.state.hide_team_penalties is True      # untouched (None)


async def test_disconnect_is_prompt_and_clears_error():
    event = Event(1)
    await event.connect_source(SourceConfig(kind="mywer", label="Dead", url=DEAD_URL))
    t0 = time.monotonic()
    await event.disconnect_source()
    assert time.monotonic() - t0 < 6, "disconnect must not hang"
    assert event.source is None
    status = event.source_status()
    assert status.connected is False
    assert status.error == "", "manual disconnect must not leave a stale error"


def test_connect_endpoint_returns_real_outcome(client):
    r = client.post(
        "/e/1/api/admin/connect",
        headers=SAFEWORD,
        json={"kind": "mywer", "label": "Dead", "url": DEAD_URL},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["source"]["connected"] is False
    assert body["source"]["error"]
    client.post("/e/1/api/admin/disconnect", headers=SAFEWORD)


def test_disconnect_pushes_status_to_dashboards(client):
    r = client.post(
        "/e/1/api/admin/connect",
        headers=SAFEWORD,
        json={"kind": "simulator", "label": "Sim"},
    )
    assert r.json()["source"]["connected"] is True

    with client.websocket_connect("/e/1/ws/live") as ws:
        snap = ws.receive_json()
        assert snap["type"] == "snapshot"
        assert snap["source"]["connected"] is True

        client.post("/e/1/api/admin/disconnect", headers=SAFEWORD)
        for _ in range(20):
            msg = ws.receive_json()
            if msg["type"] == "snapshot" and msg["source"]["connected"] is False:
                break
        else:
            pytest.fail("no snapshot with connected=False after disconnect")


import asyncio
import json


def _write_replay(tmp_path, laps_per_frame, gap=1.0):
    """A tiny MyWeR recording: one kart (7) whose lap count follows the list,
    one frame per second."""
    lines = []
    for i, laps in enumerate(laps_per_frame):
        payload = json.dumps({"data": {"drivers": [
            {"raceno": "7", "position": 1, "laps": laps, "lasttime": "00:00:50.000000"},
        ]}})
        lines.append(json.dumps({"ts": float(i) * gap, "payload": payload, "kind": "mywer"}))
    path = tmp_path / "replaytest.ndjson"
    path.write_text("\n".join(lines) + "\n")
    return path.name


async def test_replay_plays_through_and_reports_progress(tmp_path, monkeypatch):
    from app.config import get_settings
    monkeypatch.setattr(get_settings(), "recordings_dir", tmp_path)
    name = _write_replay(tmp_path, [1, 2, 3, 4, 5, 6])
    event = Event(1)
    await event.connect_source(SourceConfig(kind="replay", file=name, speed=1000))
    try:
        for _ in range(100):
            await asyncio.sleep(0.02)
            if event.source and not event.source.status.connected:
                break
        assert event.state.find("7").laps == 6            # played to the end
        assert event.source.status.replay_count == 6
        assert event.source.status.replay_duration_s == 5.0
    finally:
        await event.disconnect_source()


async def test_replay_seek_jumps_and_rebuilds_state(tmp_path, monkeypatch):
    from app.config import get_settings
    monkeypatch.setattr(get_settings(), "recordings_dir", tmp_path)
    name = _write_replay(tmp_path, [1, 2, 3, 4, 5, 6, 7, 8])
    event = Event(1)
    await event.connect_source(SourceConfig(kind="replay", file=name, speed=1))
    try:
        await asyncio.sleep(0.1)                            # frame 0 played
        assert event.state.find("7").laps == 1             # near the start
        event.source.seek(0.5)                             # jump to the midpoint
        await asyncio.sleep(0.1)                            # rebuild has no sleeps
        # target index 4; state is rebuilt from frames [0..4) -> laps 1..4
        assert event.state.find("7").laps == 4
    finally:
        await event.disconnect_source()


def test_is_tls_error():
    assert _is_tls_error(ssl.SSLError("wrong version number"))
    assert _is_tls_error(ConnectionResetError())
    assert not _is_tls_error(ConnectionRefusedError())
    assert not _is_tls_error(ValueError("nope"))
