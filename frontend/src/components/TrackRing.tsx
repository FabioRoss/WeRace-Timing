import { useRef } from 'react'
import { lapFraction, useServerNow } from '../lib/lapProgress'
import type { DriverRow, Snapshot } from '../lib/types'

const CX = 150
const CY = 150
const R = 118          // main ring radius
const R_PIT = 88       // in-pit karts sit on an inner arc
const KART_R = 11

function pt(frac: number, r: number): [number, number] {
  const a = ((frac * 360 - 90) * Math.PI) / 180
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)]
}

function arcPath(f0: number, f1: number, r: number): string {
  const [x0, y0] = pt(f0, r)
  const [x1, y1] = pt(f1, r)
  const large = f1 - f0 > 0.5 ? 1 : 0
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`
}

function tick(frac: number, r0: number, r1: number, key: string, cls: string, width = 2) {
  const [x0, y0] = pt(frac, r0)
  const [x1, y1] = pt(frac, r1)
  return <line key={key} x1={x0} y1={y0} x2={x1} y2={y1} className={cls} strokeWidth={width} />
}

/** Average sector durations across the field -> cumulative lap fractions of
 *  the sector boundaries, so marks sit at time-proportional distances. */
function sectorFractions(drivers: DriverRow[]): [number, number] | null {
  const avg = (pick: (d: DriverRow) => number | null) => {
    const vals = drivers.map(pick).filter((v): v is number => !!v && v > 0)
    return vals.length >= 3 ? vals.reduce((a, b) => a + b, 0) / vals.length : null
  }
  const s1 = avg((d) => d.s1_ms)
  const s2 = avg((d) => d.s2_ms)
  const s3 = avg((d) => d.s3_ms)
  if (!s1 || !s2 || !s3) return null
  const total = s1 + s2 + s3
  return [s1 / total, (s1 + s2) / total]
}

/** F1-style track-position ring: the lap as a circle with the start/finish
 *  line at 12 o'clock, sector boundaries at time-proportional positions, and
 *  every kart as a numbered dot moving smoothly around it. */
export function TrackRing({ snapshot, highlightKart }: {
  snapshot: Snapshot
  highlightKart?: string
}) {
  const serverNow = useServerNow(snapshot.updated_at)
  const prevFrac = useRef<Map<string, number>>(new Map())
  const { drivers } = snapshot
  if (drivers.length === 0) return null

  const isRace = snapshot.race.session_kind === 'race'
  const leader = drivers.find((d) => d.position === 1) ?? drivers[0]
  const sectors = sectorFractions(drivers)

  // Leader on top; then karts by reverse position so front-runners overlap
  // backmarkers, not the other way around.
  const ordered = [...drivers].sort((a, b) => b.position - a.position)
  const pitKarts = ordered.filter((d) => d.in_pit)

  const karts = ordered.map((d) => {
    const inPit = d.in_pit
    let frac = lapFraction(d, serverNow)
    if (frac == null && !inPit) return null

    let x: number
    let y: number
    if (inPit) {
      // pit lane: inner arc under the start/finish line
      const i = pitKarts.indexOf(d)
      const spread = (i - (pitKarts.length - 1) / 2) * 0.03
      ;[x, y] = pt((1 + spread) % 1, R_PIT)
    } else {
      ;[x, y] = pt(frac!, R)
    }

    // Glide between ticks; snap on large corrections. Wrap-around at the
    // start/finish line is a short chord in x/y, so it glides naturally.
    const key = inPit ? -1 : frac!
    const prev = prevFrac.current.get(d.kart_no)
    prevFrac.current.set(d.kart_no, key)
    const wasPit = prev === -1
    const dist = prev == null ? 1 : Math.abs(key - prev)
    const jump =
      prev == null ||
      wasPit !== (key === -1) ||
      Math.min(dist, 1 - dist) > 0.15

    const isLeader = d.kart_no === leader.kart_no
    const lapped = isRace && !isLeader && d.laps < leader.laps
    const fill = isLeader
      ? 'var(--color-race-purple)'
      : lapped
        ? 'var(--color-race-blue)'
        : 'var(--color-pit-600)'
    const own = highlightKart != null && d.kart_no === highlightKart
    return (
      <g
        key={d.kart_no}
        style={{
          transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`,
          transition: jump ? 'none' : 'transform 320ms linear',
          opacity: inPit ? 0.45 : 1,
        }}
      >
        <circle
          r={KART_R}
          fill={fill}
          stroke={own ? 'var(--color-race-green)' : 'var(--color-pit-950)'}
          strokeWidth={own ? 2.5 : 1.5}
        />
        <text
          textAnchor="middle"
          dominantBaseline="central"
          className="timing"
          fontSize={d.kart_no.length > 2 ? 8 : 9.5}
          fontWeight={700}
          fill="var(--color-ink-100)"
        >
          {d.kart_no}
        </text>
      </g>
    )
  })

  const [sfx0, sfy0] = pt(0, R - 9)
  const label = (frac: number, text: string) => {
    const [x, y] = pt(frac, R + 16)
    return (
      <text
        key={text}
        x={x}
        y={y}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={10}
        className="fill-ink-500"
      >
        {text}
      </text>
    )
  }

  return (
    <div className="mx-auto w-full max-w-80">
      <svg viewBox="0 0 300 300" className="w-full">
        {/* ring: sector arcs when sector data exists, plain circle otherwise */}
        {sectors ? (
          <>
            <path d={arcPath(0, sectors[0], R)} fill="none" stroke="var(--color-pit-700)" strokeWidth={7} strokeLinecap="round" />
            <path d={arcPath(sectors[0], sectors[1], R)} fill="none" stroke="var(--color-pit-600)" strokeWidth={7} strokeLinecap="round" />
            <path d={arcPath(sectors[1], 0.9999, R)} fill="none" stroke="var(--color-pit-700)" strokeWidth={7} strokeLinecap="round" />
            {tick(sectors[0], R - 8, R + 8, 's1end', 'stroke-ink-500')}
            {tick(sectors[1], R - 8, R + 8, 's2end', 'stroke-ink-500')}
            {label(sectors[0] / 2, 'S1')}
            {label((sectors[0] + sectors[1]) / 2, 'S2')}
            {label((sectors[1] + 1) / 2, 'S3')}
          </>
        ) : (
          <circle cx={CX} cy={CY} r={R} fill="none" stroke="var(--color-pit-700)" strokeWidth={7} />
        )}
        {/* start/finish line: checkered block at 12 o'clock */}
        <g transform={`translate(${sfx0}, ${sfy0})`}>
          <rect x={-4} y={-9} width={8} height={18} fill="var(--color-ink-100)" />
          <rect x={-4} y={-9} width={4} height={4.5} fill="var(--color-pit-950)" />
          <rect x={0} y={-4.5} width={4} height={4.5} fill="var(--color-pit-950)" />
          <rect x={-4} y={0} width={4} height={4.5} fill="var(--color-pit-950)" />
          <rect x={0} y={4.5} width={4} height={4.5} fill="var(--color-pit-950)" />
        </g>
        {karts}
      </svg>
      <div className="flex justify-center gap-4 text-[0.65rem] text-ink-500">
        <span>
          <span className="mr-1 inline-block h-2 w-2 rounded-full bg-race-purple align-middle" />
          leader
        </span>
        {isRace && (
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-race-blue align-middle" />
            lapped
          </span>
        )}
        <span>
          <span className="mr-1 inline-block h-2 w-2 rounded-full bg-pit-600 align-middle opacity-45" />
          in pit
        </span>
      </div>
    </div>
  )
}
