import { useMemo, useState } from 'react'
import {
  CartesianGrid, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis, Legend,
} from 'recharts'
import type { LapPoint } from '../lib/types'
import { fmtLap } from '../lib/format'

/** Click-to-toggle series visibility for a Recharts legend. */
function useHiddenSeries() {
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const onLegendClick = (entry: { dataKey?: unknown }) => {
    const key = String(entry?.dataKey ?? '')
    if (!key) return
    setHidden((cur) => {
      const next = new Set(cur)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const legendFormatter = (value: string, entry: { dataKey?: unknown } | undefined) => (
    <span
      style={{
        cursor: 'pointer',
        opacity: hidden.has(String(entry?.dataKey ?? '')) ? 0.35 : 1,
      }}
    >
      {value}
    </span>
  )
  return { hidden, onLegendClick, legendFormatter }
}

/* Validated against surface #0b0d14 (dataviz six checks: all pass, worst ΔE 41.3).
   Color follows the entity role, never rank order. */
export const SERIES_COLORS = {
  own: '#3987e5',      // blue
  leader: '#c98500',   // yellow
  ahead: '#199e70',    // aqua
  behind: '#9085e9',   // violet
} as const

export interface ChartSeries {
  key: string          // kart number
  role: keyof typeof SERIES_COLORS
  label: string
  points: LapPoint[]
}

const AXIS_INK = '#7c86a3'
const GRID_INK = '#232939'

function buildRows(series: ChartSeries[], field: (p: LapPoint, s: ChartSeries) => number | null) {
  const byLap = new Map<number, Record<string, number | null>>()
  for (const s of series) {
    for (const p of s.points) {
      const row = byLap.get(p.lap) ?? { lap: p.lap }
      row[s.key] = field(p, s)
      byLap.set(p.lap, row)
    }
  }
  return [...byLap.values()].sort((a, b) => (a.lap as number) - (b.lap as number))
}

function ChartFrame({ title, children }: { title: string; children: React.ReactElement }) {
  return (
    <div className="rounded-xl bg-pit-900 p-4 ring-1 ring-pit-800">
      <h3 className="label-race mb-3">{title}</h3>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    </div>
  )
}

const tooltipStyle = {
  backgroundColor: '#10131d',
  border: '1px solid #333b52',
  borderRadius: 8,
  fontSize: 12,
  color: '#f4f6fb',
} as const

/** Lap-time trend: own kart vs leader / ahead / behind. */
export function LapTimeChart({ series, lastN = 40 }: { series: ChartSeries[]; lastN?: number }) {
  const { hidden, onLegendClick, legendFormatter } = useHiddenSeries()
  const rows = useMemo(() => {
    const trimmed = series.map((s) => ({ ...s, points: s.points.slice(-lastN) }))
    return buildRows(trimmed, (p) => p.ms)
  }, [series, lastN])

  if (rows.length < 2) {
    return <ChartEmpty title="Lap times" note="Charts appear after a couple of laps." />
  }
  return (
    <ChartFrame title="Lap times">
      <LineChart data={rows} margin={{ top: 4, right: 12, bottom: 0, left: 4 }}>
        <CartesianGrid stroke={GRID_INK} vertical={false} />
        <XAxis dataKey="lap" stroke={AXIS_INK} tick={{ fill: AXIS_INK, fontSize: 11 }} tickLine={false} />
        <YAxis
          stroke={AXIS_INK}
          tick={{ fill: AXIS_INK, fontSize: 11 }}
          tickLine={false}
          width={56}
          domain={['auto', 'auto']}
          tickFormatter={(v: number) => fmtLap(v)}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          labelFormatter={(lap) => `Lap ${lap}`}
          formatter={(value, name) => [fmtLap(value as number), name as string]}
        />
        <Legend
          wrapperStyle={{ fontSize: 12, color: AXIS_INK }}
          onClick={onLegendClick}
          formatter={legendFormatter}
        />
        {series.map((s) => (
          <Line
            key={s.key}
            dataKey={s.key}
            name={s.label}
            hide={hidden.has(s.key)}
            stroke={SERIES_COLORS[s.role]}
            strokeWidth={s.role === 'own' ? 3 : 2}
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ChartFrame>
  )
}

/** Time behind the leader at each completed lap (+ = behind), from the wall
 *  time of the crossings — immune to histories starting on different laps. */
export function GapEvolutionChart({ series }: { series: ChartSeries[] }) {
  const { hidden, onLegendClick, legendFormatter } = useHiddenSeries()
  const rows = useMemo(() => {
    const leader = series.find((s) => s.role === 'leader')
    if (!leader) return []
    const leaderTs = new Map(leader.points.map((p) => [p.lap, p.ts]))
    const others = series.filter((s) => s.role !== 'leader')
    const byLap = new Map<number, Record<string, number | null>>()
    for (const s of others) {
      for (const p of s.points) {
        const ref = leaderTs.get(p.lap)
        if (ref == null || !p.ts) continue
        const row = byLap.get(p.lap) ?? { lap: p.lap }
        row[s.key] = Math.round((p.ts - ref) * 10) / 10   // s, + = behind leader
        byLap.set(p.lap, row)
      }
    }
    return [...byLap.values()].sort((a, b) => (a.lap as number) - (b.lap as number))
  }, [series])

  if (rows.length < 2) {
    return <ChartEmpty title="Gap to leader" note="Needs shared laps with the leader." />
  }
  return (
    <ChartFrame title="Gap to leader (s, + = behind)">
      <LineChart data={rows} margin={{ top: 4, right: 12, bottom: 0, left: 4 }}>
        <CartesianGrid stroke={GRID_INK} vertical={false} />
        <XAxis dataKey="lap" stroke={AXIS_INK} tick={{ fill: AXIS_INK, fontSize: 11 }} tickLine={false} />
        <YAxis stroke={AXIS_INK} tick={{ fill: AXIS_INK, fontSize: 11 }} tickLine={false} width={44} />
        <Tooltip
          contentStyle={tooltipStyle}
          labelFormatter={(lap) => `Lap ${lap}`}
          formatter={(value, name) => [`${value}s behind`, name as string]}
        />
        <Legend
          wrapperStyle={{ fontSize: 12, color: AXIS_INK }}
          onClick={onLegendClick}
          formatter={legendFormatter}
        />
        {series.filter((s) => s.role !== 'leader').map((s) => (
          <Line
            key={s.key}
            dataKey={s.key}
            name={s.label}
            hide={hidden.has(s.key)}
            stroke={SERIES_COLORS[s.role]}
            strokeWidth={s.role === 'own' ? 3 : 2}
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ChartFrame>
  )
}

function ChartEmpty({ title, note }: { title: string; note: string }) {
  return (
    <div className="rounded-xl bg-pit-900 p-4 ring-1 ring-pit-800">
      <h3 className="label-race mb-3">{title}</h3>
      <div className="grid h-56 place-items-center text-sm text-ink-500">{note}</div>
    </div>
  )
}
