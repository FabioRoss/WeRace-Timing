import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { QRCodeSVG } from 'qrcode.react'
import { api } from '../lib/api'
import { useLive } from '../lib/useLive'
import { ToastStack, useToasts } from '../components/Toast'
import type { DriverRow, LapPoint, RaceMessage, Snapshot } from '../lib/types'
import { fmtClock, fmtGap, fmtLap } from '../lib/format'
import { fmtRemaining, useServerNow } from '../lib/lapProgress'
import { OrderToggle, useOrderMode } from '../components/OrderToggle'
import { TimingTable } from '../components/TimingTable'
import { TrackRing } from '../components/TrackRing'
import { PageHeader, RaceStrip } from '../components/StatusBar'
import { PenaltyLog } from '../components/PenaltyLog'
import { TeamStoryCard } from '../components/TeamStoryCard'
import type { TeamStoryConfig } from '../lib/teamStoryRender'
import { COMPARE_COLORS, GapEvolutionChart, LapTimeChart, SERIES_COLORS, type ChartSeries } from '../components/LapCharts'
import { CountBadge, Page, Panel, Segmented, Tabs, useIsDesktop } from '../components/ui'
import { useT } from '../lib/i18n'

interface TeamInfo {
  found: boolean
  kart_no?: string
  name?: string
  driver_url?: string
  messages?: RaceMessage[]
}

type TabId = 'standings' | 'analysis' | 'radio' | 'penalties' | 'share'
const TAB_KEY = 'wrb_team_tab'
const FRESH_MESSAGE_S = 45   // older messages are history: listed, not popped up

/**
 * Pit wall. Phones: the own-kart card stays on top and everything else lives
 * in tabs, so the standings are one tap away instead of 3,000px down. Desktop:
 * fixed columns. Penalties never get a panel that appears or disappears —
 * when race control holds them, their view says so in place.
 */
