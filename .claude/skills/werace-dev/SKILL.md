---
name: werace-dev
description: WeRace Bridge development guide — architecture map, verified Apex/MyWeR protocol facts, how the decoders/state/dashboards work, test + replay + Playwright verification workflow, and checklists for adding features or new timing providers. Use when working on this repository.
---

# WeRace Bridge — development guide

Live timing relay + dashboard suite for rental-kart endurance racing. FastAPI backend
connects to a venue's timing websocket (Apex Timing or MyWeR/time2race), normalizes the
feed, and re-broadcasts to five React dashboards. Keep this skill updated when the
architecture or protocol knowledge changes.

## Architecture map

```
backend/app/
  sources/base.py      BaseSource + WebSocketSource: task lifecycle, reconnect+backoff,
                       wss→ws TLS fallback, first_attempt event (connect endpoint waits
                       on it), first_frames diagnostic ring buffer
  sources/apex.py      Apex decoder (see protocol below) — ApexGrid mirrors their grid
  sources/mywer.py     MyWeR decoder — stateful MyWerDecoder merges partial race frames
  sources/simulator.py Synthetic demo race
  sources/replay.py    .ndjson playback; supports seek() — rebuilds state from the
                       recording start to the target via on_reset + a fresh decoder
  state.py             EventState: normalized race+drivers, lap history (with pit flags
                       + crossing wall-times), session-best, stint tracking, session-
                       rollover detection, flag_override, progress fallback anchors,
                       driver_view payloads
  events.py            Event (per slot): source lifecycle, Hub broadcast loop (pushes on
                       data changes AND source-status changes), recorder
  hub.py               WebSocket fanout (live + per-driver channels)
  routers/admin.py     RC API: connect/disconnect/status (incl. first_frames +
                       flag_override), recording, reset, message, flag override, links,
                       settings, replay/seek, recordings list + delete (path-safe)
  routers/export.py    Post-session downloads: GET /e/{slot}/api/export/timesheet.pdf
                       (reportlab chrono sheet: classification + lap-by-lap grid +
                       best-lap/pace charts, built from live EventState)
  routers/public.py    state, /api/laps (lap history incl. pit + ts), team token API
  routers/live.py      /ws/live and /ws/driver/{token}
  tracks.py            Track catalog (Apex: wss://live-data.apex-timing.com:PORT/,
                       MyWeR: wss://api-stg.mk.time2race.it/live/N/ranking/) + Cremona
                       page URL for grid bootstrap
  models.py            Pydantic models — DriverRow carries sectors, speed, pit_state,
                       progress anchors (prog_*); RaceInfo carries session_kind and the
                       countdown anchor (togo_ms/togo_ts/counting)

frontend/src/
  pages/               GeneralDashboard, TeamDashboard (pit wall), RaceControl,
                       DriverDashboard (landscape phone), StaffDashboard (QR sheet),
                       ExportPage (post-session PDF + Instagram-story downloads)
  components/PageNav.tsx      Control/Staff/Export link chips (staff pages only; fed to
                       PageHeader's `nav` slot — never on public dashboards)
  components/StoryStudio.tsx  client-side Instagram-story generator (see below)
  lib/story.ts         Canvas 2D renderer for the 1080x1920 story + video-mime picker
  components/TimingTable.tsx  the standings table: progress bars, crossing glow,
                       responsive columns, row click → DriverDetail, embeds TrackRing
                       (ring={false} where a page mounts its own)
  components/TrackRing.tsx    F1-style position ring; relativeTo/pitPlan/selection
                       props power the team-dashboard version
  components/DriverDetail.tsx lap-history modal (pace/consistency/pit stats)
  components/LapCharts.tsx    Recharts lap-time + gap charts (legend click toggles)
  components/OrderToggle.tsx  per-viewer Default/Best-lap ordering (races only)
  lib/lapProgress.ts   useServerNow (clock-skew-corrected ticks) + lapFraction +
                       fmtRemaining (smooth countdown)
  lib/ws.ts            auto-reconnecting JSON websocket
```

