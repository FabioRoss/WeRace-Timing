import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import type { LapPoint, Snapshot } from '../lib/types'
import { fmtClock, fmtLap } from '../lib/format'
import { LapTimeChart, SERIES_COLORS } from './LapCharts'
import { downloadBlob } from '../lib/story'
import { renderTeamStoryBlob, type TeamStoryConfig } from '../lib/teamStoryRender'
import { useT } from '../lib/i18n'

interface Props {
  snapshot: Snapshot
  kart: string
  onClose: () => void
  // For a saved snapshot, the laps base (e.g. `/api/results/{id}` or
  // `/api/admin/snapshots/{id}`) — the modal reads its history from there
  // instead of the live feed, whose slot is disconnected. Static → no polling.
  lapsBase?: string
  safeword?: boolean
  // Saved snapshot: staff-chosen team-story look → enables a per-team download.
  teamStoryConfig?: TeamStoryConfig
}

/** Per-driver lap history panel, opened by clicking a timing-table row. */
export function DriverDetail({ snapshot, kart, onClose, lapsBase, safeword = false, teamStoryConfig }: Props) {
  const t = useT()
  const [laps, setLaps] = useState<LapPoint[] | null>(null)
  const [storyBusy, setStoryBusy] = useState(false)
  const driver = snapshot.drivers.find((d) => d.kart_no === kart)

  const downloadStory = async () => {
    if (!teamStoryConfig) return
    setStoryBusy(true)
    try {
      const blob = await renderTeamStoryBlob(snapshot, teamStoryConfig, kart)
      if (blob) downloadBlob(blob, `team-story-${kart}.png`)
    } finally {
      setStoryBusy(false)
    }
  }

  useEffect(() => {
    let stop = false
    const url = lapsBase
      ? `${lapsBase}/laps?karts=${encodeURIComponent(kart)}`
      : `/e/${snapshot.slot}/api/laps?karts=${encodeURIComponent(kart)}`
    const load = () =>
      api<{ laps: Record<string, LapPoint[]> }>(url, { safeword })
        .then((r) => { if (!stop) setLaps(r.laps[kart] ?? []) })
        .catch((e) => console.error('[driver detail] laps fetch failed:', e))
    void load()
    // A saved snapshot never changes; only the live feed needs polling.
    const t = lapsBase ? null : setInterval(load, 10000)
    return () => { stop = true; if (t) clearInterval(t) }
  }, [snapshot.slot, kart, lapsBase, safeword])

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
            <div className="truncate font-display font-bold">{driver?.name || t('Kart {kart}', { kart })}</div>
            <div className="label-race">
              P{driver?.position ?? '–'} · {t('{n} laps', { n: driver?.laps ?? 0 })} · {t('{n} pit stops', { n: driver?.pits ?? 0 })}
            </div>
          </div>
          {teamStoryConfig && (
            <button
              type="button"
              onClick={() => void downloadStory()}
              disabled={storyBusy}
              className="rounded bg-race-blue px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-white hover:brightness-110 disabled:opacity-40"
            >
              {storyBusy ? '…' : t('Story')}
            </button>
          )}
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
            <StatTile label={t('Best lap')} value={fmtLap(stats?.best)} accent="text-race-purple" />
            <StatTile label={t('Pace (no pit laps)')} value={fmtLap(stats ? Math.round(stats.pace) : null)} />
            <StatTile
              label={t('Consistency')}
              value={stats ? `±${(stats.stddev / 1000).toFixed(2)}s` : '—'}
              sub={stats ? t('{n}% of pace', { n: stats.consistency.toFixed(1) }) : undefined}
            />
            <StatTile
              label={t('Pit time')}
              value={driver?.last_pit_ms ? fmtClock(Math.round(driver.last_pit_ms / 1000)) : '—'}
              sub={driver?.total_pit_ms ? t('total {v}', { v: fmtClock(Math.round(driver.total_pit_ms / 1000)) }) : undefined}
            />
          </div>

          <div className="mt-4">
            {laps === null ? (
              <p className="p-4 text-center text-sm text-ink-500">{t('Loading lap history…')}</p>
            ) : laps.length === 0 ? (
              <p className="p-4 text-center text-sm text-ink-500">
                {lapsBase
                  ? t('No lap history recorded for this kart in this session.')
                  : t('No laps recorded yet — history starts when the dashboard server sees the kart cross the line.')}
              </p>
            ) : (
              <>
                <LapTimeChart series={series} />
                <h3 className="label-race mb-2 mt-4">{t('Lap history')}</h3>
                <table className="timing w-full text-xs sm:text-sm">
                  <thead>
                    <tr className="label-race border-b border-pit-700 text-left">
                      <th className="px-2 py-1">{t('Lap')}</th>
                      <th className="px-2 py-1 text-right">{t('Time')}</th>
                      <th className="px-2 py-1 text-right">{t('Pos')}</th>
                      <th className="px-2 py-1 text-right">{t('Pit')}</th>
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
                              {t('PIT')}
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