export function TeamDashboard() {
  const t = useT()
  const { slot = '1', token = '' } = useParams()
  const { snapshot, messages, status } = useLive(slot)
  const [info, setInfo] = useState<TeamInfo | null>(null)
  const [laps, setLaps] = useState<Record<string, LapPoint[]>>({})
  const [orderMode, setOrderMode] = useOrderMode()
  const serverNow = useServerNow(snapshot?.updated_at ?? 0, 1000)
  const desktop = useIsDesktop()
  const [tab, setTabState] = useState<TabId>(() => {
    const v = localStorage.getItem(TAB_KEY)
    return (['standings', 'analysis', 'radio', 'penalties', 'share'] as const).includes(v as TabId)
      ? (v as TabId) : 'standings'
  })
  const setTab = (v: TabId) => { setTabState(v); localStorage.setItem(TAB_KEY, v) }

  const kart = info?.found ? info.kart_no! : undefined

  // Resolve the token (retry while the kart isn't in the feed yet)
  useEffect(() => {
    let stop = false
    const load = async () => {
      try {
        const r = await api<TeamInfo>(`/e/${slot}/api/team/${token}`)
        if (!stop) setInfo(r)
        if (!stop && !r.found) setTimeout(load, 5000)
      } catch {
        if (!stop) setTimeout(load, 5000)
      }
    }
    void load()
    return () => { stop = true }
  }, [slot, token])

  // Neighbours in the running order: leader, kart ahead, kart behind.
  const rivals = useMemo(() => {
    const drivers = snapshot?.drivers ?? []
    const own = drivers.find((d) => d.kart_no === kart)
    if (!own) return { leader: undefined, ahead: undefined, behind: undefined }
    const idx = drivers.indexOf(own)
    return {
      leader: drivers[0]?.kart_no !== kart ? drivers[0] : undefined,
      ahead: idx > 0 ? drivers[idx - 1] : undefined,
      behind: drivers[idx + 1],
    }
  }, [snapshot, kart])

  // Up-to-3 comparison karts (from the ring or the table); each gets a compare
  // colour shared by the ring and the charts. The own kart is never a selection.
  const [selKarts, setSelKarts] = useState<string[]>([])
  const toggleKart = (k: string) => {
    if (k === kart) return
    setSelKarts((cur) =>
      cur.includes(k) ? cur.filter((x) => x !== k) : cur.length >= 3 ? cur : [...cur, k],
    )
  }
  const compareColors = useMemo(
    () => Object.fromEntries(selKarts.map((k, i) => [k, COMPARE_COLORS[i]])),
    [selKarts],
  )
  const ownIsLeader = !rivals.leader && !!kart          // no leader rival => own is P1
  const behindKart = rivals.behind?.kart_no

  // Poll lap history: own + leader + car behind + the selected comparisons
  const fetchKey = [kart, rivals.leader?.kart_no, behindKart, ...selKarts]
    .filter(Boolean).join(',')
  useEffect(() => {
    if (!kart) return
    const fetchLaps = () =>
      api<{ laps: Record<string, LapPoint[]> }>(
        `/e/${slot}/api/laps?karts=${encodeURIComponent(fetchKey)}`,
      ).then((r) => setLaps(r.laps)).catch(() => {})
    void fetchLaps()
    const timer = setInterval(fetchLaps, 10000)
    return () => clearInterval(timer)
  }, [slot, kart, fetchKey])

  // Lap-time chart: the team's own driver plus the selected comparison karts.
  const lapSeries: ChartSeries[] = useMemo(() => {
    if (!kart) return []
    const out: ChartSeries[] = []
    if (laps[kart]?.length)
      out.push({ key: kart, color: SERIES_COLORS.own, label: t('#{kart} (you)', { kart }), points: laps[kart], width: 3 })
    selKarts.forEach((k, i) => {
      if (laps[k]?.length) out.push({ key: k, color: COMPARE_COLORS[i], label: `#${k}`, points: laps[k] })
    })
    return out
  }, [kart, laps, selKarts, t])

  // Gap chart: everyone measured against the leader — or, when the team's own
  // driver IS the leader, against the own kart so the car behind is shown.
  const gap = useMemo(() => {
    if (!kart) return { reference: null, series: [] as ChartSeries[], title: undefined as string | undefined }
    const refKey = ownIsLeader ? kart : rivals.leader?.kart_no
    if (!refKey || !laps[refKey]?.length) return { reference: null, series: [], title: undefined }
    const out: ChartSeries[] = []
    const primaryKey = ownIsLeader ? behindKart : kart
    if (primaryKey && primaryKey !== refKey && laps[primaryKey]?.length) {
      out.push({
        key: primaryKey,
        color: SERIES_COLORS.own,
        label: ownIsLeader ? t('#{kart} behind', { kart: primaryKey }) : t('#{kart} (you)', { kart }),
        points: laps[primaryKey],
        width: 3,
      })
    }
    selKarts.forEach((k, i) => {
      if (k !== refKey && laps[k]?.length) out.push({ key: k, color: COMPARE_COLORS[i], label: `#${k}`, points: laps[k] })
    })
    return {
      reference: { key: refKey, label: `#${refKey}`, points: laps[refKey] },
      series: out,
      title: ownIsLeader ? t('Gap to you (s, + = behind)') : t('Gap to leader (s, + = behind)'),
    }
  }, [kart, laps, selKarts, ownIsLeader, rivals.leader?.kart_no, behindKart, t])

  const ownMessages = useMemo(() => {
    const initial = info?.messages ?? []
    const fromWs = messages.filter((m) => m.target == null || (kart && m.target.includes(kart)))
    const all = [...initial, ...fromWs]
    const unique = new Map(all.map((m) => [m.id, m]))
    return [...unique.values()].sort((a, b) => b.id - a.id).slice(0, 30)
  }, [info, messages, kart])

  // Pop-ups for messages sent to this team — only fresh ones. On every connect
  // the server replays its recent message log; that's history, not news, and
  // re-toasting it covered the screen with stale (urgent = sticky) alerts.
  const { toasts, push, dismiss } = useToasts()
  const skew = useRef<number | null>(null)
  useEffect(() => {
    if (snapshot?.server_ts) skew.current = Date.now() / 1000 - snapshot.server_ts
  }, [snapshot?.server_ts])
  const considered = useRef<Set<number>>(new Set())
  useEffect(() => {
    // The snapshot (server clock) arrives before the replay; wait for it and
    // for the kart, so nothing is judged without both.
    if (skew.current == null || !kart) return
    const serverNow = Date.now() / 1000 - skew.current
    for (const m of messages) {
      if (considered.current.has(m.id)) continue
      considered.current.add(m.id)
      const forUs = m.target == null || m.target.includes(kart)
      if (!forUs || serverNow - m.ts > FRESH_MESSAGE_S) continue
      push({
        kind: m.priority === 'warning' ? 'warning' : m.priority === 'urgent' ? 'penalty' : 'message',
        urgent: m.priority === 'urgent',
        title: m.sender === 'race_control' ? t('Race control') : t('Pit wall'),
        text: m.text,
      })
    }
  }, [messages, kart, push, t])

  // Penalties reach the team as a race-control message once their grace window
  // has passed (so staff can still retract a mistake) — that message is the one
  // pop-up. Watching the penalty list as well would double it, and fire early.
  const penalties = snapshot?.penalties
  const penaltiesHidden = !!snapshot?.hide_team_penalties

  const own = snapshot?.drivers.find((d) => d.kart_no === kart)
  const ownPenaltyCount = penaltiesHidden ? 0
    : (penalties ?? []).filter((p) => p.kart_no === kart && !(p.kind === 'time' && p.served)).length

  // Pit-stop planner (ring projection)
  const [pitSec, setPitSecState] = useState<number>(() => {
    const v = parseFloat(localStorage.getItem('wrb_pit_sec') ?? '')
    return Number.isFinite(v) && v > 0 ? v : 60
  })
  const setPitSec = (v: number) => {
    setPitSecState(v)
    localStorage.setItem('wrb_pit_sec', String(v))
  }
  const paceMs = useMemo(() => {
    const pts = (kart ? laps[kart] : undefined)?.filter((p) => !p.pit && p.ms > 0) ?? []
    if (pts.length >= 3) return pts.reduce((sum, p) => sum + p.ms, 0) / pts.length
    return own?.last_lap_ms ?? own?.best_lap_ms ?? null
  }, [laps, kart, own])
  const race = snapshot?.race
  const isRace = race?.session_kind === 'race'

  // ---------------------------------------------------------------- sections
  const standings = snapshot && kart && (
    <Panel
      title={t('Standings')}
      actions={isRace ? <OrderToggle mode={orderMode} onChange={setOrderMode} /> : undefined}
      bodyClass=""
    >
      <TimingTable
        snapshot={snapshot}
        highlightKart={kart}
        compact
        ring={false}
        orderMode={isRace ? orderMode : 'race'}
        selectable
        selectedKarts={selKarts}
        compareColors={compareColors}
        onToggleKart={toggleKart}
        showPenalties={!penaltiesHidden}
      />
    </Panel>
  )

  const trackPanel = snapshot && kart && (
    <Panel title={t('Track position')}>
      <TrackRing
        snapshot={snapshot}
        highlightKart={kart}
        relativeTo={kart}
        pitPlan={{ seconds: pitSec, paceMs }}
        selectedKarts={selKarts}
        compareColors={compareColors}
        onSelectKart={toggleKart}
      />
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        <label className="label-race" htmlFor="pit-sec">{t('Pit stop (s)')}</label>
        <input
          id="pit-sec"
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          value={pitSec}
          onChange={(e) => setPitSec(parseFloat(e.target.value) || 0)}
          className="field w-24"
        />
        <span className="text-xs text-ink-500">{t('tap karts to compare (up to 3)')}</span>
      </div>
      {selKarts.length > 0 && (
        <CompareList
          snapshot={snapshot}
          karts={[kart, ...selKarts]}
          ownKart={kart}
          colors={compareColors}
          onRemove={toggleKart}
        />
      )}
    </Panel>
  )

  const charts = (
    <div className="grid min-w-0 grid-cols-1 gap-4">
      <LapTimeChart series={lapSeries} fullSession />
      <GapEvolutionChart series={gap.series} reference={gap.reference} title={gap.title} fullSession />
    </div>
  )

  const composer = <Composer slot={slot} token={token} />

  const feed = (
    <Feed
      messages={ownMessages}
      snapshot={snapshot}
      kart={kart}
      hidden={penaltiesHidden}
      penaltyCount={ownPenaltyCount}
    />
  )

  const driverAccess = info?.driver_url && <DriverAccess url={info.driver_url} />
  const story = kart && (
    <TeamStoryCard
      snapshot={snapshot}
      kart={kart}
      config={(snapshot?.team_story_config ?? {}) as TeamStoryConfig}
    />
  )

  return (
    <Page className="pb-6">
      <ToastStack toasts={toasts} onDismiss={dismiss} />
      <PageHeader
        title={kart ? t('Pit Wall — Kart #{kart}', { kart }) : t('Pit Wall')}
        subtitle={[info?.name, race?.event_name, race?.track_name].filter(Boolean).join(' · ')}
      />
      <RaceStrip
        flag={race?.flag ?? 'none'}
        remaining={race ? fmtRemaining(race, serverNow) : '--:--'}
        best={snapshot?.session_best_ms ? fmtLap(snapshot.session_best_ms) : undefined}
        bestKart={snapshot?.session_best_kart}
        status={status}
      />

      {!info && <Notice>{t('Checking your link…')}</Notice>}
      {info && !info.found && <Notice>{t('Waiting for your kart to appear in the timing feed…')}</Notice>}

      {kart && (
        desktop ? (
          // Desktop: two fixed columns, so nothing in one column ever moves the other.
          <div className="grid grid-cols-12 gap-4 px-4 pt-4">
            <div className="col-span-8 flex min-w-0 flex-col gap-4">
              <OwnKart own={own} ahead={rivals.ahead} behind={rivals.behind} slot={slot} kart={kart}
                manualStint={snapshot?.auto_pitlane === false} serverNow={serverNow} />
              {standings}
              {charts}
            </div>
            <div className="col-span-4 flex min-w-0 flex-col gap-4">
              <Panel title={t('Message your driver')}>{composer}</Panel>
              {feed}
              {trackPanel}
              {driverAccess}
              {story}
            </div>
          </div>
        ) : (
          // Phones: own kart on top, the rest one tap away.
          <div style={{ ['--strip-h' as string]: '3.5rem' }}>
            <div className="px-3 pt-3">
              <OwnKart own={own} ahead={rivals.ahead} behind={rivals.behind} slot={slot} kart={kart}
                manualStint={snapshot?.auto_pitlane === false} serverNow={serverNow} />
            </div>
            <div className="mt-3">
              <Tabs<TabId>
                sticky
                value={tab}
                onChange={setTab}
                tabs={[
                  { id: 'standings', label: t('Standings') },
                  { id: 'analysis', label: t('Charts') },
                  { id: 'radio', label: t('Radio'), badge: <CountBadge n={ownMessages.length} /> },
                  {
                    id: 'penalties',
                    label: t('Penalties'),
                    badge: <CountBadge n={ownPenaltyCount} tone="bg-race-red text-white" />,
                  },
                  { id: 'share', label: t('Driver') },
                ]}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 px-3 pt-3">
              {tab === 'standings' && standings}
              {tab === 'analysis' && <>{trackPanel}{charts}</>}
              {tab === 'radio' && (
                <>
                  <Panel title={t('Message your driver')}>{composer}</Panel>
                  <Panel title={t('Message log')}>
                    <MessageList messages={ownMessages} />
                  </Panel>
                </>
              )}
              {tab === 'penalties' && (
                <Panel title={t('Your penalties & warnings')}>
                  <PenaltiesView snapshot={snapshot} kart={kart} hidden={penaltiesHidden} />
                </Panel>
              )}
              {tab === 'share' && <>{driverAccess}{story}</>}
            </div>
          </div>
        )
      )}
    </Page>
  )
}

