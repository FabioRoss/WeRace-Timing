import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { DriverDetail } from './DriverDetail'
import { SERIES_COLORS } from './LapCharts'
import type { OrderMode } from './OrderToggle'
import { TrackRing } from './TrackRing'
import { lapFraction, useServerNow } from '../lib/lapProgress'
import type { Snapshot } from '../lib/types'
import type { TeamStoryConfig } from '../lib/teamStoryRender'
import { useT } from '../lib/i18n'
import { fmtGap, fmtLap, fmtSector } from '../lib/format'

interface Props {
  snapshot: Snapshot
  highlightKart?: string
  compact?: boolean
  orderMode?: OrderMode
  ring?: boolean          // false when the page mounts its own TrackRing
  progress?: boolean      // false on static snapshots (no live lap progress to show)
  // Team dashboard: a leading checkbox column to add karts to the chart compare
  selectable?: boolean
  selectedKarts?: string[]
  compareColors?: Record<string, string>
  onToggleKart?: (kart: string) => void
  // Saved snapshot: where the row-click driver modal reads its lap history from
  // (e.g. `/api/results/{id}`), instead of the live feed. Static → no polling.
  lapsBase?: string
  safeword?: boolean
  // Saved snapshot: the staff-chosen team-story look. When set, the row-click
  // modal offers a per-team "Download story" button (the per-team download the
  // team dashboard can't provide from a saved result).
  teamStoryConfig?: TeamStoryConfig
  // false when race control is holding penalties back from this viewer (the
  // team dashboard with "hide team penalties" on): no PEN/ADJ badges either.
  showPenalties?: boolean
}

function barStyle(pct: number, smooth: boolean): CSSProperties {
  if (pct <= 0) return {}
  return {
    // Only the leading ~100px of the line is visible (fade tail)
    backgroundImage:
      'linear-gradient(90deg, transparent calc(100% - 100px), var(--color-race-blue))',
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'left bottom',
    backgroundSize: `${pct}% 2px`,
    // The 300ms tick sets waypoints; the linear transition glides between
    // them so the bar moves fluidly. Resets (new lap) jump instantly.
    transition: smooth ? 'background-size 320ms linear' : 'none',
  }
}

