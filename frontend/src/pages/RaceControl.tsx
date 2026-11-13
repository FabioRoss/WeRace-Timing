import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../lib/api'
import { useLive } from '../lib/useLive'
import { TimingTable } from '../components/TimingTable'
import { ConnectionDot, PageHeader, RaceStrip } from '../components/StatusBar'
import { PageNav } from '../components/PageNav'
import { CountBadge, Page, Panel, Segmented } from '../components/ui'
import { fmtRemaining, useServerNow } from '../lib/lapProgress'
import { fmtClock } from '../lib/format'
import { OrderToggle, useOrderMode } from '../components/OrderToggle'
import { SafewordGate } from '../components/SafewordGate'
import { ToastStack, useToasts } from '../components/Toasts'
import { PenaltyEditor } from '../components/PenaltyEditor'
import { useT } from '../lib/i18n'
import type { RaceMessage, SourceStatus } from '../lib/types'

interface CatalogEntry {
  kind: 'mywer' | 'apex' | 'simulator' | 'replay'
  label: string
  track_name?: string      // optional catalog override for the feed's track name
  url: string
  origin: string
  file: string
  speed: number
  // Optional per-track RC defaults loaded on connect (tracks.py); ride along
  // with the entry when we POST it to /connect. null = leave the slot as-is.
  auto_pitlane?: boolean | null
  recompute_positions?: boolean | null
  hide_team_penalties?: boolean | null
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
  const t = useT()
  const { slot = '1' } = useParams()
  const { snapshot, messages, status } = useLive(slot, { staff: true })
  const [catalog, setCatalog] = useState<CatalogEntry[]>([])
  const [recordings, setRecordings] = useState<RecordingInfo[]>([])
  const [selected, setSelected] = useState('')
  const [customUrl, setCustomUrl] = useState('')
  const [customKind, setCustomKind] = useState<'apex' | 'mywer'>('apex')
  const [replayFile, setReplayFile] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [section, setSectionState] = useState<Section>(() => {
    const v = localStorage.getItem(SECTION_KEY)
    return v === 'penalties' || v === 'messages' || v === 'setup' ? v : 'live'
  })
  const setSection = (v: Section) => { setSectionState(v); localStorage.setItem(SECTION_KEY, v) }
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
      if (prev) push('success', t('Connected to {name}', { name: source.label || source.url || '' }))
    }
    if (prev?.connected && !source.connected && !source.error) {
      console.info('[timing source] disconnected')
      push('info', t('Timing source disconnected'))
    }
  }, [source, push, reportSourceError, t])

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
      if (!entry) throw new Error(t('Pick a source first'))
      config = entry
    }
    lastErrorRef.current = ''
    const r = await api<{ ok: boolean; source: SourceStatus }>(
      `/e/${slot}/api/admin/connect`, { body: config, safeword: true },
    )
    // The backend waits for the first connect attempt, so this is a real outcome.
    if (r.source?.error && !r.source.connected) {
      reportSourceError(r.source.label || r.source.url, r.source.error)
      setError(t('Connect failed: {error}', { error: r.source.error }))
    } else if (!r.source?.connected) {
      console.warn('[timing source] no response yet, still trying:', r.source?.url)
      push('info', t('No response from the timing server yet — still trying in the background'))
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
    if (!window.confirm(t('Delete recording “{name}”? This cannot be undone.', { name }))) return
    void act(() =>
      api(`/api/admin/recordings/${encodeURIComponent(name)}`, {
        method: 'DELETE', safeword: true,
      }).then(loadRecordings))
  }

  const resetEvent = () => {
    if (window.confirm(t('Reset all data for event {slot}? (standings, laps, messages)', { slot }))) {
      void act(() => api(`/e/${slot}/api/admin/reset`, { method: 'POST', safeword: true }))
    }
  }

  const sendMessage = (e: React.FormEvent) => {
    e.preventDefault()
    if (!text.trim()) return
    const karts = target === 'select' ? [...selectedKarts] : null
    if (target === 'select' && karts!.length === 0) {
      setError(t('Select at least one kart'))
      return
    }
    void act(async () => {
      await api(`/e/${slot}/api/admin/message`, {
        body: { text: text.trim(), target: karts, priority }, safeword: true,
      })
      setText('')
      setSent(karts ? t('Sent to {karts}', { karts: karts.map((k) => `#${k}`).join(', ') }) : t('Sent to all drivers'))
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
    setSnapSaved(t('Saved ✓'))
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

  const toServe = (snapshot?.penalties ?? []).filter((p) => p.kind === 'time' && !p.served).length
  const held = !!snapshot?.hide_team_penalties
  const sourceDown = !source?.connected
  const setHeld = (v: boolean) => act(() => api(`/e/${slot}/api/admin/settings`, { body: { hide_team_penalties: v }, safeword: true }))

  const NAV: { id: Section; label: string; icon: React.ReactNode; accent: string; badge?: React.ReactNode }[] = [
    { id: 'live', label: t('Live'), icon: <IconFlag />, accent: 'var(--color-race-green)' },
    {
      id: 'penalties', label: t('Penalties'), icon: <IconGavel />, accent: 'var(--color-race-red)',
      badge: <CountBadge n={toServe} tone="bg-race-red text-white" />,
    },
    { id: 'messages', label: t('Messages'), icon: <IconChat />, accent: 'var(--color-race-blue)' },
    {
      id: 'setup', label: t('Setup'), icon: <IconGear />, accent: 'var(--color-ink-300)',
      badge: sourceDown ? <span className="block h-2.5 w-2.5 rounded-full bg-race-red ring-2 ring-pit-950" title={t('Not connected')} /> : undefined,
    },
  ]
  const current = NAV.find((n) => n.id === section) ?? NAV[0]

  return (
    <Page className="pb-24 lg:pb-8">
      <ToastStack toasts={toasts} dismiss={dismiss} />
      <PageHeader
        title={t('Race Control — Event {slot}', { slot })}
        subtitle={[race?.event_name, race?.track_name].filter(Boolean).join(' · ')}
        nav={<PageNav slot={slot} />}
        right={<ConnectionDot status={status} />}
      />
      <RaceStrip
        flag={race?.flag ?? 'none'}
        remaining={race ? fmtRemaining(race, serverNow) : '--:--'}
        status={status}
        extra={
          <>
            {held && (
              <button type="button" onClick={() => setSection('penalties')}
                title={t('Penalties held')}
                className="shrink-0 rounded-md bg-race-yellow px-2 py-1 text-[0.65rem] font-extrabold uppercase tracking-wider text-pit-950">
                <span className="sm:hidden">{t('Held')}</span>
                <span className="hidden sm:inline">{t('Penalties held')}</span>
              </button>
            )}
            <span className={`hidden max-w-48 truncate text-xs sm:inline ${sourceDown ? 'text-race-red' : 'text-ink-500'}`}>
              {sourceDown ? t('Not connected') : source?.label || source?.url}
            </span>
          </>
        }
      />

      <div className="flex min-w-0 gap-6 px-3 pt-3 sm:px-4 sm:pt-4">
        {/* Desktop: section rail */}
        <nav aria-label={t('Race control sections')} className="sticky top-20 hidden h-fit w-52 shrink-0 flex-col gap-1 lg:flex">
          {NAV.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => setSection(n.id)}
              aria-current={section === n.id ? 'page' : undefined}
              className={`relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold transition-colors ${
                section === n.id ? 'bg-pit-800 text-ink-100' : 'text-ink-500 hover:bg-pit-900 hover:text-ink-300'
              }`}
            >
              <span className="absolute inset-y-2 left-0 w-1 rounded-full transition-opacity"
                style={{ background: n.accent, opacity: section === n.id ? 1 : 0 }} />
              <span style={{ color: section === n.id ? n.accent : undefined }}>{n.icon}</span>
              <span className="flex-1">{n.label}</span>
              {n.badge}
            </button>
          ))}
        </nav>

        <main className="min-w-0 flex-1">
          <h2 className="mb-3 flex items-center gap-2 text-lg font-extrabold uppercase tracking-wider">
            <span style={{ color: current.accent }}>{current.icon}</span>
            {current.label}
          </h2>
          {error && (
            <p className="mb-3 rounded-xl bg-race-red/10 px-4 py-2.5 text-sm text-race-red ring-1 ring-race-red/30">{error}</p>
          )}

          {section === 'live' && (
            <div className="grid grid-cols-1 gap-3 sm:gap-4">
              <Panel title={t('Session flag')}>
                {/* For organizers without access to the track system; "Track"
                    mirrors the timing feed. */}
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                  {([
                    ['', 'Track', 'bg-pit-600 text-ink-100'],
                    ['green', 'Green', 'bg-race-green text-pit-950'],
                    ['yellow', 'Yellow', 'bg-race-yellow text-pit-950'],
                    ['red', 'Red', 'bg-race-red text-white'],
                    ['finish', 'Finish', 'checker text-pit-950'],
                  ] as const).map(([value, label, activeCls]) => {
                    const active = (snapshot?.flag_override ?? '') === value
                    return (
                      <button
                        key={label}
                        type="button"
                        disabled={busy}
                        aria-pressed={active}
                        onClick={() => act(() =>
                          api(`/e/${slot}/api/admin/flag`, {
                            body: { flag: value || null }, safeword: true,
                          }))}
                        className={`min-h-12 rounded-xl text-sm font-extrabold uppercase tracking-wider ring-2 transition disabled:opacity-40 ${
                          active ? `${activeCls} ring-ink-100` : 'bg-pit-800 text-ink-300 ring-transparent hover:bg-pit-700'
                        } ${value === '' ? 'col-span-2 sm:col-span-1' : ''}`}
                      >
                        <span className={value === 'finish' && active ? 'rounded bg-ink-100 px-1.5' : ''}>{t(label)}</span>
                      </button>
                    )
                  })}
                </div>
                <p className="mt-2 text-xs text-ink-500">{t('“Track” follows the timing system. The others override it on every dashboard.')}</p>
              </Panel>

              <Panel
                title={t('Standings')}
                actions={
                  <>
                    {snapshot?.race.session_kind === 'race' && <OrderToggle mode={orderMode} onChange={setOrderMode} />}
                    <button type="button" onClick={saveSnapshot} disabled={busy || !snapshot?.drivers.length} className="btn btn-quiet">
                      {snapSaved || t('Save snapshot')}
                    </button>
                  </>
                }
                bodyClass=""
              >
                {snapshot ? (
                  <TimingTable
                    snapshot={snapshot}
                    compact
                    ring={false}
                    orderMode={snapshot.race.session_kind === 'race' ? orderMode : 'race'}
                  />
                ) : (
                  <div className="p-10 text-center text-ink-500">{t('Connecting…')}</div>
                )}
              </Panel>
            </div>
          )}

          {section === 'penalties' && (
            <div className="grid grid-cols-1 gap-3 sm:gap-4">
              <div className={`flex flex-wrap items-center gap-3 rounded-2xl px-4 py-3 ring-1 ${
                held ? 'bg-race-yellow/10 ring-race-yellow/40' : 'bg-race-green/10 ring-race-green/30'
              }`}>
                <div className="min-w-0 flex-1 basis-56">
                  <div className={`text-sm font-extrabold uppercase tracking-wider ${held ? 'text-race-yellow' : 'text-race-green'}`}>
                    {held ? t('Penalties are held') : t('Penalties are published')}
                  </div>
                  <p className="text-xs text-ink-300">
                    {held
                      ? t('Only race control and Export see them. Teams, drivers and the public page don’t, and nobody is notified.')
                      : t('Teams, drivers and the public page see penalties; the team is notified a few seconds after assigning.')}
                  </p>
                </div>
                <button type="button" disabled={busy} onClick={() => setHeld(!held)}
                  className={`btn ${held ? 'btn-primary' : 'btn-quiet'}`}>
                  {held ? t('Publish penalties') : t('Hold penalties')}
                </button>
              </div>
              <Panel bodyClass="p-4">
                <PenaltyEditor
                  apiBase={`/e/${slot}/api/admin`}
                  drivers={snapshot?.drivers ?? []}
                  penalties={snapshot?.penalties ?? []}
                />
              </Panel>
            </div>
          )}

          {section === 'messages' && (
            <div className="grid grid-cols-1 gap-3 sm:gap-4 xl:grid-cols-2">
              <Panel title={t('Send to drivers')}>
                <form onSubmit={sendMessage} className="space-y-3">
                  <Segmented
                    value={target}
                    onChange={setTarget}
                    options={[
                      { value: 'all', label: t('All drivers') },
                      { value: 'select', label: t('Selected karts') },
                    ]}
                  />
                  {target === 'select' && (
                    <div className="flex flex-wrap gap-1.5">
                      {messageKarts.map((d) => (
                        <button
                          key={d.kart_no}
                          type="button"
                          onClick={() => toggleKart(d.kart_no)}
                          aria-pressed={selectedKarts.has(d.kart_no)}
                          className={`min-w-11 rounded-lg px-2 py-1.5 timing text-sm font-bold ${
                            selectedKarts.has(d.kart_no) ? 'bg-race-yellow text-pit-950' : 'bg-pit-700'
                          }`}
                        >
                          {d.kart_no}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {(['Yellow flag — no overtaking', 'Green flag — race on', 'Last 5 minutes', 'Slow down — warning', 'Come to race direction after session'] as const).map((preset) => (
                      <button key={preset} type="button" onClick={() => setText(t(preset))} className="chip">
                        {t(preset)}
                      </button>
                    ))}
                  </div>
                  <input
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    maxLength={300}
                    placeholder={t('Message to drivers…')}
                    className="field"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Segmented
                      size="sm"
                      value={priority}
                      onChange={setPriority}
                      options={[
                        { value: 'info', label: t('Info') },
                        { value: 'warning', label: t('Warning') },
                        { value: 'urgent', label: t('Urgent') },
                      ]}
                    />
                    <button type="submit" disabled={busy || !text.trim()} className="btn btn-primary ml-auto">
                      {t('Send')}
                    </button>
                  </div>
                  <p className="min-h-4 text-xs text-race-green" aria-live="polite">{sent}</p>
                </form>
              </Panel>
              <Panel title={t('Sent & received')}>
                <ul className="max-h-[28rem] space-y-1.5 overflow-y-auto text-sm">
                  {recentMessages.length === 0 && <li className="text-ink-500">{t('Nothing sent yet.')}</li>}
                  {recentMessages.map((m) => (
                    <li key={m.id} className="rounded-lg bg-pit-850 px-3 py-2">
                      <div className="mb-0.5 text-[0.65rem] font-bold uppercase tracking-wider text-ink-500">
                        <span className={m.sender === 'race_control' ? 'text-race-yellow' : 'text-race-blue'}>
                          {m.sender === 'race_control' ? t('Race control') : t('Pit wall')}
                        </span>
                        {' → '}
                        {m.target ? m.target.map((k) => `#${k}`).join(', ') : t('all')}
                      </div>
                      {m.text}
                    </li>
                  ))}
                </ul>
              </Panel>
            </div>
          )}

          {section === 'setup' && (
            <div className="grid grid-cols-1 gap-3 sm:gap-4 xl:grid-cols-2">
              <Panel title={t('Timing source')}>
                <div className="space-y-3">
                  <div className={`flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm ${
                    source?.connected ? 'bg-race-green/10 text-ink-100' : 'bg-race-red/10 text-ink-100'
                  }`}>
                    <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${source?.connected ? 'bg-race-green' : 'bg-race-red'}`} />
                    <span className="min-w-0 truncate">
                      {source?.connected
                        ? t('{name} · {n} frames', { name: source.label || source.url || '', n: source.frames_received })
                        : source?.error
                          ? t('Disconnected: {error}', { error: source.error })
                          : t('Not connected')}
                    </span>
                  </div>
                  <select value={selected} onChange={(e) => setSelected(e.target.value)} className="field">
                    <option value="">{t('— pick a track —')}</option>
                    {catalog.map((c) => (
                      <option key={c.label} value={c.label}>{c.label}</option>
                    ))}
                    <option value="__custom__">{t('Custom websocket URL…')}</option>
                    <option value="__replay__">{t('Replay a recording…')}</option>
                  </select>
                  {selected === '__custom__' && (
                    <div className="flex flex-wrap gap-2">
                      <select value={customKind} onChange={(e) => setCustomKind(e.target.value as 'apex' | 'mywer')}
                        className="field w-auto">
                        <option value="apex">{t('Apex')}</option>
                        <option value="mywer">{t('MyWeR')}</option>
                      </select>
                      <input value={customUrl} onChange={(e) => setCustomUrl(e.target.value)} placeholder="wss://…"
                        className="field flex-1 basis-40" />
                    </div>
                  )}
                  {selected === '__replay__' && (
                    <select value={replayFile} onChange={(e) => setReplayFile(e.target.value)} className="field">
                      <option value="">{t('— pick a recording —')}</option>
                      {recordings.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
                    </select>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={connect} disabled={busy || !selected}
                      className="btn bg-race-green text-pit-950 hover:brightness-110">
                      {t('Connect')}
                    </button>
                    <button type="button" onClick={disconnect} disabled={busy || !source?.connected} className="btn btn-quiet">
                      {t('Disconnect')}
                    </button>
                    <button type="button" onClick={toggleRecording} disabled={busy || !source?.connected}
                      className={`btn ${source?.recording ? 'btn-danger msg-flash' : 'btn-quiet'}`}>
                      {source?.recording ? t('● Recording') : t('○ Record')}
                    </button>
                  </div>
                  {source?.recording && (
                    <p className="text-xs text-ink-500">{t('Writing {file}', { file: source.recording_file ?? '' })}</p>
                  )}
                  {source?.kind === 'replay' && (source?.replay_count ?? 0) > 0 && (
                    <ReplayTimeline source={source} onSeek={seekReplay} disabled={busy} />
                  )}
                </div>
              </Panel>

              <Panel title={t('Track settings')}>
                <div className="space-y-2 text-sm">
                  <Toggle
                    label={t('Recalculate positions')}
                    hint={t('Reorder karts by laps + time when the timing system keeps the start grid and never reorders.')}
                    checked={!!snapshot?.recompute_positions}
                    disabled={busy}
                    onChange={(v) => act(() => api(`/e/${slot}/api/admin/settings`, { body: { recompute_positions: v }, safeword: true }))}
                  />
                  <Toggle
                    label={t('Automatic pit lane')}
                    hint={t('Off = the track has no pit gates; the app infers pit stops, pit laps and stint time from lap times.')}
                    checked={snapshot?.auto_pitlane ?? true}
                    disabled={busy}
                    onChange={(v) => act(() => api(`/e/${slot}/api/admin/settings`, { body: { auto_pitlane: v }, safeword: true }))}
                  />
                  <Toggle
                    label={t('Hold penalties (not yet official)')}
                    hint={t('On = penalties are hidden from the public page, team dashboards and drivers, and nobody is notified, until you publish them. Race control and Export still see everything.')}
                    checked={held}
                    disabled={busy}
                    onChange={setHeld}
                  />
                </div>
              </Panel>

              <Panel title={t('Recordings ({n})', { n: recordings.length })}>
                {recordings.length === 0 ? (
                  <p className="text-sm text-ink-500">{t('No recordings on the server yet.')}</p>
                ) : (
                  <ul className="max-h-72 space-y-1.5 overflow-y-auto">
                    {recordings.map((r) => (
                      <li key={r.name} className="flex items-center gap-2 rounded-lg bg-pit-850 px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-mono text-xs">{r.name}</div>
                          <div className="text-[0.7rem] text-ink-500">{fmtSize(r.size_bytes)} · {fmtDate(r.modified)}</div>
                        </div>
                        <button type="button" disabled={busy} onClick={() => deleteRecording(r.name)}
                          className="btn btn-quiet px-2.5 py-1 text-race-red">
                          {t('Delete')}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>

              <section className="min-w-0 rounded-2xl p-4 ring-1 ring-race-red/40">
                <h3 className="label-race mb-1 text-race-red">{t('Danger zone')}</h3>
                <p className="mb-3 text-sm text-ink-300">{t('Wipes standings, laps, penalties and messages for this event. Saved snapshots are kept.')}</p>
                <button type="button" onClick={resetEvent} disabled={busy} className="btn btn-danger">
                  {t('Reset event')}
                </button>
              </section>
            </div>
          )}
        </main>
      </div>

      {/* Phones: section tabs in thumb reach */}
      <nav
        aria-label={t('Race control sections')}
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-pit-800 bg-pit-950/95 backdrop-blur-md lg:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {NAV.map((n) => (
          <button
            key={n.id}
            type="button"
            onClick={() => { setSection(n.id); window.scrollTo({ top: 0 }) }}
            aria-current={section === n.id ? 'page' : undefined}
            className={`relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-[0.7rem] font-semibold ${
              section === n.id ? 'text-ink-100' : 'text-ink-500'
            }`}
          >
            <span className="absolute inset-x-6 top-0 h-0.5 rounded-full"
              style={{ background: n.accent, opacity: section === n.id ? 1 : 0 }} />
            <span className="relative" style={{ color: section === n.id ? n.accent : undefined }}>
              {n.icon}
              {n.badge && <span className="absolute -right-3 -top-1.5">{n.badge}</span>}
            </span>
            {n.label}
          </button>
        ))}
      </nav>
    </Page>
  )
}

type Section = 'live' | 'penalties' | 'messages' | 'setup'
const SECTION_KEY = 'wrb_rc_section'

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>
  )
}
const IconFlag = () => <Icon><path d="M4 22V4" /><path d="M4 4h12l-2 4 2 4H4" /></Icon>
const IconGavel = () => <Icon><path d="M14 13l-8.5 8.5a2.1 2.1 0 01-3-3L11 10" /><path d="M16 16l6-6" /><path d="M8 8l6-6" /><path d="M9 7l8 8" /><path d="M21 11l-8-8" /></Icon>
const IconChat = () => <Icon><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /></Icon>
const IconGear = () => <Icon><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" /></Icon>

/** Seek bar for replay playback: drag to skip anywhere in the recording. */
function ReplayTimeline({ source, onSeek, disabled }: {
  source: SourceStatus
  onSeek: (fraction: number) => void
  disabled?: boolean
}) {
  const t = useT()
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
        <span>{t('Replay timeline')}</span>
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
        aria-label={t('Seek replay position')}
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
      role="switch"
      aria-checked={checked}
      className="flex w-full items-start gap-3 rounded-xl bg-pit-850 p-3 text-left transition-colors hover:bg-pit-800 disabled:opacity-40"
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
