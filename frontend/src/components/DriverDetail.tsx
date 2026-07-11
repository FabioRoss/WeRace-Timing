import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import type { LapPoint, Snapshot } from '../lib/types'
import { fmtClock, fmtLap } from '../lib/format'
import { LapTimeChart, SERIES_COLORS } from './LapCharts'

interface Props {
  snapshot: Snapshot
  kart: string
  onClose: () => void
}

/** Per-driver lap history panel, opened by clicking a timing-table row. */
export function DriverDetail({ snapshot, kart, onClose }: Props) {
  const [laps, setLaps] = useState<LapPoint[] | null>(null)
  const driver = snapshot.drivers.find((d) => d.kart_no === kart)

  useEffect(() => {
    let stop = false
    const load = () =>
      api<{ laps: Record<string, LapPoint[]> }>(
        `/e/${snapshot.slot}/api/laps?karts=${encodeURIComponent(kart)}`,
      )
        .then((r) => { if (!stop) setLaps(r.laps[kart] ?? []) })
        .catch((e) => console.error('[driver detail] laps fetch failed:', e))
    void load()
    const t = setInterval(load, 10000)
    return () => { stop = true; clearInterval(t) }
  }, [snapshot.slot, kart])

  const stats = useMemo(() => {
    const all = laps ?? []
    const clean = all.filter((p) => !p.pit && p.ms > 0)
    if (clean.length === 0) return null
    const best = Math.min(...clean.map((p) => p.ms))
    const pace = clean.reduce((sum, p) => sum + p.ms, 0) / clean.length
    const variance = clean.reduce((sum, p) => sum + (p.ms - pace) ** 2, 0) / clean.length
    const stddev = Math.sqrt(variance)
    return { best, pace, stddev, consistency: (stddev / pace) * 100, cleanCount: clean.length }
  }, [laps])

  const series = useMemo(
    () => [{
      key: kart,
      color: SERIES_COLORS.own,
      label: `#${kart}`,
      points: laps ?? [],
      width: 3,
    }],
    [laps, kart],
  )
  const recent = useMemo(() => [...(laps ?? [])].reverse(), [laps])

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 sm:items-center sm:p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-2xl bg-pit-900 ring-1 ring-pit-700 sm:max-w-2xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-pit-800 px-4 py-3">
          <span className="timing inline-block rounded bg-pit-700 px-2 py-1 text-lg font-extrabold">
            {kart}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate font-display font-bold">{driver?.name || `Kart ${kart}`}</div>
            <div className="label-race">
              P{driver?.position ?? '–'} · {driver?.laps ?? 0} laps · {driver?.pits ?? 0} pit stops
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded bg-pit-700 px-3 py-1.5 text-sm font-bold hover:bg-pit-600"
          >
            ✕
          </button>
        </div>

        <div className="overflow-y-auto p-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Best lap" value={fmtLap(stats?.best)} accent="text-race-purple" />
            <StatTile label="Pace (no pit laps)" value={fmtLap(stats ? Math.round(stats.pace) : null)} />
            <StatTile
              label="Consistency"
              value={stats ? `±${(stats.stddev / 1000).toFixed(2)}s` : '—'}
              sub={stats ? `${stats.consistency.toFixed(1)}% of pace` : undefined}
            />
            <StatTile
              label="Pit time"
              value={driver?.last_pit_ms ? fmtClock(Math.round(driver.last_pit_ms / 1000)) : '—'}
              sub={driver?.total_pit_ms ? `total ${fmtClock(Math.round(driver.total_pit_ms / 1000))}` : undefined}
            />
          </div>

          <div className="mt-4">
            {laps === null ? (
              <p className="p-4 text-center text-sm text-ink-500">Loading lap history…</p>
            ) : laps.length === 0 ? (
              <p className="p-4 text-center text-sm text-ink-500">
                No laps recorded yet — history starts when the dashboard server sees the kart cross the line.
              </p>
            ) : (
              <>
                <LapTimeChart series={series} />
                <h3 className="label-race mb-2 mt-4">Lap history</h3>
                <table className="timing w-full text-xs sm:text-sm">
                  <thead>
                    <tr className="label-race border-b border-pit-700 text-left">
                      <th className="px-2 py-1">Lap</th>
                      <th className="px-2 py-1 text-right">Time</th>
                      <th className="px-2 py-1 text-right">Pos</th>
                      <th className="px-2 py-1 text-right">Pit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((p) => (
                      <tr
                        key={p.lap}
                        className={`border-b border-pit-800 ${p.pit ? 'text-ink-500' : ''} ${
                          stats && p.ms === stats.best && !p.pit ? 'text-race-purple' : ''
                        }`}
                      >
                        <td className="px-2 py-1">{p.lap}</td>
                        <td className="px-2 py-1 text-right">{fmtLap(p.ms)}</td>
                        <td className="px-2 py-1 text-right">{p.pos || '—'}</td>
                        <td className="px-2 py-1 text-right">
                          {p.pit && (
                            <span className="rounded bg-race-yellow px-1 text-[0.6rem] font-bold text-pit-950">
                              PIT
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function StatTile({ label, value, sub, accent = '' }: {
  label: string
  value: string
  sub?: string
  accent?: string
}) {
  return (
    <div className="rounded-lg bg-pit-850 p-3">
      <div className="label-race">{label}</div>
      <div className={`timing text-lg font-bold ${accent}`}>{value}</div>
      {sub && <div className="text-[0.65rem] text-ink-500">{sub}</div>}
    </div>
  )
}