function Notice({ children }: { children: ReactNode }) {
  return <div className="px-6 py-16 text-center text-ink-500">{children}</div>
}

/** The team's own kart: position, lap times, gaps, and who's around it. */
function OwnKart({ own, ahead, behind, slot, kart, manualStint, serverNow }: {
  own: DriverRow | undefined
  ahead: DriverRow | undefined
  behind: DriverRow | undefined
  slot: string
  kart: string
  manualStint: boolean
  serverNow: number
}) {
  const t = useT()
  const leader = own?.position === 1
  return (
    <section className="min-w-0 overflow-hidden rounded-2xl bg-gradient-to-br from-pit-850 to-pit-900 ring-1 ring-pit-700">
      <div className="flex items-center gap-4 px-4 pt-4">
        <div className="text-center">
          <div className="label-race">{t('Position')}</div>
          <div className="timing text-5xl font-extrabold leading-none text-race-blue">
            {own ? `P${own.position}` : '–'}
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="rounded-md bg-pit-700 px-2 py-0.5 timing text-sm font-bold">#{kart}</span>
            {own?.in_pit && <span className="rounded bg-race-yellow px-1.5 text-[0.65rem] font-bold text-pit-950">{t('PIT')}</span>}
          </div>
          <div className="mt-1 truncate text-lg font-bold">{own?.name || '—'}</div>
          <div className="text-xs text-ink-500 timing">
            {t('{n} laps', { n: own?.laps ?? 0 })} · {t('{n} pit', { n: own?.pits ?? 0 })}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-px bg-pit-800 mt-4">
        <Cell label={t('Last lap')} value={fmtLap(own?.last_lap_ms)} />
        <Cell label={t('Best')} value={fmtLap(own?.best_lap_ms)} tone="text-race-purple" />
        <Cell label={t('To leader')} value={leader ? t('LEADER') : fmtGap(own?.gap_leader)} />
      </div>

      {/* Who's around: the two numbers a pit wall watches most. */}
      <div className="grid grid-cols-2 gap-px bg-pit-800">
        <Neighbour dir="ahead" kart={ahead} gap={leader ? '' : fmtGap(own?.gap_ahead)} />
        <Neighbour dir="behind" kart={behind} gap={behind ? fmtGap(behind.gap_ahead) : ''} />
      </div>

      <div className="bg-pit-900 px-4 py-3">
        {manualStint ? (
          <ManualStint slot={slot} kart={kart} serverNow={serverNow} />
        ) : (
          <div className="flex items-baseline justify-between">
            <span className="label-race">{t('Stint')}</span>
            <span className="timing text-xl font-bold">
              {own?.stint_seconds != null ? fmtClock(own.stint_seconds) : '--:--'}
            </span>
          </div>
        )}
      </div>
    </section>
  )
}