## Verified protocol facts (from captures in backend/tests/fixtures/)

### Apex Timing (`cremona.ndjson`, `cremona_practice.ndjson`)

Line format `<target>|<class>|<value>`; newline-separated inside ws frames.
- `rXcY|class|text` cell update. Classes: `tn` normal, `ti` personal best, `tb` session
  best, `ib` info; status col: `sr` crossed, `si` pit in, `so` pit out, `su` pos up.
- `rX|#|n` absolute standings position (verified: globally consistent, no duplicates).
- `rX|*|<lap_ms>|<ref>`, `*i1|<ref>`, `*i2|<ref>` — lap/sector events; refs are the
  PREVIOUS lap's segment durations = expected time to the next timing point. These
  drive the progress bars/ring (prog_* anchors).
- `rX|*in|0` / `*out|0` pit lane entry/exit (we derive pit durations from these).
- `dyn1|count|<ms>` session clock (up = elapsed, down = remaining → countdown anchor).
- Cremona columns (header-less fallback DEFAULT_COLUMNS): c3 pos, c4 kart, c5 name,
  c6-8 S1-3, c9 last, c10 best, c11 gap, c13 laps. A speed trap can occupy c13 —
  decimal values auto-demote it to `speed` and laps remap to c14/c12.
- Mid-session joins get NO grid frame → kart numbers fall back to row ids. Mitigations:
  page-HTML grid bootstrap (SourceConfig.page) and the first_frames diagnostic
  (`GET /e/{slot}/api/admin/status`). Whether a live connect sends `grid|` is STILL
  UNVERIFIED — check first_frames at the next live session.
- Sessions ranked by best lap (practice/quali) show zero best-lap inversions in
  positioned order — that's the session_kind heuristic.
- Grid/page HTML can contain the timing table MORE THAN ONCE (desktop + mobile
  copies) — `_GridHTMLParser` must dedupe row ids or every kart duplicates.

### MyWeR / time2race (`rozzano.ndjson`)

JSON snapshots `{"data": {"race": {...}, "drivers": [...]}}`.
- Most frames are PARTIAL (race fields null); metadata (runtype, duralaps, duratime,
  names) arrives rarely → MyWerDecoder merges fields across frames.
- Lap-limited sessions: `duralaps>0`, `duratime` zero, `lapstogo` counts down,
  `timetogo` is garbage (23:xx wrap). Treated as races; remaining shown as "N laps".
- Time-limited: `duratime>0`; `timetogo` valid until it wraps past zero → clamp.
- `runtype`: race set {R,G,F,E} (E = endurance) → session_kind "race"; timed set
  {Q,P,W} → "timed"; anything else "unknown" (disables order toggle + lapped coloring).
  Christel runs by-laps races the software can only express as timed, so an operator
  program keeps resetting `timetogo` — expect runtype E, duralaps 0, a tiny duratime
  and a `timetogo` that never truly counts down.
- **Partial refresh frames (the lap-138 reset bug)**: MyWeR periodically emits a
  full-metadata frame (`runname/runtype/duralaps` present) carrying only a STALE SUBSET
  of the field — a couple of karts whose lap counts lag the live count by one. It must
  neither reset history nor replace standings. `EventState._is_partial_refresh` drops any
  driver frame covering < half the tracked field; the hardened rollover check ignores it
  too. Do NOT relax either without a fixture proving a real session change still resets.
- Driver fields: raceno=kart, fullname, besttime/bestinlap, gap/difference,
  lastpittime/totpittime/sincepit, `pit` (in-pit flag), `interm[0].t1..t3` sectors,
  `end` finished. Flags: G/Y/R/F/C/W/S.
- Feed updates the clock every ~20s → the frontend ticks it locally from the
  RaceInfo countdown anchor (togo_ms/togo_ts/counting) and re-syncs per snapshot.
