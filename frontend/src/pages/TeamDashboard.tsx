import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { QRCodeSVG } from 'qrcode.react'
import { api } from '../lib/api'
import { useLive } from '../lib/useLive'
import { ToastStack, useToasts } from '../components/Toast'
import { penaltyKindLabel, penaltyLabel } from '../lib/penalties'
import type { DriverRow, LapPoint, RaceMessage } from '../lib/types'
import { fmtClock, fmtGap, fmtLap } from '../lib/format'
import { FlagBanner } from '../components/FlagBanner'
import { fmtRemaining, useServerNow } from '../lib/lapProgress'
import { OrderToggle, useOrderMode } from '../components/OrderToggle'
import { TimingTable } from '../components/TimingTable'
import { TrackRing } from '../components/TrackRing'
import { ConnectionDot, PageHeader } from '../components/StatusBar'
import { PenaltyLog } from '../components/PenaltyLog'
import { TeamStoryCard } from '../components/TeamStoryCard'
import type { TeamStoryConfig } from '../lib/teamStoryRender'
import { COMPARE_COLORS, GapEvolutionChart, LapTimeChart, SERIES_COLORS, type ChartSeries } from '../components/LapCharts'
import { useT } from '../lib/i18n'

interface TeamInfo {
  found: boolean
  kart_no?: string
  name?: string
  driver_url?: string
  messages?: RaceMessage[]
}