function Cell({ label, value, tone = '' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0 bg-pit-900 px-3 py-2.5">
      <div className="label-race truncate">{label}</div>
      <div className={`timing truncate text-lg font-bold leading-tight ${tone}`}>{value}</div>
    </div>
  )
}

function Neighbour({ dir, kart, gap }: { dir: 'ahead' | 'behind'; kart: DriverRow | undefined; gap: string }) {
  const t = useT()
  const up = dir === 'ahead'
  return (
    <div className={`min-w-0 bg-pit-900 px-3 py-2.5 ${up ? '' : 'text-right'}`}>
      <div className="label-race">{up ? `▲ ${t('Ahead')}` : `${t('Behind')} ▼`}</div>
      {kart ? (
        <>
          <div className={`timing text-lg font-bold leading-tight ${up ? 'text-race-green' : 'text-race-red'}`}>
            {gap || '—'}
          </div>
          <div className="truncate text-xs text-ink-300">
            <span className="timing font-bold">#{kart.kart_no}</span> {kart.name}
          </div>
        </>
      ) : (
        <div className="timing text-lg font-bold leading-tight text-ink-500">—</div>
      )}
    </div>
  )
}

/** Selected comparison karts with their last/best laps. */
function CompareList({ snapshot, karts, ownKart, colors, onRemove }: {
  snapshot: Snapshot
  karts: string[]
  ownKart: string
  colors: Record<string, string>
  onRemove: (k: string) => void
}) {
  const t = useT()
  const rows = karts
    .map((k) => snapshot.drivers.find((d) => d.kart_no === k))
    .filter((d): d is DriverRow => Boolean(d))
  const fastestLast = Math.min(...rows.map((d) => d.last_lap_ms || Infinity))
  const fastestBest = Math.min(...rows.map((d) => d.best_lap_ms || Infinity))
  return (
    <div className="mt-3 grid grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] items-center gap-x-2 gap-y-1 rounded-xl bg-pit-850 p-3 text-xs">
      {rows.map((d) => {
        const color = d.kart_no === ownKart ? 'var(--color-race-green)' : colors[d.kart_no]
        const bestLast = !!d.last_lap_ms && d.last_lap_ms === fastestLast
        const bestBest = !!d.best_lap_ms && d.best_lap_ms === fastestBest
        return (
          <Fragment key={d.kart_no}>
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />
            <span className="min-w-0 truncate">
              <span className="font-bold">#{d.kart_no}</span> {d.name}
            </span>
            <span className={`timing whitespace-nowrap ${bestLast ? 'font-bold text-ink-100' : 'text-ink-300'}`}
              title={t('Last lap')}>{fmtLap(d.last_lap_ms)}</span>
            <span className={`timing whitespace-nowrap ${bestBest ? 'font-bold text-race-purple' : 'text-ink-300'}`}
              title={t('Best lap')}>{fmtLap(d.best_lap_ms)}</span>
            {d.kart_no === ownKart ? <span /> : (
              <button type="button" onClick={() => onRemove(d.kart_no)}
                className="rounded px-1.5 text-ink-500 hover:text-ink-100" aria-label={t('Remove')}>✕</button>
            )}
          </Fragment>
        )
      })}
    </div>
  )
}