- **The drivers array is per DRIVER, not per kart** (own id + `drv` index): team
  sessions repeat the same raceno once per registered driver. MyWerDecoder collapses
  to one row per kart (positioned > laps > newest time); EventState also drops any
  duplicate kart_no as a safety net.

## Key mechanisms

- **Progress anchors**: DriverRow.prog_ts/prog_from/prog_to/prog_ms — "at server time
  ts the kart was at lap fraction FROM, expected at TO after MS". Apex sets them per
  sector event; EventState sets a 0→1 fallback at each recorded crossing for other
  sources. Frontend interpolates (lib/lapProgress.ts) for bars + ring; clock skew is
  corrected via snapshot.updated_at.
- **Crossing glow**: state-driven `.lap-glow` class for 1.5s, keyed on new lap anchors
  (prog_from === 0 + fresh prog_ts), NOT on the laps counter (speed traps corrupt it).
- **Ordering**: server positions (rX|# / position column) are authoritative; karts
  without one sort after by best lap. `OrderToggle` re-sorts client-side by best lap
  (races only). `EventState.update` re-sorts by DriverRow.position — emit meaningful
  positions from decoders.
- **Session rollover**: EventState resets lap history/session best when run_type changes
  or a genuine restart is seen. The restart test (`_laps_regressed`) is deliberately
  strict — a quorum of the tracked field must be present AND fallen back to the startline
  (few laps), not a small backward jitter on a subset. This immunity is what stops
  MyWeR's stale partial-refresh frames (see above) from wiping mid-race history.
- **Flag override**: EventState.flag_override (set via POST /api/admin/flag) replaces
  race.flag in snapshots/driver views; None mirrors the feed. RC has the button row.
- **Pit-rejoin marker** (team ring): the driver rejoins at the pit EXIT (by the
  start/finish line) while the field keeps lapping, so the marker sits at
  (ownFraction − pitTime/pace) mod 1 — the karts near it NOW are the traffic at
  pit exit. It moves backward as the stop lengthens; never model a stop as
  "driving forward for T seconds".
- **session_kind** gates the order toggle and ring "lapped" coloring:
  race | timed | unknown, from titles/runtype/duralaps or the inversion heuristic.
- **RC config (per event, survive reconnect/reset)**: `recompute_positions` rebuilds
  order from laps + total time (uploaders that never reorder — christel), `auto_pitlane`
  off infers pits/stint from lap times (venues with no pit-lane gates). Recommended for
  christel/MyWeR by-laps races: recompute ON, auto pit lane OFF.
- **Post-session exports (Export page, `/e/{slot}/export`, safeword-gated)**: two
  deliverables built from *live* EventState (no server-side archive — generate before
  disconnecting/resetting the source; the page banners this while `race.ended` is false).
  - **PDF chrono timesheet** — server-side, `routers/export.py` + `reportlab` (in BOTH
    `requirements.txt` — Docker installs from that — and `pyproject.toml`; guarded by
    `_REPORTLAB_OK` so a missing dep 503s the endpoint instead of crashing startup; Pillow
    present via qrcode). **Light, print-friendly, portrait A4**: a `HeaderBand` Flowable
    (dark rounded panel, red spine, checker), a card-style classification (dark position
    badge, red-tinted leader row, overall fastest lap red — **no On/Pits columns**), and a
    lap-by-lap grid from `lap_chart()` (fastest lap per kart red-bold; **pit laps = bold
    text on a bright amber cell background**, legend line). One shared `CONTENT_W` (186mm)
    sizes the header band, classification, charts and grid so all blocks align to the same
    edges. The grid always renders a fixed `MAX_GRID_KARTS` (10) columns, **padding empty
    columns** when there are fewer karts so widths stay constant. Endpoint query params
    `charts` (default **off**) and `grid` (default on) gate the two `reportlab.graphics`
    charts and the grid. Public GET; `Content-Disposition` attachment. Base-14 fonts only
    render Latin-1 — avoid fancy Unicode glyphs (a ᴾ superscript rendered as tofu).
  - **Instagram story** — 100% client-side, no new deps, no server round-trip.
    `lib/story.ts:drawStory` paints a 1080x1920 red/black/white standings card (brand
    palette from index.css) inside IG safe areas (`SAFE_TOP` 250 / `SAFE_BOTTOM` 1660).
    Header lays out **dynamically** (`layoutTitle` auto-shrinks the title to ≤2 lines, then
    subtitle + list flow from the real header bottom) so long session names don't overlap;
    a **title override** input defaults to the event name. `buildStoryModel(snapshot,
    {perPage, pageIndex, title})` **paginates the whole grid** (`storyPageCount`; a red
    "POS 11–20" chip labels each page; leader style keyed on `pos===1`; fastest-lap footer
    repeats per page). A `stat` option (`StoryStat` best|gap|interval) chooses the per-kart
    right-column value (best_lap_ms / gap_leader / gap_ahead) shown as a big value + small
    caption. Same draw fn feeds the live preview, the PNG (`canvas.toBlob`,
    per-page or download-all) and the video. Video = `captureStream(30)` → `MediaRecorder`
    over an `animatePage` rAF loop, either the current page or **one combined clip cycling
    all pages**; codec via `pickVideoMime()` prefers `video/mp4;codecs=h264` (iOS Safari +
    recent Chromium) then WebM, disabled where MediaRecorder is unavailable. A user
    background is composited via `createImageBitmap` and **never uploaded/stored** — keep
    it that way.

## Development workflow

- Backend tests: `cd backend && pip install -e ".[dev]" && python -m pytest`
  (pytest-asyncio auto mode). Fixtures replay real captures — extend
  `tests/test_apex.py` / `test_mywer.py` patterns (`replay_fixture`).
- Frontend: `cd frontend && npm run build` (tsc + vite) and `npx oxlint src`.
- **End-to-end replay**: copy a fixture into `backend/recordings/`, run
  `uvicorn app.main:app`, open `/e/1/control` (safeword default: `boxbox`), pick
  "Replay a recording…" (POST the connect API with `"speed": 10` to fast-forward).
- **Browser verification**: Playwright + the preinstalled Chromium
  (`executablePath: '/opt/pw-browsers/chromium'`); put throwaway scripts in
  `frontend/node_modules/` (gitignored) so ESM resolves the local playwright package.
  Use `getByRole(..., exact: true)` — ":has-text('Connect')" also matches Disconnect.
- **Capturing new protocol data**: connect at the venue, press Record in RC (or check
  `first_frames` in the admin status for the connect-time init sequence); recordings
  land in `backend/recordings/*.ndjson` — commit interesting ones as fixtures.
- Git: work on a `claude/...` branch, commit + push with `git push -u origin <branch>`.

## Adding things

- **New timing provider**: subclass `WebSocketSource` in `backend/app/sources/`,
  implement `handle_frame` → call `self.on_data(RaceInfo|None, [DriverRow]|None)`;
  register in `SOURCE_CLASSES` (events.py) and the catalog (tracks.py). Fill
  DriverRow.position (or leave 0 for best-lap fallback), laps, times; set
  RaceInfo.session_kind and the countdown anchor if the feed provides them. Record a
  session early and commit it as a fixture with replay tests.
- **New dashboard widget**: snapshot fields flow from models.py → types.ts; the live
  websocket pushes ≤1/s on changes. Use useServerNow for anything time-interpolated.
- **New DriverRow/RaceInfo field**: models.py + decoder(s) + types.ts + (if driver
  dashboard needs it) state.driver_view.

## Deployment

Docker + Caddy (HTTPS via Let's Encrypt) per README/docker-compose.yml. Set
`WRB_PUBLIC_BASE_URL` (QR links), `WRB_SAFEWORD`, `WRB_SECRET`. The backend serves the
built frontend from `frontend/dist`. HTTPS matters: driver dashboards use the screen
wake-lock API which requires a secure context.