export function TeamDashboard() {
  const t = useT()
  const { slot = '1', token = '' } = useParams()
  const { snapshot, messages, status } = useLive(slot)
  const [info, setInfo] = useState<TeamInfo | null>(null)
  const [laps, setLaps] = useState<Record<string, LapPoint[]>>({})
  const [text, setText] = useState('')
  const [priority, setPriority] = useState<'info' | 'warning' | 'urgent'>('info')
  const [sendState, setSendState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [orderMode, setOrderMode] = useOrderMode()
  const serverNow = useServerNow(snapshot?.updated_at ?? 0, 1000)

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

  // Identify rivals: leader, kart ahead, kart behind
  const rivals = useMemo(() => {
    const drivers = snapshot?.drivers ?? []
    const own = drivers.find((d) => d.kart_no === kart)
    if (!own) return { leader: undefined, ahead: undefined, behind: undefined }
    const idx = drivers.indexOf(own)
    return {
      leader: drivers[0]?.kart_no !== kart ? drivers[0] : undefined,
      ahead: idx > 0 && idx - 1 !== 0 ? drivers[idx - 1] : idx > 0 ? drivers[idx - 1] : undefined,
      behind: drivers[idx + 1],
    }
  }, [snapshot, kart])

  // Up-to-3 comparison karts selected on the ring; each gets a compare color
  // shared between the ring and the charts. Own kart is never a selection.
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
    const t = setInterval(fetchLaps, 10000)
    return () => clearInterval(t)
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
    return [...unique.values()].sort((a, b) => b.id - a.id).slice(0, 20)
  }, [info, messages, kart])

  // Pop-up notifications for anything sent to this team. "Seen" ids are seeded on
  // first data so pre-existing items don't fire; only fresh ones toast.
  const { toasts, push, dismiss } = useToasts()
  const seenMsg = useRef<Set<number> | null>(null)
  const seenPen = useRef<Set<number> | null>(null)

  useEffect(() => {
    if (seenMsg.current === null) {
      seenMsg.current = new Set(messages.map((m) => m.id))
      return
    }
    for (const m of messages) {
      if (seenMsg.current.has(m.id)) continue
      seenMsg.current.add(m.id)
      const forUs = m.target == null || (kart != null && m.target.includes(kart))
      if (!forUs) continue
      push({
        kind: m.priority === 'warning' ? 'warning' : 'message',
        urgent: m.priority === 'urgent',
        title: m.sender === 'race_control' ? 'Race Control' : 'Pit wall',
        text: m.text,
      })
    }
  }, [messages, kart, push])

  const penalties = snapshot?.penalties
  const penaltiesHidden = snapshot?.hide_team_penalties
  useEffect(() => {
    if (!kart) return
    const mine = (penalties ?? []).filter((p) => p.kart_no === kart)
    if (seenPen.current === null) {
      seenPen.current = new Set(mine.map((p) => p.id))
      return
    }
    for (const p of mine) {
      if (seenPen.current.has(p.id)) continue
      seenPen.current.add(p.id)
      if (penaltiesHidden) continue   // race control is holding penalties from teams
      const isWarn = p.kind === 'warning'
      push({
        kind: isWarn ? 'warning' : 'penalty',
        urgent: !isWarn,
        title: penaltyKindLabel(p),
        text: [penaltyLabel(p), p.reason].filter(Boolean).join(' — '),
      })
    }
  }, [penalties, penaltiesHidden, kart, push])

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

  const own = snapshot?.drivers.find((d) => d.kart_no === kart)

  // Pit-stop planner + ring kart selection
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

  return (
    <div className="mx-auto flex min-h-full max-w-7xl flex-col">
      <ToastStack toasts={toasts} onDismiss={dismiss} />
      <PageHeader
        title={kart ? t('Pit Wall — Kart #{kart}', { kart }) : t('Pit Wall')}
        subtitle={[info?.name, race?.event_name, race?.track_name].filter(Boolean).join(' · ')}
        right={
          <>
            <div className="hidden text-right sm:block">
              <div className="label-race">{t('Remaining')}</div>
              <div className="timing font-bold">
                {race ? fmtRemaining(race, serverNow) : '--:--'}
              </div>
            </div>
            <FlagBanner flag={race?.flag ?? 'none'} compact />
            <ConnectionDot status={status} />
          </>
        }
      />

      {!info && <div className="p-10 text-center text-ink-500">{t('Checking your link…')}</div>}
      {info && !info.found && (
        <div className="p-10 text-center text-ink-500">
          {t('Waiting for your kart to appear in the timing feed…')}
        </div>
      )}

      {kart && (
        <div className="grid gap-4 p-4 lg:grid-cols-3">
          {/* Own kart summary */}
          <div className="rounded-xl bg-pit-900 p-4 ring-1 ring-pit-800 lg:col-span-2">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label={t('Position')} value={own ? `P${own.position}` : '–'} big />
              <Stat label={t('Last lap')} value={fmtLap(own?.last_lap_ms)} />
              <Stat label={t('Best lap')} value={fmtLap(own?.best_lap_ms)} />
              <Stat label={t('Gap to leader')} value={own?.position === 1 ? t('LEADER') : fmtGap(own?.gap_leader)} />
              <Stat label={t('Interval ahead')} value={own?.position === 1 ? '—' : fmtGap(own?.gap_ahead)} />
              {snapshot?.auto_pitlane === false && kart ? (
                <ManualStint slot={slot} kart={kart} serverNow={serverNow} />
              ) : (
                <Stat label={t('Stint')} value={own?.stint_seconds != null ? fmtClock(own.stint_seconds) : '--:--'} />
              )}
              <Stat label={t('Laps')} value={String(own?.laps ?? '–')} />
              <Stat label={t('Pit stops')} value={String(own?.pits ?? '–')} />
            </div>
          </div>

          {/* Shareable team-story graphic (staff-configured, team just downloads) */}
          {kart && (
            <TeamStoryCard
              snapshot={snapshot}
              kart={kart}
              config={(snapshot?.team_story_config ?? {}) as TeamStoryConfig}
            />
          )}

          {/* Driver link + QR */}
          <div className="rounded-xl bg-pit-900 p-4 ring-1 ring-pit-800">
            <h3 className="label-race mb-3">{t('Driver dashboard access')}</h3>
            <div className="flex items-center gap-4">
              {info?.driver_url && (
                <div className="shrink-0 rounded bg-white p-2">
                  <QRCodeSVG value={info.driver_url} size={96} className="h-auto max-w-full" />
                </div>
              )}
              <div className="min-w-0 flex-1 space-y-2">
                <p className="break-all text-xs text-ink-500">{info?.driver_url}</p>
                <button
                  type="button"
                  onClick={() => info?.driver_url && navigator.clipboard?.writeText(info.driver_url)}
                  className="rounded bg-pit-700 px-3 py-1.5 text-xs font-bold uppercase tracking-wider hover:bg-pit-600"
                >
                  {t('Copy link')}
                </button>
              </div>
            </div>
          </div>

          {/* Message composer */}
          <div className="rounded-xl bg-pit-900 p-4 ring-1 ring-pit-800 lg:col-span-2">
            <h3 className="label-race mb-3">{t('Message your driver')}</h3>
            <form onSubmit={send} className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {(['Box this lap', 'Box in 2 laps', 'Push now', 'Save fuel', 'OK, stay out'] as const).map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setText(t(preset))}
                    className="rounded-full bg-pit-700 px-3 py-1 text-xs hover:bg-pit-600"
                  >
                    {t(preset)}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  maxLength={300}
                  placeholder={t('Type a message…')}
                  className="min-w-0 flex-1 basis-48 rounded bg-pit-950 px-3 py-2 outline-none ring-1 ring-pit-600 focus:ring-race-blue"
                />
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as typeof priority)}
                  className="rounded bg-pit-950 px-2 py-2 ring-1 ring-pit-600"
                >
                  <option value="info">{t('Info')}</option>
                  <option value="warning">{t('Warning')}</option>
                  <option value="urgent">{t('Urgent')}</option>
                </select>
                <button
                  type="submit"
                  disabled={sendState === 'sending' || !text.trim()}
                  className="rounded bg-race-blue px-4 py-2 font-bold uppercase tracking-wider disabled:opacity-40 hover:brightness-110"
                >
                  {t('Send')}
                </button>
              </div>
              {sendState === 'sent' && <p className="text-xs text-race-green">{t('Delivered to the driver dashboard.')}</p>}
              {sendState === 'error' && <p className="text-xs text-race-red">{t('Send failed — is the kart still in the feed?')}</p>}
            </form>
          </div>

          {/* Message log */}
          <div className="rounded-xl bg-pit-900 p-4 ring-1 ring-pit-800">
            <h3 className="label-race mb-3">{t('Message log')}</h3>
            <ul className="max-h-48 space-y-2 overflow-y-auto text-sm">
              {ownMessages.length === 0 && <li className="text-ink-500">{t('No messages yet.')}</li>}
              {ownMessages.map((m) => (
                <li key={m.id} className="rounded bg-pit-850 px-3 py-2">
                  <span className={`mr-2 text-[0.6rem] font-bold uppercase ${
                    m.sender === 'race_control' ? 'text-race-yellow' : 'text-race-blue'
                  }`}>
                    {m.sender === 'race_control' ? 'RC' : 'PIT'}
                  </span>
                  {m.text}
                </li>
              ))}
            </ul>
          </div>

          {/* Penalties & warnings — hidden when race control opts to (e.g. until
              penalties are official). */}
          {!snapshot?.hide_team_penalties && (
            <>
              <div className="rounded-xl bg-pit-900 p-4 ring-1 ring-pit-800">
                <h3 className="label-race mb-3">{t('Your penalties & warnings')}</h3>
                <PenaltyLog
                  penalties={snapshot?.penalties ?? []}
                  filterKart={kart}
                  empty={t('None — clean so far.')}
                />
              </div>

              <div className="rounded-xl bg-pit-900 p-4 ring-1 ring-pit-800 lg:col-span-2">
                <h3 className="label-race mb-3">{t('All penalties & warnings')}</h3>
                <PenaltyLog penalties={snapshot?.penalties ?? []} />
              </div>
            </>
          )}

          {/* Analysis: track position ring + charts */}
          <div className="lg:col-span-3 grid gap-4 lg:grid-cols-3">
            <div className="rounded-xl bg-pit-900 p-4 ring-1 ring-pit-800">
              <h3 className="label-race mb-3">{t('Track position')}</h3>
              {snapshot && (
                <TrackRing
                  snapshot={snapshot}
                  highlightKart={kart}
                  relativeTo={kart}
                  pitPlan={{ seconds: pitSec, paceMs }}
                  selectedKarts={selKarts}
                  compareColors={compareColors}
                  onSelectKart={toggleKart}
                />
              )}
              <div className="mt-3 flex items-center gap-2 text-sm">
                <label className="label-race" htmlFor="pit-sec">{t('Pit stop (s)')}</label>
                <input
                  id="pit-sec"
                  type="number"
                  min={0}
                  step={1}
                  value={pitSec}
                  onChange={(e) => setPitSec(parseFloat(e.target.value) || 0)}
                  className="w-20 rounded bg-pit-950 px-2 py-1 ring-1 ring-pit-600"
                />
                <span className="text-xs text-ink-500">
                  {t('tap karts to compare (up to 3)')}
                </span>
              </div>
              {selKarts.length > 0 && snapshot && (() => {
                const rows = [kart, ...selKarts]
                  .map((k) => snapshot.drivers.find((d) => d.kart_no === k))
                  .filter((d): d is DriverRow => Boolean(d))
                const fastestLast = Math.min(...rows.map((d) => d.last_lap_ms || Infinity))
                const fastestBest = Math.min(...rows.map((d) => d.best_lap_ms || Infinity))
                return (
                  <div className="mt-3 grid grid-cols-[auto_1fr_auto_auto_auto] items-center gap-x-2 gap-y-1.5 rounded-lg bg-pit-850 p-3 text-xs">
                    {rows.map((d) => {
                      const color = d.kart_no === kart ? 'var(--color-race-green)' : compareColors[d.kart_no]
                      const bestLast = !!d.last_lap_ms && d.last_lap_ms === fastestLast
                      const bestBest = !!d.best_lap_ms && d.best_lap_ms === fastestBest
                      return (
                        <Fragment key={d.kart_no}>
                          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />
                          <span className="min-w-0 truncate">
                            <span className="font-bold">#{d.kart_no}</span> {d.name}
                          </span>
                          <span className="flex items-center gap-1 whitespace-nowrap timing">
                            <ClockIcon />
                            <span className={bestLast ? 'font-bold text-ink-100' : 'text-ink-300'}>{fmtLap(d.last_lap_ms)}</span>
                          </span>
                          <span className="flex items-center gap-1 whitespace-nowrap timing">
                            <BestIcon />
                            <span className={bestBest ? 'font-bold text-race-purple' : 'text-ink-300'}>{fmtLap(d.best_lap_ms)}</span>
                          </span>
                          {d.kart_no === kart ? (
                            <span />
                          ) : (
                            <button type="button" onClick={() => toggleKart(d.kart_no)} className="text-ink-500 hover:text-ink-300">✕</button>
                          )}
                        </Fragment>
                      )
                    })}
                  </div>
                )
              })()}
            </div>
            <div className="grid content-start gap-4 lg:col-span-2">
              <LapTimeChart series={lapSeries} />
              <GapEvolutionChart series={gap.series} reference={gap.reference} title={gap.title} />
            </div>
          </div>

          {/* Full standings */}
          <div className="lg:col-span-3 rounded-xl bg-pit-900 ring-1 ring-pit-800">
            {snapshot?.race.session_kind === 'race' && (
              <div className="flex justify-end px-3 pt-3">
                <OrderToggle mode={orderMode} onChange={setOrderMode} />
              </div>
            )}
            {snapshot && (
              <TimingTable
                snapshot={snapshot}
                highlightKart={kart}
                compact
                ring={false}
                orderMode={snapshot.race.session_kind === 'race' ? orderMode : 'race'}
                selectable
                selectedKarts={selKarts}
                compareColors={compareColors}
                onToggleKart={toggleKart}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, big = false }: { label: string; value: string; big?: boolean }) {
  return (
    <div>
      <div className="label-race">{label}</div>
      <div className={`timing font-bold ${big ? 'text-3xl text-race-blue' : 'text-xl'}`}>{value}</div>
    </div>
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

  const btn = 'rounded bg-pit-700 px-1.5 py-0.5 text-[0.65rem] font-bold hover:bg-pit-600'
  return (
    <div className="col-span-2">
      <div className="label-race">{t('Stint (manual)')}</div>
      <div className="timing text-xl font-bold">{fmtClock(Math.round(elapsed))}</div>
      <div className="mt-1 flex flex-wrap gap-1">
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

/** Last-lap marker */
function ClockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-ink-500">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}

/** Best-lap marker: arrow to the top */
function BestIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-race-purple">
      <path d="M5 4h14" />
      <path d="M12 20V9" />
      <path d="M7 13l5-5 5 5" />
    </svg>
  )
}