/** Quick presets + free text to the driver's screen. */
function Composer({ slot, token }: { slot: string; token: string }) {
  const t = useT()
  const [text, setText] = useState('')
  const [priority, setPriority] = useState<'info' | 'warning' | 'urgent'>('info')
  const [sendState, setSendState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')

  const send = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!text.trim()) return
    setSendState('sending')
    try {
      await api(`/e/${slot}/api/team/${token}/message`, { body: { text: text.trim(), priority } })
      setText('')
      setSendState('sent')
      setTimeout(() => setSendState('idle'), 2000)
    } catch {
      setSendState('error')
    }
  }

  return (
    <form onSubmit={send} className="space-y-3">
      {/* One swipeable row of presets instead of a wrapping block. */}
      <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 lg:mx-0 lg:flex-wrap lg:overflow-visible lg:px-0">
        {(['Box this lap', 'Box in 2 laps', 'Push now', 'Save fuel', 'OK, stay out'] as const).map((preset) => (
          <button key={preset} type="button" onClick={() => setText(t(preset))} className="chip">
            {t(preset)}
          </button>
        ))}
      </div>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={300}
        placeholder={t('Type a message…')}
        className="field"
        enterKeyHint="send"
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
        <button type="submit" disabled={sendState === 'sending' || !text.trim()} className="btn btn-primary ml-auto">
          {t('Send')}
        </button>
      </div>
      <p className={`min-h-4 text-xs ${sendState === 'error' ? 'text-race-red' : 'text-race-green'}`} aria-live="polite">
        {sendState === 'sent' && t('Delivered to the driver dashboard.')}
        {sendState === 'error' && t('Send failed — is the kart still in the feed?')}
      </p>
    </form>
  )
}

