import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { DriverDetail } from './DriverDetail'
import type { OrderMode } from './OrderToggle'
import type { DriverRow, Snapshot } from '../lib/types'
import { fmtGap, fmtLap, fmtSector } from '../lib/format'

interface Props {
  snapshot: Snapshot
  highlightKart?: string
  compact?: boolean
  orderMode?: OrderMode
}

/** Apex-style lap progress: interpolate between the last timing event
 *  (crossing / sector) and the next expected one. `serverNow` is the client
 *  clock corrected onto the server's, since prog_ts is server wall time. */
function progressPct(d: DriverRow, serverNow: number): number {
  if (d.prog_ts == null) return 0
  let p = d.prog_from
  if (d.prog_ms) {
    const t = ((serverNow - d.prog_ts) * 1000) / d.prog_ms
    p = d.prog_from + (d.prog_to - d.prog_from) * Math.min(Math.max(t, 0), 1)
  }
  return Math.min(Math.max(p, 0), 1) * 100
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

export function TimingTable({ snapshot, highlightKart, compact = false, orderMode = 'race' }: Props) {
  const { drivers, session_best_kart } = snapshot
  const byLapTime = orderMode === 'laptime'
  const [detailKart, setDetailKart] = useState<string | null>(null)

  // ~3 fps tick drives the progress bars (no CSS animation restarts involved)
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 300)
    return () => clearInterval(t)
  }, [])

  // Last rendered bar width per kart: moving forward glides via transition,
  // moving backward (lap reset) snaps instantly.
  const prevPctRef = useRef<Map<string, number>>(new Map())

  // prog_ts is server wall time; track client-server clock offset
  const skewRef = useRef(0)
  useEffect(() => {
    if (snapshot.updated_at > 0) {
      skewRef.current = Date.now() / 1000 - snapshot.updated_at
    }
  }, [snapshot.updated_at])
  const serverNow = Date.now() / 1000 - skewRef.current

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
        Waiting for timing data…
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
  const pad = compact ? 'px-1.5 py-1 sm:px-2' : 'px-1.5 py-1.5 sm:px-3 sm:py-2'
  const side = 'hidden sm:table-cell'   // columns dropped on portrait phones
  const wide = 'hidden lg:table-cell'   // sector columns: desktop only
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs sm:text-sm timing">
        <thead>
          <tr className="label-race border-b border-pit-700 text-left">
            <th className={pad}>
              <span className="sm:hidden">P</span>
              <span className="hidden sm:inline">Pos</span>
            </th>
            <th className={pad}>Kart</th>
            <th className={`${pad} font-display`}>Team</th>
            {hasSectors && (
              <>
                <th className={`${pad} text-right ${wide}`}>S1</th>
                <th className={`${pad} text-right ${wide}`}>S2</th>
                <th className={`${pad} text-right ${wide}`}>S3</th>
              </>
            )}
            <th className={`${pad} text-right`}>Last</th>
            <th className={`${pad} text-right`}>Best</th>
            <th className={`${pad} text-right`}>Gap</th>
            <th className={`${pad} text-right ${side}`}>Int</th>
            <th className={`${pad} text-right`}>
              <span className="sm:hidden">Lap</span>
              <span className="hidden sm:inline">Laps</span>
            </th>
            {hasSpeed && <th className={`${pad} text-right ${wide}`}>kph</th>}
            <th className={`${pad} text-right ${side}`}>Pits</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d, index) => {
            const rank = byLapTime ? index + 1 : d.position
            const own = highlightKart != null && d.kart_no === highlightKart
            const hasSessionBest = d.kart_no === session_best_kart && d.best_lap_ms != null
            const showBar = !byLapTime && !d.in_pit && !d.finished
            const pct = showBar ? progressPct(d, serverNow) : 0
            const smooth = pct >= (prevPctRef.current.get(d.kart_no) ?? 0)
            prevPctRef.current.set(d.kart_no, pct)
            return (
              <tr
                key={d.kart_no}
                style={barStyle(pct, smooth)}
                onClick={() => setDetailKart(d.kart_no)}
                className={`cursor-pointer border-b border-pit-800 ${
                  flashing.has(d.kart_no) ? 'lap-glow' : ''
                } ${
                  own ? 'bg-race-blue/15 outline outline-1 -outline-offset-1 outline-race-blue/60' : ''
                } ${d.finished ? 'opacity-60' : ''}`}
              >
                <td className={`${pad} font-bold`}>{rank}</td>
                <td className={pad}>
                  <span className="inline-block min-w-7 rounded bg-pit-700 px-1 py-0.5 text-center font-bold sm:min-w-9 sm:px-1.5">
                    {d.kart_no}
                  </span>
                </td>
                <td className={`${pad} font-display max-w-20 truncate sm:max-w-48`}>
                  {d.name || '—'}
                  {d.pit_state === 'in' || d.in_pit ? (
                    <span className="ml-2 rounded bg-race-yellow px-1 text-[0.6rem] font-bold text-pit-950 align-middle">
                      PIT
                    </span>
                  ) : d.pit_state === 'out' ? (
                    <span className="ml-2 rounded bg-race-green px-1 text-[0.6rem] font-bold text-pit-950 align-middle">
                      OUT
                    </span>
                  ) : null}
                  {d.finished && (
                    <span className="ml-2 text-[0.6rem] text-ink-500 align-middle">FIN</span>
                  )}
                </td>
                {hasSectors && (
                  <>
                    <td className={`${pad} text-right text-ink-300 ${wide}`}>{fmtSector(d.s1_ms)}</td>
                    <td className={`${pad} text-right text-ink-300 ${wide}`}>{fmtSector(d.s2_ms)}</td>
                    <td className={`${pad} text-right text-ink-300 ${wide}`}>{fmtSector(d.s3_ms)}</td>
                  </>
                )}
                <td className={`${pad} text-right`}>{fmtLap(d.last_lap_ms)}</td>
                <td
                  className={`${pad} text-right ${
                    hasSessionBest ? 'text-race-purple font-bold' : 'text-ink-300'
                  }`}
                >
                  {fmtLap(d.best_lap_ms)}
                </td>
                <td className={`${pad} text-right text-ink-300`}>
                  {rank === 1 ? '—' : fmtGap(d.gap_leader)}
                </td>
                <td className={`${pad} text-right text-ink-300 ${side}`}>
                  {rank === 1 ? '—' : fmtGap(d.gap_ahead)}
                </td>
                <td className={`${pad} text-right`}>{d.laps}</td>
                {hasSpeed && (
                  <td className={`${pad} text-right text-ink-300 ${wide}`}>{d.speed || '—'}</td>
                )}
                <td className={`${pad} text-right ${side}`}>{d.pits}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {detailKart && (
        <DriverDetail
          snapshot={snapshot}
          kart={detailKart}
          onClose={() => setDetailKart(null)}
        />
      )}
    </div>
  )
}
