# WeRace Bridge

Live timing relay and dashboard suite for team endurance races on rental karts.

The FastAPI backend connects to a live timing websocket (**MyWeR** / time2race or
**Apex Timing**), decodes and normalizes the feed, and re-broadcasts it over its
own websockets to five kinds of dashboards served by a Vite + React frontend:

| Dashboard | Route | Access |
|---|---|---|
| **Driver** — fullscreen landscape phone display: position, remaining time, gap ahead/behind, last/best lap, stint time, pit-wall & race-control messages | `/e/{slot}/driver/{token}` | obscurity token / QR |
| **Team Manager** ("pit wall") — full grid, own-kart analysis charts, message your driver, driver QR + link | `/e/{slot}/team/{token}` | obscurity token / QR |
| **General** — public live timing for everyone | `/e/{slot}` | open |
| **Race Control** — pick/connect the timing source, record frames, message all/some/one driver | `/e/{slot}/control` | safeword |
| **Staff** — printable QR sheet with driver + team-manager codes for every kart | `/e/{slot}/staff` | safeword |

There are **3 independent event slots** (`/e/1`, `/e/2`, `/e/3`, configurable via
`WRB_NUM_EVENTS`), so simultaneous races at different tracks can each use their
own set of dashboards — Race Control of each slot picks its own timing source.

> The original ESP32 protocol-exploration project this grew from is kept in
> `src/main.cpp` (PlatformIO); it is not part of the webapp.

## Quick start (production-ish)

```bash
# 1. Frontend build
cd frontend
npm install
npm run build            # outputs frontend/dist, served by the backend

# 2. Backend
cd ../backend
pip install -r requirements.txt
cp .env.example .env     # then EDIT .env (secret + safeword!)
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Open `http://<host>:8000/e/1/control`, enter the safeword, pick a track from the
catalog (or the **Simulator** for a demo race) and press **Connect**. Hand out
dashboards from `http://<host>:8000/e/1/staff`.

Set `WRB_PUBLIC_BASE_URL` to the URL teams will reach the server on — it's what
goes inside the QR codes.

## Deployment (Docker + HTTPS)

Runs on any Linux VPS with Docker. Caddy terminates HTTPS with automatic
Let's Encrypt certificates and proxies everything (websockets included) to the
app container. HTTPS is not just cosmetic: the driver dashboard's screen
wake-lock and the copy-link buttons only work on secure origins.

**1. Point your domain at the VPS** — create a DNS `A` record, e.g.
`timing.example.com → <VPS IP>`. Ports 80 and 443 must be open.

**2. On the VPS:**

```bash
# Install Docker (if needed): https://docs.docker.com/engine/install/
git clone https://github.com/FabioRoss/WeRace-Bridge.git
cd WeRace-Bridge

# Configure — the app refuses default secrets in production!
cp backend/.env.example backend/.env
nano backend/.env
#   WRB_SECRET_SALT=$(openssl rand -hex 24)     <- generate a real one
#   WRB_SAFEWORD=<your race-control password>
#   WRB_PUBLIC_BASE_URL=https://timing.example.com

# Build and start (first run takes a few minutes)
WRB_DOMAIN=timing.example.com docker compose up -d --build
```

Tip: put `WRB_DOMAIN=timing.example.com` in a `.env` file next to
`docker-compose.yml` so plain `docker compose up -d` works from then on.

**3. Check** — `https://timing.example.com/e/1/control`, enter the safeword,
connect the Simulator, open the dashboards.

**Serving several domains (one deploy):** the app can answer on more than one
hostname at once — useful for a second brand or a spelling alias.

1. Add a DNS `A` record for each domain pointing at the same VPS IP
   (e.g. `timing.we-race.it` *and* `timing.werace.it` → `<VPS IP>`).
2. Set `WRB_DOMAIN` to a **comma-separated list** and redeploy — Caddy fetches a
   Let's Encrypt certificate for each and serves them all:
   ```bash
   WRB_DOMAIN="timing.we-race.it, timing.werace.it" docker compose up -d
   ```
   (The backend accepts any host, so no other change is needed to browse both.)
3. **Share links / QR codes** pick one of two behaviours:
   - Keep `WRB_PUBLIC_BASE_URL=https://timing.we-race.it` — every generated link
     and QR uses that one canonical domain, even when opened via the other.
   - Leave `WRB_PUBLIC_BASE_URL` empty — links derive from the domain the visitor
     actually used, so each domain self-references. (Works over HTTPS because the
     container runs uvicorn with `--proxy-headers`, trusting Caddy's forwarded
     scheme/host.)

