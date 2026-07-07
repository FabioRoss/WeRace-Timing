import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { QRCodeSVG } from 'qrcode.react'
import { api } from '../lib/api'
import { useLive } from '../lib/useLive'
import type { LapPoint, RaceMessage } from '../lib/types'
import { fmtGap, fmtLap } from '../lib/format'
import { FlagBanner } from '../components/FlagBanner'
import { OrderToggle, useOrderMode } from '../components/OrderToggle'
import { TimingTable } from '../components/TimingTable'
import { ConnectionDot, PageHeader } from '../components/StatusBar'
import { GapEvolutionChart, LapTimeChart, type ChartSeries } from '../components/LapCharts'

interface TeamInfo {
  found: boolean
  kart_no?: string
  name?: string
  driver_url?: string
  messages?: RaceMessage[]
}

export function TeamDashboard() {
  const { slot = '1', token = '' } = useParams()
  const { snapshot, messages, status } = useLive(slot)
  const [info, setInfo] = useState<TeamInfo | null>(null)
  const [laps, setLaps] = useState<Record<string, LapPoint[]>>({})
  const [text, setText] = useState('')
  const [priority, setPriority] = useState<'info' | 'warning' | 'urgent'>('info')
  const [sendState, setSendState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [orderMode, setOrderMode] = useOrderMode()

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

  // Poll lap history for the karts on the charts
  useEffect(() => {
    if (!kart) return
    const karts = [kart, rivals.leader?.kart_no, rivals.ahead?.kart_no, rivals.behind?.kart_no]
      .filter((k): k is string => Boolean(k))
    const fetchLaps = () =>
      api<{ laps: Record<string, LapPoint[]> }>(
        `/e/${slot}/api/laps?karts=${encodeURIComponent(karts.join(','))}`,
      ).then((r) => setLaps(r.laps)).catch(() => {})
    void fetchLaps()
    const t = setInterval(fetchLaps, 10000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slot, kart, rivals.leader?.kart_no, rivals.ahead?.kart_no, rivals.behind?.kart_no])

  const series: ChartSeries[] = useMemo(() => {
    if (!kart) return []
    const make = (k: string | undefined, role: ChartSeries['role'], label: string) =>
      k && laps[k]?.length ? [{ key: k, role, label, points: laps[k] }] : []
    return [
      ...make(kart, 'own', `#${kart} (you)`),
      ...make(rivals.leader?.kart_no, 'leader', `#${rivals.leader?.kart_no} P1`),
      ...(rivals.ahead && rivals.ahead.kart_no !== rivals.leader?.kart_no
        ? make(rivals.ahead.kart_no, 'ahead', `#${rivals.ahead.kart_no} ahead`)
        : []),
      ...make(rivals.behind?.kart_no, 'behind', `#${rivals.behind?.kart_no} behind`),
    ]
  }, [kart, laps, rivals])

  const ownMessages = useMemo(() => {
    const initial = info?.messages ?? []
    const fromWs = messages.filter((m) => m.target == null || (kart && m.target.includes(kart)))
    const all = [...initial, ...fromWs]
    const unique = new Map(all.map((m) => [m.id, m]))
    return [...unique.values()].sort((a, b) => b.id - a.id).slice(0, 20)
  }, [info, messages, kart])

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
  const race = snapshot?.race

  return (
    <div className="mx-auto flex min-h-full max-w-7xl flex-col">
      <PageHeader
        title={kart ? `Pit Wall — Kart #${kart}` : 'Pit Wall'}
        subtitle={[info?.name, race?.event_name, race?.track_name].filter(Boolean).join(' · ')}
        right={
          <>
            <div className="hidden text-right sm:block">
              <div className="label-race">Remaining</div>
              <div className="timing font-bold">{race?.time_to_go || '--:--'}</div>
            </div>
            <FlagBanner flag={race?.flag ?? 'none'} compact />
            <ConnectionDot status={status} />
          </>
        }
      />

      {!info && <div className="p-10 text-center text-ink-500">Checking your link…</div>}
      {info && !info.found && (
        <div className="p-10 text-center text-ink-500">
          Waiting for your kart to appear in the timing feed…
        </div>
      )}

      {kart && (
        <div className="grid gap-4 p-4 lg:grid-cols-3">
          {/* Own kart summary */}
          <div className="rounded-xl bg-pit-900 p-4 ring-1 ring-pit-800 lg:col-span-2">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Position" value={own ? `P${own.position}` : '–'} big />
              <Stat label="Last lap" value={fmtLap(own?.last_lap_ms)} />
              <Stat label="Best lap" value={fmtLap(own?.best_lap_ms)} />
              <Stat label="Gap to leader" value={own?.position === 1 ? 'LEADER' : fmtGap(own?.gap_leader)} />
              <Stat label="Interval ahead" value={own?.position === 1 ? '—' : fmtGap(own?.gap_ahead)} />
              <Stat label="Stint" value={own?.stint_time || '--:--'} />
              <Stat label="Laps" value={String(own?.laps ?? '–')} />
              <Stat label="Pit stops" value={String(own?.pits ?? '–')} />
            </div>
          </div>

          {/* Driver link + QR */}
          <div className="rounded-xl bg-pit-900 p-4 ring-1 ring-pit-800">
            <h3 className="label-race mb-3">Driver dashboard access</h3>
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
                  Copy link
                </button>
              </div>
            </div>
          </div>

          {/* Message composer */}
          <div className="rounded-xl bg-pit-900 p-4 ring-1 ring-pit-800 lg:col-span-2">
            <h3 className="label-race mb-3">Message your driver</h3>
            <form onSubmit={send} className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {(['Box this lap', 'Box in 2 laps', 'Push now', 'Save fuel', 'OK, stay out'] as const).map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setText(preset)}
                    className="rounded-full bg-pit-700 px-3 py-1 text-xs hover:bg-pit-600"
                  >
                    {preset}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <input
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  maxLength={300}
                  placeholder="Type a message…"
                  className="min-w-0 flex-1 basis-48 rounded bg-pit-950 px-3 py-2 outline-none ring-1 ring-pit-600 focus:ring-race-blue"
                />
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as typeof priority)}
                  className="rounded bg-pit-950 px-2 py-2 ring-1 ring-pit-600"
                >
                  <option value="info">Info</option>
                  <option value="warning">Warning</option>
                  <option value="urgent">Urgent</option>
                </select>
                <button
                  type="submit"
                  disabled={sendState === 'sending' || !text.trim()}
                  className="rounded bg-race-blue px-4 py-2 font-bold uppercase tracking-wider disabled:opacity-40 hover:brightness-110"
                >
                  Send
                </button>
              </div>
              {sendState === 'sent' && <p className="text-xs text-race-green">Delivered to the driver dashboard.</p>}
              {sendState === 'error' && <p className="text-xs text-race-red">Send failed — is the kart still in the feed?</p>}
            </form>
          </div>

          {/* Message log */}
          <div className="rounded-xl bg-pit-900 p-4 ring-1 ring-pit-800">
            <h3 className="label-race mb-3">Message log</h3>
            <ul className="max-h-48 space-y-2 overflow-y-auto text-sm">
              {ownMessages.length === 0 && <li className="text-ink-500">No messages yet.</li>}
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

          {/* Analysis charts */}
          <div className="lg:col-span-3 grid gap-4 lg:grid-cols-2">
            <LapTimeChart series={series} />
            <GapEvolutionChart series={series} />
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
                orderMode={snapshot.race.session_kind === 'race' ? orderMode : 'race'}
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