export function TimingTable({
  snapshot, highlightKart, compact = false, orderMode = 'race', ring = true,
  progress = true,
  selectable = false, selectedKarts, compareColors, onToggleKart,
  lapsBase, safeword, teamStoryConfig, showPenalties = true,
}: Props) {
  const t = useT()
  const { drivers, session_best_kart } = snapshot
  const byLapTime = orderMode === 'laptime'

  // Karts carrying an outstanding, result-affecting penalty (unserved time
  // penalty or any lap penalty) get a red PEN badge. Neutral time adjustments
  // are tracked separately (a neutral ADJ badge) — they aren't sanctions.
  const adjustedKarts = useMemo(() => {
    const s = new Set<string>()
    if (!showPenalties) return s
    for (const p of snapshot.penalties ?? []) {
      if (p.kind === 'adjust' && (p.seconds || p.laps)) s.add(p.kart_no)
    }
    return s
  }, [snapshot.penalties, showPenalties])
  const penalizedKarts = useMemo(() => {
    const s = new Set<string>()
    if (!showPenalties) return s
    for (const p of snapshot.penalties ?? []) {
      if (p.kind === 'warning' || p.kind === 'adjust') continue
      if (p.kind === 'time' && p.served) continue
      s.add(p.kart_no)
    }
    return s
  }, [snapshot.penalties, showPenalties])
  const [detailKart, setDetailKart] = useState<string | null>(null)

  // ~3 fps waypoints for the progress bars; CSS transitions glide between them
  const serverNow = useServerNow(snapshot.updated_at)

  // Last rendered bar width per kart: moving forward glides via transition,
  // moving backward (lap reset) snaps instantly.
  const prevPctRef = useRef<Map<string, number>>(new Map())

  // Glow on start/finish crossings: a new lap anchor (prog_from === 0 with a
  // fresh prog_ts) marks a crossing; karts without progress data fall back to
  // lap-count changes. State-driven so it fires reliably on every lap.
  const prevCross = useRef<Map<string, number>>(new Map())
  const [flashing, setFlashing] = useState<Set<string>>(new Set())
  useEffect(() => {
    const newly: string[] = []
    for (const d of drivers) {
      let crossKey: number | null = null
      if (d.prog_ts != null && d.prog_from === 0) crossKey = d.prog_ts
      else if (d.prog_ts == null && d.laps > 0) crossKey = d.laps
      if (crossKey == null) continue // mid-lap sector anchor: keep last key
      const prev = prevCross.current.get(d.kart_no)
      prevCross.current.set(d.kart_no, crossKey)
      if (prev !== undefined && prev !== crossKey && !d.in_pit) newly.push(d.kart_no)
    }
    if (newly.length === 0) return
    setFlashing((cur) => new Set([...cur, ...newly]))
    const t = setTimeout(() => {
      setFlashing((cur) => {
        const next = new Set(cur)
        newly.forEach((k) => next.delete(k))
        return next
      })
    }, 1500)
    return () => clearTimeout(t)
  }, [drivers])

  if (drivers.length === 0) {
    return (
      <div className="p-10 text-center text-ink-500">
        {t('Waiting for timing data…')}
      </div>
    )
  }
  const rows = byLapTime
    ? [...drivers].sort(
        (a, b) => (a.best_lap_ms ?? Infinity) - (b.best_lap_ms ?? Infinity),
      )
    : drivers
  const hasSectors = drivers.some((d) => d.s1_ms || d.s2_ms || d.s3_ms)
  const hasSpeed = drivers.some((d) => d.speed)
  // Pit stops only matter where the session has them: a gated pit lane, or
  // stops already counted. Sprint heats without stops don't get the column.
  const hasPits = snapshot.auto_pitlane === true || drivers.some((d) => d.pits > 0)
  // Practice/qualifying rank by best lap, so that's the lap time worth showing.
  const timed = snapshot.race?.session_kind === 'timed'
  // Phones get two-line rows that fit 360px, led by what matters most on a
  // phone: the gap to the kart ahead, and pit stops when the session has them.
  // From `sm` up each figure has its own column (`desk` cells).
  const pad = compact ? 'px-1 py-1.5 sm:px-2 sm:py-1' : 'px-1 py-1.5 sm:px-3 sm:py-2'
  const desk = 'hidden sm:table-cell'
  const wide = 'hidden lg:table-cell'   // sectors + speed: desktop only
  const phone = 'sm:hidden'
  return (
    <div>
      {ring && (
        <div className="border-b border-pit-800 px-3 py-3">
          <TrackRing snapshot={snapshot} highlightKart={highlightKart} />
        </div>
      )}
      <div className="scroll-x">
      <table className="w-full text-[13px] sm:text-sm timing">
        <thead>
          <tr className="label-race border-b border-pit-700 text-left">
            {selectable && (
              <th className={`${pad} w-7`} title={t('Add to comparison charts')}>
                <ChartColIcon />
              </th>
            )}
            <th className={`${pad} text-center sm:text-left`}>
              <span className="sm:hidden">{t('P')}</span>
              <span className="hidden sm:inline">{t('Pos')}</span>
            </th>
            <th className={pad}>{t('Kart')}</th>
            <th className={`${pad} font-display`}>{t('Team')}</th>
            {hasSectors && (
              <>
                <th className={`${pad} text-right ${wide}`}>S1</th>
                <th className={`${pad} text-right ${wide}`}>S2</th>
                <th className={`${pad} text-right ${wide}`}>S3</th>
              </>
            )}
            <th className={`${pad} text-right ${phone}`}>{t('Int')}<span className="text-ink-500"> / </span>{t('Gap')}</th>
            {hasPits && <th className={`${pad} text-right ${phone}`}>{t('Pits')}</th>}
            <th className={`${pad} text-right ${desk}`}>{t('Last')}</th>
            <th className={`${pad} text-right ${desk}`}>{t('Best')}</th>
            <th className={`${pad} text-right ${desk}`}>{t('Gap')}</th>
            <th className={`${pad} text-right ${desk}`}>{t('Int')}</th>
            <th className={`${pad} text-right ${desk}`}>{t('Laps')}</th>
            {hasSpeed && <th className={`${pad} text-right ${wide}`}>kph</th>}
            <th className={`${pad} text-right ${desk}`}>{t('Pits')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d, index) => {
            const rank = byLapTime ? index + 1 : d.position
            const own = highlightKart != null && d.kart_no === highlightKart
            const hasSessionBest = d.kart_no === session_best_kart && d.best_lap_ms != null
            const showBar = progress && !byLapTime && !d.in_pit && !d.finished
            const pct = showBar ? (lapFraction(d, serverNow) ?? 0) * 100 : 0
            const smooth = pct >= (prevPctRef.current.get(d.kart_no) ?? 0)
            prevPctRef.current.set(d.kart_no, pct)
            const gap = rank === 1 ? '—' : fmtGap(d.gap_leader)
            const interval = rank === 1 ? '' : fmtGap(d.gap_ahead)
            const bestClass = hasSessionBest ? 'text-race-purple font-bold' : 'text-ink-300'
            const badges = (
              <StatusBadges
                inPit={d.pit_state === 'in' || d.in_pit}
                out={d.pit_state === 'out'}
                finished={d.finished}
                penalized={penalizedKarts.has(d.kart_no)}
                adjusted={adjustedKarts.has(d.kart_no)}
              />
            )
            return (
              <tr
                key={d.kart_no}
                style={barStyle(pct, smooth)}
                onClick={() => setDetailKart(d.kart_no)}
                className={`cursor-pointer border-b border-pit-800 transition-colors hover:bg-pit-800/60 ${
                  flashing.has(d.kart_no) ? 'lap-glow' : ''
                } ${
                  // Own-row highlight wins over the zebra (both set background-color).
                  own
                    ? 'bg-race-blue/15 outline outline-1 -outline-offset-1 outline-race-blue/60'
                    : (index % 2 === 1 ? 'bg-pit-850' : '')
                } ${d.finished ? 'opacity-60' : ''}`}
              >
                {selectable && (
                  <td className={pad} onClick={(e) => e.stopPropagation()}>
                    {own ? (
                      <span
                        className="inline-block h-4 w-4 rounded-sm align-middle"
                        style={{ background: SERIES_COLORS.own }}
                        title={t('your kart (always shown)')}
                      />
                    ) : (
                      <input
                        type="checkbox"
                        aria-label={t('Compare #{kart}', { kart: d.kart_no })}
                        checked={selectedKarts?.includes(d.kart_no) ?? false}
                        onChange={() => onToggleKart?.(d.kart_no)}
                        className="h-4 w-4 cursor-pointer align-middle"
                        style={
                          selectedKarts?.includes(d.kart_no) && compareColors?.[d.kart_no]
                            ? { accentColor: compareColors[d.kart_no] }
                            : undefined
                        }
                      />
                    )}
                  </td>
                )}
                <td className={`${pad} text-center font-bold sm:text-left`}>{rank}</td>
                <td className={pad}>
                  <span className="inline-block min-w-8 rounded-md bg-pit-700 px-1 py-0.5 text-center font-bold sm:min-w-9 sm:px-1.5">
                    {d.kart_no}
                  </span>
                </td>
                {/* Team: the cell absorbs spare width (w-full) and may shrink to
                    nothing (max-w-0), so long names truncate instead of widening
                    the table. Badges sit outside the truncating text. */}
                <td className={`${pad} w-full max-w-0 font-display`}>
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate">{d.name || '—'}</span>
                    <span className="hidden shrink-0 sm:inline-flex">{badges}</span>
                  </div>
                  <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-ink-500 sm:hidden">
                    <span className="timing shrink-0">{t('L{n}', { n: d.laps })}</span>
                    <span className={`timing shrink-0 ${timed ? bestClass : ''}`}>
                      · {timed ? t('best {v}', { v: fmtLap(d.best_lap_ms) }) : t('last {v}', { v: fmtLap(d.last_lap_ms) })}
                    </span>
                    {badges}
                  </div>
                </td>
                {hasSectors && (
                  <>
                    <td className={`${pad} text-right text-ink-300 ${wide}`}>{fmtSector(d.s1_ms)}</td>
                    <td className={`${pad} text-right text-ink-300 ${wide}`}>{fmtSector(d.s2_ms)}</td>
                    <td className={`${pad} text-right text-ink-300 ${wide}`}>{fmtSector(d.s3_ms)}</td>
                  </>
                )}
                {/* Phone: the gap to the kart ahead leads, gap to the leader under it */}
                <td className={`${pad} whitespace-nowrap text-right ${phone}`}>
                  <div className="text-[15px] font-bold text-ink-100">{rank === 1 ? '—' : interval || '—'}</div>
                  <div className="text-[11px] text-ink-500">{rank === 1 ? '' : gap}</div>
                </td>
                {hasPits && (
                  <td className={`${pad} text-right text-[15px] font-bold ${phone} ${d.pits ? 'text-ink-100' : 'text-ink-500'}`}>
                    {d.pits}
                  </td>
                )}
                {/* Wide layout: one figure per column */}
                <td className={`${pad} text-right ${desk}`}>{fmtLap(d.last_lap_ms)}</td>
                <td className={`${pad} text-right ${desk} ${bestClass}`}>{fmtLap(d.best_lap_ms)}</td>
                <td className={`${pad} text-right text-ink-300 ${desk}`}>{gap}</td>
                <td className={`${pad} text-right text-ink-300 ${desk}`}>{interval || '—'}</td>
                <td className={`${pad} text-right ${desk}`}>{d.laps}</td>
                {hasSpeed && (
                  <td className={`${pad} text-right text-ink-300 ${wide}`}>{d.speed || '—'}</td>
                )}
                <td className={`${pad} text-right ${desk}`}>{d.pits}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      </div>
      {detailKart && (
        <DriverDetail
          snapshot={snapshot}
          kart={detailKart}
          onClose={() => setDetailKart(null)}
          lapsBase={lapsBase}
          safeword={safeword}
          teamStoryConfig={teamStoryConfig}
        />
      )}
    </div>
  )
}

/** PIT / OUT / FIN / PEN / ADJ markers. Never truncated: they sit beside the
 *  name (wide) or on the second line (phones), not inside the clipped text. */
function StatusBadges({ inPit, out, finished, penalized, adjusted }: {
  inPit: boolean
  out: boolean
  finished: boolean
  penalized: boolean
  adjusted: boolean
}) {
  const t = useT()
  const pill = 'rounded px-1 py-px text-[0.6rem] font-bold leading-tight'
  return (
    <>
      {inPit ? (
        <span className={`${pill} bg-race-yellow text-pit-950`}>{t('PIT')}</span>
      ) : out ? (
        <span className={`${pill} bg-race-green text-pit-950`}>{t('OUT')}</span>
      ) : null}
      {finished && <span className={`${pill} bg-pit-700 text-ink-300`}>{t('FIN')}</span>}
      {penalized && (
        <span className={`${pill} bg-race-red text-white`} title={t('Outstanding penalty')}>{t('PEN')}</span>
      )}
      {adjusted && (
        <span className={`${pill} bg-race-blue text-white`} title={t('Time adjustment applied')}>{t('ADJ')}</span>
      )}
    </>
  )
}

/** Chart-compare column header icon */
function ChartColIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ink-500">
      <path d="M3 3v18h18" />
      <path d="M7 14l4-4 3 3 5-6" />
    </svg>
  )
}
