import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../lib/api'
import { useLive } from '../lib/useLive'
import { FlagBanner } from '../components/FlagBanner'
import { TimingTable } from '../components/TimingTable'
import { ConnectionDot, PageHeader } from '../components/StatusBar'
import { PageNav } from '../components/PageNav'
import { fmtRemaining, useServerNow } from '../lib/lapProgress'
import { fmtClock } from '../lib/format'
import { OrderToggle, useOrderMode } from '../components/OrderToggle'
import { SafewordGate } from '../components/SafewordGate'
import { ToastStack, useToasts } from '../components/Toasts'
import { PenaltyEditor } from '../components/PenaltyEditor'
import type { RaceMessage, SourceStatus } from '../lib/types'

interface CatalogEntry {
  kind: 'mywer' | 'apex' | 'simulator' | 'replay'
  label: string
  url: string
  origin: string
  file: string
  speed: number
}

interface RecordingInfo {
  name: string
  size_bytes: number
  modified: number
}

export function RaceControl() {
  return (
    <SafewordGate>
      <RaceControlInner />
    </SafewordGate>
  )
}

function RaceControlInner() {
  const { slot = '1' } = useParams()
  const { snapshot, messages, status } = useLive(slot)
  const [catalog, setCatalog] = useState<CatalogEntry[]>([])
  const [recordings, setRecordings] = useState<RecordingInfo[]>([])
  const [selected, setSelected] = useState('')
  const [customUrl, setCustomUrl] = useState('')
  const [customKind, setCustomKind] = useState<'apex' | 'mywer'>('apex')
  const [replayFile, setReplayFile] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [cfgTab, setCfgTab] = useState<'source' | 'config'>('source')
  const { toasts, push, dismiss } = useToasts()
  const [orderMode, setOrderMode] = useOrderMode()
  const serverNow = useServerNow(snapshot?.updated_at ?? 0, 1000)

  // Messaging
  const [target, setTarget] = useState<'all' | 'select'>('all')
  const [selectedKarts, setSelectedKarts] = useState<Set<string>>(new Set())
  const [text, setText] = useState('')
  const [priority, setPriority] = useState<'info' | 'warning' | 'urgent'>('info')
  const [sent, setSent] = useState('')
  const [snapSaved, setSnapSaved] = useState('')

  const loadCatalog = useCallback(async () => {
    try {
      const r = await api<{ catalog: CatalogEntry[] }>(
        '/api/admin/tracks', { safeword: true },
      )
      setCatalog(r.catalog)
    } catch (e) {
      setError(String(e))
    }
  }, [])

  const loadRecordings = useCallback(async () => {
    try {
      const r = await api<{ recordings: RecordingInfo[] }>(
        '/api/admin/recordings', { safeword: true },
      )
      setRecordings(r.recordings)
    } catch (e) {
      setError(String(e))
    }
  }, [])

  useEffect(() => { void loadCatalog(); void loadRecordings() }, [loadCatalog, loadRecordings])

  const source = snapshot?.source

  // Surface each distinct timing-source error once (the source retries with
  // backoff, so the same error would otherwise repeat every broadcast).
  const lastErrorRef = useRef('')
  const reportSourceError = useCallback((label: string, err: string) => {
    if (err === lastErrorRef.current) return
    lastErrorRef.current = err
    console.error(`[timing source] ${label}: ${err}`)
    push('error', `${label}: ${err}`)
  }, [push])

  // Watch source-status transitions pushed over the live websocket.
  const prevSourceRef = useRef<SourceStatus | undefined>(undefined)
  useEffect(() => {
    const prev = prevSourceRef.current
    prevSourceRef.current = source
    if (!source) return
    if (source.error) {
      reportSourceError(source.label || source.url || source.kind, source.error)
    }
    if (source.connected && !prev?.connected) {
      lastErrorRef.current = ''
      console.info(`[timing source] connected to ${source.label || source.url}`)
      if (prev) push('success', `Connected to ${source.label || source.url}`)
    }
    if (prev?.connected && !source.connected && !source.error) {
      console.info('[timing source] disconnected')
      push('info', 'Timing source disconnected')
    }
  }, [source, push, reportSourceError])

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[race control] action failed:', e)
      push('error', msg)
      setError(msg)
    } finally {
      setBusy(false)
    }
  }

  const connect = () => act(async () => {
    let config: Partial<CatalogEntry>
    if (selected === '__custom__') {
      config = { kind: customKind, label: 'Custom', url: customUrl.trim(), origin: '' }
    } else if (selected === '__replay__') {
      config = { kind: 'replay', label: `Replay ${replayFile}`, file: replayFile, speed: 1 }
    } else {
      const entry = catalog.find((c) => c.label === selected)
      if (!entry) throw new Error('Pick a source first')
      config = entry
    }
    lastErrorRef.current = ''
    const r = await api<{ ok: boolean; source: SourceStatus }>(
      `/e/${slot}/api/admin/connect`, { body: config, safeword: true },
    )
    // The backend waits for the first connect attempt, so this is a real outcome.
    if (r.source?.error && !r.source.connected) {
      reportSourceError(r.source.label || r.source.url, r.source.error)
      setError(`Connect failed: ${r.source.error}`)
    } else if (!r.source?.connected) {
      console.warn('[timing source] no response yet, still trying:', r.source?.url)
      push('info', 'No response from the timing server yet — still trying in the background')
    }
  })

  const disconnect = () => act(() =>
    api(`/e/${slot}/api/admin/disconnect`, { method: 'POST', safeword: true }))

  const toggleRecording = () => act(() =>
    api(`/e/${slot}/api/admin/recording`, {
      body: { enable: !source?.recording }, safeword: true,
    }).then(loadRecordings))

  const seekReplay = (fraction: number) => act(() =>
    api(`/e/${slot}/api/admin/replay/seek`, { body: { fraction }, safeword: true }))

  const deleteRecording = (name: string) => {
    if (!window.confirm(`Delete recording “${name}”? This cannot be undone.`)) return
    void act(() =>
      api(`/api/admin/recordings/${encodeURIComponent(name)}`, {
        method: 'DELETE', safeword: true,
      }).then(loadRecordings))
  }

  const resetEvent = () => {
    if (window.confirm(`Reset all data for event ${slot}? (standings, laps, messages)`)) {
      void act(() => api(`/e/${slot}/api/admin/reset`, { method: 'POST', safeword: true }))
    }
  }

  const sendMessage = (e: React.FormEvent) => {
    e.preventDefault()
    if (!text.trim()) return
    const karts = target === 'select' ? [...selectedKarts] : null
    if (target === 'select' && karts!.length === 0) {
      setError('Select at least one kart')
      return
    }
    void act(async () => {
      await api(`/e/${slot}/api/admin/message`, {
        body: { text: text.trim(), target: karts, priority }, safeword: true,
      })
      setText('')
      setSent(karts ? `Sent to ${karts.map((k) => `#${k}`).join(', ')}` : 'Sent to all drivers')
      setTimeout(() => setSent(''), 3000)
    })
  }

  const toggleKart = (k: string) => {
    setSelectedKarts((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

  const saveSnapshot = () => act(async () => {
    await api(`/e/${slot}/api/admin/snapshots`, { method: 'POST', safeword: true })
    setSnapSaved('Saved ✓')
    setTimeout(() => setSnapSaved(''), 3000)
  })

  const race = snapshot?.race
  // The messaging selector lists karts by number (easier to find one to
  // message) rather than by race order, which shuffles every lap.
  const messageKarts = useMemo(
    () => [...(snapshot?.drivers ?? [])].sort(
      (a, b) => (parseInt(a.kart_no, 10) || 0) - (parseInt(b.kart_no, 10) || 0)
        || a.kart_no.localeCompare(b.kart_no),
    ),
    [snapshot?.drivers],
  )
  const recentMessages = useMemo(
    () => [...messages].sort((a: RaceMessage, b: RaceMessage) => b.id - a.id).slice(0, 30),
    [messages],
  )

  return (
    <div className="mx-auto flex min-h-full max-w-7xl flex-col">
      <ToastStack toasts={toasts} dismiss={dismiss} />
      <PageHeader
        title={`Race Control — Event ${slot}`}
        subtitle={[race?.event_name, race?.track_name].filter(Boolean).join(' · ')}
        nav={<PageNav slot={slot} />}
        right={
          <>
            <div className="hidden text-right sm:block">
              <div className="label-race">Remaining</div>
              <div className="timing font-bold">
                {race ? fmtRemaining(race, serverNow) : '--:--'}
              </div>
            </div>
            <FlagBanner flag={race?.flag ?? 'none'} compact />
            <ConnectionDot status={status} />
          </>
        }
      />

      <div className="grid gap-4 p-4 lg:grid-cols-3">
        {/* Source control */}
        <div className="rounded-xl bg-pit-900 p-4 ring-1 ring-pit-800">
          <div className="mb-3 flex gap-2">
            {(['source', 'config'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setCfgTab(t)}
                className={`label-race rounded px-2 py-1 ${cfgTab === t ? 'bg-pit-700 text-ink-100' : 'text-ink-500 hover:text-ink-300'}`}
              >
                {t === 'source' ? 'Timing source' : 'Configuration'}
              </button>
            ))}
          </div>
          {cfgTab === 'source' && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <span className={`h-2.5 w-2.5 rounded-full ${source?.connected ? 'bg-race-green' : 'bg-race-red'}`} />
              <span className="truncate">
                {source?.connected
                  ? `${source.label || source.url} · ${source.frames_received} frames`
                  : source?.error
                    ? `Disconnected: ${source.error}`
                    : 'Not connected'}
              </span>
            </div>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="w-full rounded bg-pit-950 px-3 py-2 ring-1 ring-pit-600"
            >
              <option value="">— pick a track —</option>
              {catalog.map((c) => (
                <option key={c.label} value={c.label}>{c.label}</option>
              ))}
              <option value="__custom__">Custom websocket URL…</option>
              <option value="__replay__">Replay a recording…</option>
            </select>
            {selected === '__custom__' && (
              <div className="flex flex-wrap gap-2">
                <select
                  value={customKind}
                  onChange={(e) => setCustomKind(e.target.value as 'apex' | 'mywer')}
                  className="rounded bg-pit-950 px-2 py-2 ring-1 ring-pit-600"
                >
                  <option value="apex">Apex</option>
                  <option value="mywer">MyWeR</option>
                </select>
                <input
                  value={customUrl}
                  onChange={(e) => setCustomUrl(e.target.value)}
                  placeholder="wss://…"
                  className="min-w-0 flex-1 basis-40 rounded bg-pit-950 px-3 py-2 ring-1 ring-pit-600"
                />
              </div>
            )}
            {selected === '__replay__' && (
              <select
                value={replayFile}
                onChange={(e) => setReplayFile(e.target.value)}
                className="w-full rounded bg-pit-950 px-3 py-2 ring-1 ring-pit-600"
              >
                <option value="">— pick a recording —</option>
                {recordings.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
              </select>
            )}
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={connect} disabled={busy || !selected}
                className="rounded bg-race-green px-3 py-1.5 text-sm font-bold uppercase text-pit-950 disabled:opacity-40">
                Connect
              </button>
              <button type="button" onClick={disconnect} disabled={busy}
                className="rounded bg-pit-700 px-3 py-1.5 text-sm font-bold uppercase disabled:opacity-40">
                Disconnect
              </button>
              <button type="button" onClick={toggleRecording} disabled={busy || !source?.connected}
                className={`rounded px-3 py-1.5 text-sm font-bold uppercase disabled:opacity-40 ${
                  source?.recording ? 'bg-race-red msg-flash' : 'bg-pit-700'
                }`}>
                {source?.recording ? '● Recording' : '○ Record'}
              </button>
              <button type="button" onClick={resetEvent} disabled={busy}
                className="rounded bg-pit-700 px-3 py-1.5 text-sm font-bold uppercase text-race-red disabled:opacity-40">
                Reset
              </button>
            </div>
            {source?.recording && (
              <p className="text-xs text-ink-500">Writing {source.recording_file}</p>
            )}
            {source?.kind === 'replay' && (source?.replay_count ?? 0) > 0 && (
              <ReplayTimeline source={source} onSeek={seekReplay} disabled={busy} />
            )}
            {error && <p className="text-sm text-race-red">{error}</p>}

            {/* Session flag override: for organizers without access to the
                track system; "Track" mirrors the timing feed. */}
            <h3 className="label-race pt-2">Session flag</h3>
            <div className="flex flex-wrap gap-2">
              {([
                ['', 'Track', 'bg-pit-600'],
                ['green', 'Green', 'bg-race-green text-pit-950'],
                ['yellow', 'Yellow', 'bg-race-yellow text-pit-950'],
                ['red', 'Red', 'bg-race-red'],
                ['finish', 'Finish', 'bg-ink-100 text-pit-950'],
              ] as const).map(([value, label, activeCls]) => {
                const active = (snapshot?.flag_override ?? '') === value
                return (
                  <button
                    key={label}
                    type="button"
                    disabled={busy}
                    onClick={() => act(() =>
                      api(`/e/${slot}/api/admin/flag`, {
                        body: { flag: value || null }, safeword: true,
                      }))}
                    className={`rounded px-3 py-1.5 text-xs font-bold uppercase disabled:opacity-40 ${
                      active ? activeCls : 'bg-pit-700 hover:bg-pit-600'
                    }`}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </div>
          )}

          {cfgTab === 'config' && (
            <div className="space-y-3 text-sm">
              <Toggle
                label="Recalculate positions"
                hint="Reorder karts by laps + time when the timing system keeps the start grid and never reorders."
                checked={!!snapshot?.recompute_positions}
                disabled={busy}
                onChange={(v) => act(() => api(`/e/${slot}/api/admin/settings`, { body: { recompute_positions: v }, safeword: true }))}
              />
              <Toggle
                label="Automatic pit lane"
                hint="Off = the track has no pit gates; the app infers pit stops, pit laps and stint time from lap times."
                checked={snapshot?.auto_pitlane ?? true}
                disabled={busy}
                onChange={(v) => act(() => api(`/e/${slot}/api/admin/settings`, { body: { auto_pitlane: v }, safeword: true }))}
              />
              <Toggle
                label="Hide penalties from teams"
                hint="On = the team dashboard hides its penalty panels (e.g. until penalties are official). Race control still sees everything."
                checked={!!snapshot?.hide_team_penalties}
                disabled={busy}
                onChange={(v) => act(() => api(`/e/${slot}/api/admin/settings`, { body: { hide_team_penalties: v }, safeword: true }))}
              />

              <div className="pt-2">
                <h3 className="label-race mb-2">Recordings ({recordings.length})</h3>
                {recordings.length === 0 ? (
                  <p className="text-xs text-ink-500">No recordings on the server yet.</p>
                ) : (
                  <ul className="max-h-56 space-y-1 overflow-y-auto">
                    {recordings.map((r) => (
                      <li key={r.name} className="flex items-center gap-2 rounded bg-pit-850 px-2 py-1.5">
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-mono text-xs">{r.name}</div>
                          <div className="text-[0.65rem] text-ink-500">
                            {fmtSize(r.size_bytes)} · {fmtDate(r.modified)}
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => deleteRecording(r.name)}
                          className="rounded bg-pit-700 px-2 py-1 text-xs font-bold uppercase text-race-red hover:bg-pit-600 disabled:opacity-40"
                        >
                          Delete
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Driver messaging */}
        <div className="rounded-xl bg-pit-900 p-4 ring-1 ring-pit-800 lg:col-span-2">
          <h3 className="label-race mb-3">Message drivers</h3>
          <form onSubmit={sendMessage} className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => setTarget('all')}
                className={`rounded-full px-3 py-1 text-xs font-bold uppercase ${
                  target === 'all' ? 'bg-race-blue' : 'bg-pit-700'
                }`}>
                All drivers
              </button>
              <button type="button" onClick={() => setTarget('select')}
                className={`rounded-full px-3 py-1 text-xs font-bold uppercase ${
                  target === 'select' ? 'bg-race-blue' : 'bg-pit-700'
                }`}>
                Selected karts
              </button>
              {target === 'select' && (
                <div className="flex flex-wrap gap-1.5">
                  {messageKarts.map((d) => (
                    <button
                      key={d.kart_no}
                      type="button"
                      onClick={() => toggleKart(d.kart_no)}
                      className={`min-w-9 rounded px-2 py-1 text-xs font-bold ${
                        selectedKarts.has(d.kart_no)
                          ? 'bg-race-yellow text-pit-950'
                          : 'bg-pit-700'
                      }`}
                    >
                      {d.kart_no}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {(['Yellow flag — no overtaking', 'Green flag — race on', 'Last 5 minutes', 'Slow down — warning', 'Come to race direction after session'] as const).map((preset) => (
                <button key={preset} type="button" onClick={() => setText(preset)}
                  className="rounded-full bg-pit-700 px-3 py-1 text-xs hover:bg-pit-600">
                  {preset}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={300}
                placeholder="Message to drivers…"
                className="min-w-0 flex-1 basis-48 rounded bg-pit-950 px-3 py-2 outline-none ring-1 ring-pit-600 focus:ring-race-blue"
              />
              <select value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)}
                className="rounded bg-pit-950 px-2 py-2 ring-1 ring-pit-600">
                <option value="info">Info</option>
                <option value="warning">Warning</option>
                <option value="urgent">Urgent</option>
              </select>
              <button type="submit" disabled={busy || !text.trim()}
                className="rounded bg-race-blue px-4 py-2 font-bold uppercase tracking-wider disabled:opacity-40 hover:brightness-110">
                Send
              </button>
            </div>
            {sent && <p className="text-xs text-race-green">{sent}</p>}
          </form>

          <h3 className="label-race mb-2 mt-4">Recent messages</h3>
          <ul className="max-h-40 space-y-1.5 overflow-y-auto text-sm">
            {recentMessages.length === 0 && <li className="text-ink-500">Nothing sent yet.</li>}
            {recentMessages.map((m) => (
              <li key={m.id} className="rounded bg-pit-850 px-3 py-1.5">
                <span className="mr-2 text-[0.6rem] font-bold uppercase text-ink-500">
                  {m.sender === 'race_control' ? 'RC' : 'PIT'}
                  {' → '}
                  {m.target ? m.target.map((k) => `#${k}`).join(',') : 'ALL'}
                </span>
                {m.text}
              </li>
            ))}
          </ul>
        </div>

        {/* Penalties & warnings */}
        <div className="lg:col-span-3 rounded-xl bg-pit-900 p-4 ring-1 ring-pit-800">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="label-race">Penalties &amp; warnings</h3>
            <button type="button" onClick={saveSnapshot} disabled={busy || !snapshot?.drivers.length}
              className="rounded bg-pit-700 px-3 py-1.5 text-xs font-bold uppercase tracking-wider hover:bg-pit-600 disabled:opacity-40">
              {snapSaved || 'Save snapshot'}
            </button>
          </div>
          <PenaltyEditor
            apiBase={`/e/${slot}/api/admin`}
            drivers={snapshot?.drivers ?? []}
            penalties={snapshot?.penalties ?? []}
          />
          <p className="mt-2 text-[0.7rem] text-ink-500">
            The team is notified a few seconds after assigning, so a mistake can be removed first.
            “Save snapshot” archives the current result to the Snapshots page.
          </p>
        </div>

        {/* Standings */}
        <div className="lg:col-span-3 rounded-xl bg-pit-900 ring-1 ring-pit-800">
          {snapshot?.race.session_kind === 'race' && (
            <div className="flex justify-end px-3 pt-3">
              <OrderToggle mode={orderMode} onChange={setOrderMode} />
            </div>
          )}
          {snapshot ? (
            <TimingTable
              snapshot={snapshot}
              compact
              orderMode={snapshot.race.session_kind === 'race' ? orderMode : 'race'}
            />
          ) : (
            <div className="p-10 text-center text-ink-500">Connecting…</div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Seek bar for replay playback: drag to skip anywhere in the recording. */
function ReplayTimeline({ source, onSeek, disabled }: {
  source: SourceStatus
  onSeek: (fraction: number) => void
  disabled?: boolean
}) {
  const count = source.replay_count ?? 0
  const pos = source.replay_pos ?? 0
  const [drag, setDrag] = useState<number | null>(null)
  const liveFrac = count > 1 ? pos / (count - 1) : 0
  const value = drag ?? liveFrac
  const duration = source.replay_duration_s ?? 0
  const elapsed = drag != null ? drag * duration : (source.replay_elapsed_s ?? 0)
  const commit = () => { if (drag != null) { onSeek(drag); setDrag(null) } }
  return (
    <div className="space-y-1">
      <div className="label-race flex items-center justify-between">
        <span>Replay timeline</span>
        <span className="timing">{fmtClock(Math.round(elapsed))} / {fmtClock(Math.round(duration))}</span>
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.001}
        value={value}
        disabled={disabled}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        className="w-full accent-race-blue"
        aria-label="Seek replay position"
      />
    </div>
  )
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function fmtDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function Toggle({ label, hint, checked, disabled, onChange }: {
  label: string
  hint: string
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex w-full items-start gap-3 rounded-lg bg-pit-850 p-3 text-left disabled:opacity-40"
    >
      <span
        className={`mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full px-0.5 transition-colors ${
          checked ? 'bg-race-green' : 'bg-pit-600'
        }`}
      >
        <span className={`h-4 w-4 rounded-full bg-ink-100 transition-transform ${checked ? 'translate-x-4' : ''}`} />
      </span>
      <span className="min-w-0">
        <span className="font-bold">{label}</span>
        <span className="block text-xs text-ink-500">{hint}</span>
      </span>
    </button>
  )
}
