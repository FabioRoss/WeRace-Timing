import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../lib/api'
import { useLive } from '../lib/useLive'
import { FlagBanner } from '../components/FlagBanner'
import { TimingTable } from '../components/TimingTable'
import { ConnectionDot, PageHeader } from '../components/StatusBar'
import { fmtRemaining, useServerNow } from '../lib/lapProgress'
import { OrderToggle, useOrderMode } from '../components/OrderToggle'
import { SafewordGate } from '../components/SafewordGate'
import { ToastStack, useToasts } from '../components/Toasts'
import type { RaceMessage, SourceStatus } from '../lib/types'

interface CatalogEntry {
  kind: 'mywer' | 'apex' | 'simulator' | 'replay'
  label: string
  url: string
  origin: string
  file: string
  speed: number
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
  const [recordings, setRecordings] = useState<string[]>([])
  const [selected, setSelected] = useState('')
  const [customUrl, setCustomUrl] = useState('')
  const [customKind, setCustomKind] = useState<'apex' | 'mywer'>('apex')
  const [replayFile, setReplayFile] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { toasts, push, dismiss } = useToasts()
  const [orderMode, setOrderMode] = useOrderMode()
  const serverNow = useServerNow(snapshot?.updated_at ?? 0, 1000)

  // Messaging
  const [target, setTarget] = useState<'all' | 'select'>('all')
  const [selectedKarts, setSelectedKarts] = useState<Set<string>>(new Set())
  const [text, setText] = useState('')
  const [priority, setPriority] = useState<'info' | 'warning' | 'urgent'>('info')
  const [sent, setSent] = useState('')

  const loadCatalog = useCallback(async () => {
    try {
      const r = await api<{ catalog: CatalogEntry[]; recordings: string[] }>(
        '/api/admin/tracks', { safeword: true },
      )
      setCatalog(r.catalog)
      setRecordings(r.recordings)
    } catch (e) {
      setError(String(e))
    }
  }, [])

  useEffect(() => { void loadCatalog() }, [loadCatalog])

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
    }).then(loadCatalog))

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

  const race = snapshot?.race
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
          <h3 className="label-race mb-3">Timing source</h3>
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
                {recordings.map((r) => <option key={r} value={r}>{r}</option>)}
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
                  {(snapshot?.drivers ?? []).map((d) => (
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