function MessageList({ messages }: { messages: RaceMessage[] }) {
  const t = useT()
  if (messages.length === 0) return <p className="text-sm text-ink-500">{t('No messages yet.')}</p>
  return (
    <ul className="space-y-2 text-sm">
      {messages.map((m) => (
        <li key={m.id} className={`rounded-lg bg-pit-850 px-3 py-2 ring-1 ${
          m.priority === 'urgent' ? 'ring-race-red/50' : m.priority === 'warning' ? 'ring-race-yellow/40' : 'ring-transparent'
        }`}>
          <div className="mb-0.5 flex items-center justify-between gap-2 text-[0.65rem] font-bold uppercase tracking-wider">
            <span className={m.sender === 'race_control' ? 'text-race-yellow' : 'text-race-blue'}>
              {m.sender === 'race_control' ? t('Race control') : t('Pit wall')}
            </span>
            <span className="timing font-normal text-ink-500">
              {new Date(m.ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
          {m.text}
        </li>
      ))}
    </ul>
  )
}

/** Own + field penalties, or an in-place note while race control holds them. */
function PenaltiesView({ snapshot, kart, hidden }: { snapshot: Snapshot | null; kart: string; hidden: boolean }) {
  const t = useT()
  if (hidden) {
    return (
      <p className="rounded-xl bg-pit-850 px-4 py-6 text-center text-sm text-ink-500">
        {t('Race control publishes penalties after review. They will appear here.')}
      </p>
    )
  }
  return (
    <div className="space-y-4">
      <PenaltyLog penalties={snapshot?.penalties ?? []} filterKart={kart} empty={t('None — clean so far.')} />
      <div>
        <h3 className="label-race mb-2">{t('All penalties & warnings')}</h3>
        <PenaltyLog penalties={snapshot?.penalties ?? []} />
      </div>
    </div>
  )
}

/**
 * Desktop feed: messages and penalties share one fixed-height box behind a
 * switch, so publishing or holding penalties never changes the page layout.
 */
function Feed({ messages, snapshot, kart, hidden, penaltyCount }: {
  messages: RaceMessage[]
  snapshot: Snapshot | null
  kart: string | undefined
  hidden: boolean
  penaltyCount: number
}) {
  const t = useT()
  const [view, setView] = useState<'messages' | 'penalties'>('messages')
  return (
    <Panel
      title={t('Race feed')}
      actions={
        <Segmented
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: 'messages', label: <span className="inline-flex items-center gap-1">{t('Messages')}<CountBadge n={messages.length} /></span> },
            { value: 'penalties', label: <span className="inline-flex items-center gap-1">{t('Penalties')}<CountBadge n={penaltyCount} tone="bg-race-red text-white" /></span> },
          ]}
        />
      }
    >
      <div className="h-72 overflow-y-auto pr-1">
        {view === 'messages'
          ? <MessageList messages={messages} />
          : kart && <PenaltiesView snapshot={snapshot} kart={kart} hidden={hidden} />}
      </div>
    </Panel>
  )
}

