import { useEffect, useRef } from 'react'
import type { CSSProperties } from 'react'
import type { DriverRow, Snapshot } from '../lib/types'
import { fmtGap, fmtLap } from '../lib/format'

interface Props {
  snapshot: Snapshot
  highlightKart?: string
  compact?: boolean
}

/** Lap-progress line + start/finish flash, keyed on laps parity so each
 *  completed lap restarts the CSS animations without remounting the row. */
function lapAnimation(d: DriverRow, crossed: boolean): CSSProperties {
  if (d.in_pit || d.finished || !d.last_lap_ms) return {}
  const variant = d.laps % 2 === 0 ? 'a' : 'b'
  const animations = [`lap-progress-${variant} ${d.last_lap_ms}ms linear forwards`]
  if (crossed) animations.push(`lap-flash-${variant} 1.2s ease-out`)
  return {
    backgroundImage: 'linear-gradient(var(--color-race-blue), var(--color-race-blue))',
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'left bottom',
    backgroundSize: '0% 2px',
    animation: animations.join(', '),
  }
}

export function TimingTable({ snapshot, highlightKart, compact = false }: Props) {
  const { drivers, session_best_kart } = snapshot

  // Karts whose lap count just increased flash briefly (start/finish crossing).
  // The ref survives re-renders so rows don't all flash on first paint.
  const prevLaps = useRef<Map<string, number>>(new Map())
  const crossed = new Set<string>()
  for (const d of drivers) {
    const prev = prevLaps.current.get(d.kart_no)
    if (prev !== undefined && d.laps > prev) crossed.add(d.kart_no)
  }
  useEffect(() => {
    prevLaps.current = new Map(drivers.map((d) => [d.kart_no, d.laps]))
  }, [drivers])

  if (drivers.length === 0) {
    return (
      <div className="p-10 text-center text-ink-500">
        Waiting for timing data…
      </div>
    )
  }
  const pad = compact ? 'px-2 py-1' : 'px-3 py-2'
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm timing">
        <thead>
          <tr className="label-race border-b border-pit-700 text-left">
            <th className={pad}>Pos</th>
            <th className={pad}>Kart</th>
            <th className={`${pad} font-display`}>Team</th>
            <th className={`${pad} text-right`}>Last</th>
            <th className={`${pad} text-right`}>Best</th>
            <th className={`${pad} text-right`}>Gap</th>
            <th className={`${pad} text-right`}>Int</th>
            <th className={`${pad} text-right`}>Laps</th>
            <th className={`${pad} text-right`}>Pits</th>
          </tr>
        </thead>
        <tbody>
          {drivers.map((d) => {
            const own = highlightKart != null && d.kart_no === highlightKart
            const hasSessionBest = d.kart_no === session_best_kart && d.best_lap_ms != null
            return (
              <tr
                key={d.kart_no}
                style={lapAnimation(d, crossed.has(d.kart_no))}
                className={`border-b border-pit-800 ${
                  own ? 'bg-race-blue/15 outline outline-1 -outline-offset-1 outline-race-blue/60' : ''
                } ${d.finished ? 'opacity-60' : ''}`}
              >
                <td className={`${pad} font-bold`}>{d.position}</td>
                <td className={pad}>
                  <span className="inline-block min-w-9 rounded bg-pit-700 px-1.5 py-0.5 text-center font-bold">
                    {d.kart_no}
                  </span>
                </td>
                <td className={`${pad} font-display max-w-48 truncate`}>
                  {d.name || '—'}
                  {d.in_pit && (
                    <span className="ml-2 rounded bg-race-yellow px-1 text-[0.6rem] font-bold text-pit-950 align-middle">
                      PIT
                    </span>
                  )}
                  {d.finished && (
                    <span className="ml-2 text-[0.6rem] text-ink-500 align-middle">FIN</span>
                  )}
                </td>
                <td className={`${pad} text-right`}>{fmtLap(d.last_lap_ms)}</td>
                <td
                  className={`${pad} text-right ${
                    hasSessionBest ? 'text-race-purple font-bold' : 'text-ink-300'
                  }`}
                >
                  {fmtLap(d.best_lap_ms)}
                </td>
                <td className={`${pad} text-right text-ink-300`}>
                  {d.position === 1 ? '—' : fmtGap(d.gap_leader)}
                </td>
                <td className={`${pad} text-right text-ink-300`}>
                  {d.position === 1 ? '—' : fmtGap(d.gap_ahead)}
                </td>
                <td className={`${pad} text-right`}>{d.laps}</td>
                <td className={`${pad} text-right`}>{d.pits}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