**Operating it:**

```bash
docker compose logs -f app        # app logs (source connections, decode errors)
git pull && WRB_DOMAIN=... docker compose up -d --build    # update
docker compose down               # stop (recordings + saved backgrounds survive in named volumes)
docker run --rm -v werace-bridge_recordings:/r -v $PWD:/out alpine \
    tar czf /out/recordings-backup.tgz -C /r .             # backup recordings
docker run --rm -v werace-bridge_backgrounds:/b -v $PWD:/out alpine \
    tar czf /out/backgrounds-backup.tgz -C /b .            # backup saved backgrounds
```

Notes:
- The app must run as a **single process** (the Dockerfile already does this):
  live state and websocket clients are in-memory, so `--workers N` would
  split the race state across processes. One process comfortably handles a
  full endurance grid across all three event slots.
- Recordings land in the `recordings` named volume
  (`/app/backend/recordings` inside the container). Optionally-saved story
  backgrounds land in the `backgrounds` named volume
  (`/app/backend/backgrounds`) and likewise survive rebuilds.

## Development

```bash
# terminal 1 — backend with auto-reload
cd backend && uvicorn app.main:app --reload

# terminal 2 — frontend with HMR (proxies /api and /e/*/ws to :8000)
cd frontend && npm run dev
```

Tests: `cd backend && pytest` (protocol decoders, tokens, state derivation, API).

## How the "security by obscurity" links work

`token = HMAC-SHA256(WRB_SECRET_SALT, "{slot}:{role}:{kart_no}")[:16]`

- role is `driver` or `team`, so a driver QR cannot open the pit-wall dashboard;
- slot is included, so kart 7 in event 1 and kart 7 in event 2 get different links;
- tokens are computed on demand — there is nothing to provision. The Staff page
  can pre-generate QR codes for kart numbers before they appear in the feed.

Race Control and Staff are protected by the shared `WRB_SAFEWORD` (sent as an
`X-Safeword` header). Proper login/auth is a planned follow-up.

## Timing sources

- **MyWeR (time2race)** — JSON snapshots; fully decoded (fields cross-checked
  against the ESP32 reference implementation).
- **Apex Timing** — pipe-delimited commands (`grid|…`, `update|rXcY|…`, `dyn1|…`,
  `light|…`) that maintain an HTML timing grid. The decoder mirrors the grid and
  resolves columns from header `data-type` attributes with a multilingual
  label-text fallback. It was written from the documented protocol **without live
  captures** — expect to refine it with real recordings (below).
- **Simulator** — synthetic 2h endurance race (12 karts, pits, yellow flags) for
  demos and end-to-end testing.
- **Replay** — plays back a recorded `.ndjson` file through the matching decoder.

### Recording & replaying real sessions

1. In Race Control, connect to the real track feed, then press **Record** —
   raw frames are appended to `backend/recordings/slotN-<timestamp>-<label>.ndjson`.
2. To replay: Race Control → source picker → *Replay a recording…* → pick the file.
   Replay preserves original frame pacing (long gaps capped at 5 s); a `speed`
   multiplier is supported via the API.

This is the intended loop for hardening the Apex decoder: record a session at
the track, replay it at home, fix, repeat.

## Architecture

```
MyWeR / Apex / Simulator / Replay        (per event slot)
        │  sources/*.py  — connect loop, reconnect w/ backoff, decoder
        ▼
   EventState (state.py) — normalized standings, lap history, stint fallback
        ▼
   Hub (hub.py) ──► /e/{slot}/ws/live            → general / pit wall / RC / staff
               ──► /e/{slot}/ws/driver/{token}   → driver dashboard + messages
```

REST (see `backend/app/routers/`): `/e/{slot}/api/state`, `/e/{slot}/api/laps`,
`/api/qr.png`, safeword-gated `/e/{slot}/api/admin/*` (connect/disconnect/record/
reset/message/links) and token-gated `/e/{slot}/api/team/{token}[/message]`.

State is in-memory by design (a restart just re-syncs from the live feed);
recordings and optionally-saved story backgrounds are the only things
persisted to disk (each in its own named volume).