function DriverAccess({ url }: { url: string }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <Panel title={t('Driver dashboard access')}>
      <div className="flex items-center gap-4">
        <div className="shrink-0 rounded-lg bg-white p-2">
          <QRCodeSVG value={url} size={104} className="h-auto max-w-full" />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm text-ink-300">{t('Scan with the driver\'s phone, mount it in landscape.')}</p>
          <p className="break-all text-[0.7rem] text-ink-500">{url}</p>
          <button type="button" onClick={copy} className="btn btn-quiet">
            {copied ? t('Copied') : t('Copy link')}
          </button>
        </div>
      </div>
    </Panel>
  )
}

/** Manual stint timer for venues with no pit-lane gates: the team manager
 *  starts/stops/resets it and can nudge it if they reacted late. Persisted per
 *  kart so a page reload keeps counting. */
interface StintState { running: boolean; anchor: number | null; acc: number }

function ManualStint({ slot, kart, serverNow }: { slot: string; kart: string; serverNow: number }) {
  const t = useT()
  const key = `wrb_stint_${slot}_${kart}`
  const [st, setSt] = useState<StintState>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(key) ?? '')
      if (v && typeof v.acc === 'number') return v
    } catch { /* no saved state */ }
    return { running: false, anchor: null, acc: 0 }
  })
  useEffect(() => { localStorage.setItem(key, JSON.stringify(st)) }, [key, st])

  const elapsed = Math.max(0, st.acc + (st.running && st.anchor ? serverNow - st.anchor : 0))
  const start = () => setSt((s) => s.running ? s : { running: true, anchor: serverNow, acc: s.acc })
  const stop = () => setSt((s) => s.running && s.anchor ? { running: false, anchor: null, acc: s.acc + (serverNow - s.anchor) } : s)
  const reset = () => setSt({ running: false, anchor: null, acc: 0 })
  const nudge = (d: number) => setSt((s) => ({ ...s, acc: Math.max(0, s.acc + d) }))

  const btn = 'rounded-lg bg-pit-700 px-2.5 py-1.5 text-xs font-bold hover:bg-pit-600'
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div>
        <div className="label-race">{t('Stint (manual)')}</div>
        <div className={`timing text-xl font-bold ${st.running ? 'text-race-green' : ''}`}>{fmtClock(Math.round(elapsed))}</div>
      </div>
      <div className="ml-auto flex flex-wrap gap-1.5">
        {st.running
          ? <button type="button" onClick={stop} className={`${btn} text-race-yellow`}>{t('Stop')}</button>
          : <button type="button" onClick={start} className={`${btn} text-race-green`}>{t('Start')}</button>}
        <button type="button" onClick={reset} className={btn}>{t('Reset')}</button>
        <button type="button" onClick={() => nudge(-30)} className={btn}>−30s</button>
        <button type="button" onClick={() => nudge(30)} className={btn}>+30s</button>
      </div>
    </div>
  )
}
