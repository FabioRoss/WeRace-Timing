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


def test_is_tls_error():
    assert _is_tls_error(ssl.SSLError("wrong version number"))
    assert _is_tls_error(ConnectionResetError())
    assert not _is_tls_error(ConnectionRefusedError())
    assert not _is_tls_error(ValueError("nope"))
