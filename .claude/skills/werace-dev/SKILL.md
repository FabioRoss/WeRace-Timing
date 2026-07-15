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
                       settings, replay/seek, recordings + story-backgrounds
                       CRUD (path-safe, safeword-guarded)
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
- **Pit-lap flags**: `_track_laps` sets `LapRecord.pit` live (feed pits/in_pit, plus the
  long-lap heuristic when `auto_pitlane` off — but only once a clean baseline exists, so
  early laps or laps after a reset can be missed). `lap_chart()` therefore ALSO recomputes
  pit laps statelessly via `infer_pit_laps` (a lap > max(median*1.6, median+20s) of the
  kart's own times), OR-ed with the stored flag. Both the team-dashboard lap charts and the
  PDF read `lap_chart()`, so pit markers are always complete regardless of the setting.
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
- **Penalties & warnings** (`Penalty` model): stateful RC decisions, so — unlike
  messages — they live on `EventState.penalties` (in-memory; the list + `_penalty_id`
  are the **single persistence seam**, commented for a later disk-backed impl) and ride
  in every **snapshot** + each kart's `driver_view`. Cleared on a genuine session
  rollover. Three kinds: `time` (+seconds, served in the pit → then NOT applied to the
  result), `lap` (−laps, results-only, applied while present), `warning` (no result
  effect). Admin CRUD in `admin.py` (safeword): `POST /api/admin/penalty`,
  `POST …/{id}/served`, `DELETE …/{id}` — each mutates + `broadcast_now()`. Assigning
  schedules a **delayed team notification** (`Event.schedule_penalty_notify` →
  `asyncio` task sleeping `Settings.penalty_notify_delay_s` ≈12s, then `send_message`
  targeted to the kart + driver banner); **deleting before it fires cancels it**
  (`_pending_notify[id]`, cleared on reset). "Amend" = delete + re-add (no edit
  endpoint — the delay is the grace window). Frontend: `lib/penalties.ts` (labels/
  presets) + shared `components/PenaltyLog.tsx` (read-only everywhere; RC passes
  `onServe`/`onRemove` for actions). RC has an assign panel + a **"to serve in pit"**
  list (unserved TIME penalties, in-pit karts pulled to top + red-outlined) + full log;
  `TimingTable` shows a **PEN** badge for karts with an outstanding result-affecting
  penalty. Team/Driver/**public General** dashboards all show the log. **PDF**
  (`?penalties=1`): `_penalty_adjusted_drivers` recomputes page-1 classification with
  UNSERVED penalties applied (time→+total_time, lap→−laps), re-sorted `(-laps,total)`
  with fresh pos/gap/interval (reuses `_classify_gap`), titled "penalties applied", plus
  a `_penalties_summary_table` (served + warnings excluded; final-result disclaimer).
- **Pit-rejoin marker** (team ring): the driver rejoins at the pit EXIT (by the
  start/finish line) while the field keeps lapping, so the marker sits at
  (ownFraction − pitTime/pace) mod 1 — the karts near it NOW are the traffic at
  pit exit. It moves backward as the stop lengthens; never model a stop as
  "driving forward for T seconds".
- **session_kind** gates the order toggle and ring "lapped" coloring:
  race | timed | unknown, from titles/runtype/duralaps or the inversion heuristic.
- **RC config (per event, survive reconnect/reset)**: `recompute_positions` rebuilds
  order from laps + total time (uploaders that never reorder — christel), `auto_pitlane`
  off infers pits/stint from lap times (venues with no pit-lane gates), `hide_team_penalties`
  drops the team dashboard's two penalty panels (race control still sees everything — e.g.
  hold penalties from teams until official). All three are `EventState` flags preserved
  across reset, surfaced on `EventSnapshot`, set via `POST /e/{slot}/api/admin/settings`,
  reported by the status endpoint, toggled in the RC config tab. Recommended for
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
    lap-by-lap grid from `lap_chart()` (fastest lap per kart = **accent-filled cell with
    contrast text** (`accent`/`accent_text` by luminance, like the classification header);
    **pit laps = white bold text on the dark header colour**; legend line). One shared
    `CONTENT_W` (186mm)
    sizes the header band, classification, charts and grid so all blocks align to the same
    edges. The grid always renders a fixed `MAX_GRID_KARTS` (10) columns, **padding empty
    columns** when there are fewer karts so widths stay constant. Endpoint query params
    `charts` (default **off**) and `grid` (default on) gate the two `reportlab.graphics`
    charts and the grid; `accent` (validated hex, default red) recolours the whole sheet
    via `_accent_kit` (luminance-picked text on the accent, a light tint for the leader row,
    a darkened variant for coloured text on white) so light accents stay legible. The
    classification carries an **Interval** column (time to the car directly ahead from
    cumulative times → real gap between same-lap karts, incl. both lapped, not just +N L).
    `pits`/`stints` add an optional **per-kart section** (one heading
    per kart with its pit-stops and stint mini-tables side by side, via `KeepTogether`).
    Pit stops = pit # + lap (measured `Stop` on gate venues from `state.pit_stops`, else
    inferred pit laps with an optional `pitest` estimate = pit-lap − median, disclaimed);
    stints = a run of non-pit laps, duration = Σ its lap times (pit laps excluded) + lap
    count + disclaimer (uses lap times not the replay-compressed `ts`). Disclaimers render
    once at the top of the section. `event`/`session`
    override the names on the sheet + the download filename (`{event}-{session}-{date}.pdf`,
    slugified). Pages 2+ carry a slim
    running header (event · session / track) and every page gets a "Page N of M" footer via
    a `NumberedCanvas` two-pass canvasmaker + an `onLaterPages` callback. Public GET;
    `Content-Disposition` attachment; **`Cache-Control: no-store`** (the PDF is rebuilt from
    live state per request, and the frontend adds a `t=` cache-bust, so re-downloads across
    replays never return a stale copy). Base-14 fonts only render Latin-1 — avoid fancy
    Unicode glyphs (a ᴾ superscript rendered as tofu).
  - **Instagram story** — 100% client-side, no new deps, no server round-trip.
    `lib/story.ts:drawStory` paints a 1080x1920 red/black/white standings card (brand
    palette from index.css) inside IG safe areas (`SAFE_TOP` 250 / `SAFE_BOTTOM` 1660).
    Header lays out **dynamically** (`layoutTitle` auto-shrinks the title to ≤2 lines, then
    subtitle + list flow from the real header bottom) so long session names don't overlap;
    a **title** input is **prefilled** (editable) once from the live event name via a
    `useRef` seeded flag (same pattern seeds the PDF panel's Event/Session inputs from
    `event_name`/`run_type`). `buildStoryModel(snapshot,
    {perPage, pageIndex, title})` **paginates the whole grid** (`storyPageCount`; a red
    "POS 11–20" chip labels each page; leader style keyed on `pos===1`). A `stat` option
    (`StoryStat` best|gap|interval|pits, **UI default interval**) chooses the per-kart
    right-column value (best_lap_ms / gap_leader / gap_ahead / `DriverRow.pits`) shown as a
    big value + small caption. `pits` shows the pit-stop count on **all** rows incl. the
    leader, reading `DriverRow.pits` — which `state.py:_track_laps` already makes correct in
    both modes: the feed count on gate venues (`auto_pitlane` ON) and the **inferred** count
    (`_auto_pits`, from long-lap detection) on no-gate venues (`auto_pitlane` OFF). So the
    story shows real pit stops on MyWeR endurance too, as long as auto_pitlane is off. A
    `label` option sets the kicker above the title (session-type selector: Free
    Practice/Qualifying/Race/Custom, **default Race**; fitted so a long custom label never
    overlaps the page chip). `showFastest` toggles the fastest-lap footer — when off,
    `buildStoryModel` clears `fastestKart`/`fastestLap`, which both drops the band and lets
    the standings reclaim its space (layout already gates on `model.fastestLap`). Same draw fn
    feeds the live preview, the PNG (`canvas.toBlob`,
    per-page or download-all) and the video. Video = `captureStream(30)` → `MediaRecorder`
    over an `animatePage` rAF loop, either the current page or **one combined clip cycling
    all pages**; codec via `pickVideoMime()` prefers `video/mp4;codecs=h264` (iOS Safari +
    recent Chromium) then WebM, disabled where MediaRecorder is unavailable. A user
    background is composited via `createImageBitmap` and **stays client-only by default —
    never uploaded** unless the operator explicitly opts to save it (see below). `drawStory`
    takes an `accent` hex (luminance-derived text colour, so light accents stay legible);
    both exporters share `components/AccentPicker.tsx` (6 presets + a native colour input).
  - **Background framing** — `drawStory(…, bgTransform={scale,x,y,rot})` frames the photo
    Canva-style: base cover-fit × `scale`, panned by `x`/`y` (canvas px), rotated `rot`°;
    the default `DEFAULT_BG_TRANSFORM` reproduces the old plain cover-fit. StoryStudio pans
    on canvas drag, zooms on wheel, plus Zoom/Rotate sliders + Reset (shown only with a bg);
    threaded through preview / PNG / all-pages / video renders. Every mutation routes through
    an `applyTransform` setter that **snaps** (zoom→1× within 0.05, rotate→0° within 4°; a
    `<datalist>` tick marks each default) then **clamps** via pure `clampBgTransform(bw,bh,W,H,t)`
    so the image always fully covers the frame — **no empty corners**. The clamp auto-raises
    zoom to the min the rotation needs (auto-zoom-to-fill; ==1 at rot 0) then bounds the pan on
    the rotated axes. It's framework-free/unit-testable (verify by asserting all 4 canvas
    corners project inside the image rect over an aspect/rot/pan/zoom sweep; bundle the module
    with `node_modules/.bin/rolldown src/lib/story.ts --format esm` to import it in Node).
  - **Optional saved backgrounds** (opt-in, privacy-preserving) — safeword-guarded CRUD in
    `admin.py` mirroring recordings: `GET/POST/DELETE /api/admin/backgrounds` (+`{name}`
    serve). POST is **multipart `UploadFile`** (needs **`python-multipart`** — in BOTH
    `requirements.txt` and `pyproject.toml`, the reportlab-502 lesson), Pillow-validated,
    downscaled ≤2000px + re-encoded, **max 5** (6th → 409), non-image → 422, path-safe
    `_resolve_background`. `Settings.backgrounds_dir` (gitignored) → `/app/backend/backgrounds`,
    persisted across `docker compose up -d --build` via the **`backgrounds` named volume** in
    `docker-compose.yml` (mirrors `recordings`; without it a rebuild wipes saved backgrounds).
    StoryStudio shows a
    thumbnail strip (served via `?safeword=`), click loads (server-sourced → no re-save
    prompt), × deletes **behind a `window.confirm`** (matches `RaceControl.tsx` recording
    deletes); after a download of a **fresh** upload an inline "Save this background?" prompt
    POSTs the kept `File`.

## Saved snapshots (results archive)

Persistent results archive so a finished session survives reboots + docker rebuilds and can be
re-exported / published later. **Store**: `backend/app/snapshots.py` — one JSON record per
snapshot in `Settings.snapshots_dir` (`snapshots/{slug}-{hash6}.json`), a **named docker volume**
(`docker-compose.yml`, mirrors recordings/backgrounds), path-safe ids (`resolve_path`), **atomic
writes** (temp + `os.replace`), `list/load/write/delete_record`, `gc_expired`, and `meta_of` /
`public_view` projections (podium = top-3, private notes stripped for public). A record =
`{version, id, slot, created_at, expires_at|None, keep, published, trigger, name, track, tags[],
private_notes, public_notes, snapshot:{<EventSnapshot>}, lap_history, pit_stops, messages,
penalty_seq, original_penalties}`.

- **What's persisted / why**: the `snapshot` block is exactly the frontend `Snapshot` (feeds
  TimingTable/StoryStudio/PenaltyLog unchanged); `lap_history`+`pit_stops` are the only extra
  collections the PDF needs but the live snapshot omits. `EventState.export_state(source)` builds
  the record payload; `EventState.hydrate(dict)` rebuilds a static state that drives
  `build_timesheet_pdf` unchanged (the eight `_`-tracking dicts are live-frame scratch — dropped).
- **Triggers / end inference**: `Event._auto_save_if_ended(now, idle=…)` saves **once per session**.
  Most feeds never set `race.ended`, so end is inferred from `race.ended` OR any of the source's
  **`terminal_flags`** OR the feed going quiet — `now - state.updated_at > autosave_idle_s` (150 s),
  checked every tick in `_broadcast_loop` (`idle=True`). `BaseSource.terminal_flags = {FINISH}`;
  **`MyWerSource` adds `STOPPED`** because MyWeR never sets `endrace` and its flag never reaches
  FINISH — Rozzano sessions run W→G→S and the feed streams continuously, so before this neither the
  checkered nor the idle path ever fired (0 auto-saves on a real capture; now one per stopped
  session). `ReplaySource` inherits the replayed protocol's set. Guards: `_auto_saved` (one
  save/session, set by any save incl. manual) re-armed on rollover (`session_generation` bump) **and
  on the edge into `WARMUP`** in `_on_data` (MyWeR runs back-to-back sessions in one generation:
  …S then W), plus `_worth_saving()` (drivers with `laps>0`). Apex's STOPPED is NOT terminal (its
  stop can be mid-race; it sets `ended`/FINISH explicitly). The idle path intentionally does **not**
  require a connected source (a replay hits EOF / a live feed can drop at the finish). Manual
  `POST /e/{slot}/api/admin/snapshots` also saves + arms. **No supersede** (deferred): every save is
  a new record. `Event.build_record(trigger)` folds in messages + defaults (name = `event — session
  — date`, `track = race.track_name`) and seeds `pdf_config={}` + `group_id=None`/`group_name=""`.
- **TTL**: `main.py` lifespan runs a startup sweep + a periodic `asyncio` GC loop deleting records
  past `expires_at` unless `keep`. `snapshot_ttl_days` (30) / `snapshot_gc_interval_s` (6h).
  **Publishing sets keep=true** (public links must not expire); unkeep recomputes expiry.
- **Saved public PDF layout**: a record carries `pdf_config` (the TimesheetPanel toggles:
  charts/grid/pits/stints/pitest/penalties + event/session/accent). `snapshots.sanitize_pdf_config`
  keeps only known keys; `effective_pdf_config` merges it over `PDF_CONFIG_DEFAULTS` (grid+penalties
  on). The public `timesheet.pdf` applies it as the **default**, explicit query params still override
  (so `ResultsDetail` downloads with no params). The editor's PDF tab has a **"Save as public
  default"** button (`TimesheetPanel` `initialConfig`+`onSaveConfig` → PATCH `pdf_config`).
- **Events (snapshot groups)**: a record carries `group_id`/`group_name`; an event bundles the
  snapshots sharing a `group_id`, **on one track**. `snapshots.list_groups(published_only)` derives
  events (sessions oldest-first, events newest-first). Public opens an event → its sessions as tabs.
- **Surfacing lap data**: snapshots already store the full `lap_history`; the `laps` endpoints expose
  it. Frontend factors `components/SessionResult.tsx` (the public body: notes + classification **with
  no track ring** + penalties + `SnapshotLapCharts` + PDF) reused by `ResultsDetail` and every
  `EventDetail` tab; `components/SnapshotLapCharts.tsx` picks karts and draws the lap-time trend
  from `{base}/laps` (reuses `LapCharts.LapTimeChart`).
- **Admin API** (safeword, `admin.py`): `GET/PATCH/DELETE /api/admin/snapshots[/{id}]`
  (name/track/tags/notes/keep/published/**pdf_config**), penalty amend on a stored record
  (`.../{id}/penalty[...]` add/serve/remove/`revert` to `original_penalties`; validation shared
  with the live path via `_penalty_fields`), `GET .../{id}/laps` + `GET .../{id}/timesheet.pdf`
  (hydrate → `snapshot_pdf_response`; safeword via `?safeword=`), and events:
  `GET /api/admin/snapshot-groups` + `POST /api/admin/snapshot-groups/assign`
  (`{snapshot_ids, group_id?|group_name?}` → group/regroup; empty → ungroup; **cross-track rejected**).
- **Public API** (ungated, `routers/results.py`): `GET /api/results` (published list, machine-
  readable w/ track/tags/podium — the future-integration seam), `GET /api/results/{id}` (public
  view, **private notes stripped, 404 if unpublished**), `GET /api/results/{id}/laps`,
  `GET /api/results/{id}/timesheet.pdf`, `GET /api/events` (`{events:[…], loose:[…]}` — published
  events + ungrouped published sessions), `GET /api/events/{id}` (an event's sessions as full public
  views for the tabs; 404 if none published).
- **Frontend**: `lib/useSnapshot.ts` (`useSnapshotRecord` — static `Snapshot` fetch, a drop-in for
  `useLive`'s snapshot; exports `SnapshotMeta`/`EventGroup`). Reuse seams: `components/TimesheetPanel.tsx`
  (lifted from ExportPage, `pdfBase` + optional `safeword`/`initialConfig`/`onSaveConfig` props) and
  `components/PenaltyEditor.tsx` (`apiBase` + `onChanged` + `canRevert`; RaceControl consumes it).
  Pages: gated `/admin/snapshots` (SnapshotManager: list, podium, track filter, keep/publish toggles,
  delete-confirm, **row checkboxes + "Group into event" bar + event badge**) + `/admin/snapshots/:id`
  (SnapshotEditor: notes, **EventPicker**, PenaltyEditor, lap charts, PDF via TimesheetPanel,
  StoryStudio); public `/results` (event cards → `/events/:id` + loose session cards → `/results/:id`),
  `/results/:id` + `/events/:id` (SessionResult / tabbed SessionResults).
  `PageNav` gains a Snapshots chip; `Landing` a Results link.
- **Link previews (Open Graph)**: the SPA can't set per-page meta (crawlers don't run JS), so the
  `main.py` SPA fallback string-injects a per-result `<title>` + `og:*`/`twitter:` tags into
  `index.html` for **published** `results/{id}` paths only (else the plain shell). `snapshots.og_meta`
  builds title/description(podium+track)/image+url paths, feeding both the injection and a Pillow
  1200×630 card at `GET /api/results/{id}/card.png` (published only; `_load_font` uses DejaVu, added
  to the Docker image via `fonts-dejavu-core`). `ResultsDetail` also sets `document.title`.

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
