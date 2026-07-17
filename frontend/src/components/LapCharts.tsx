import { useMemo, useState } from 'react'
import {
  CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer,
  Tooltip, XAxis, YAxis, Legend,
} from 'recharts'
import type { LapPoint } from '../lib/types'
import { fmtLap } from '../lib/format'
import { useT } from '../lib/i18n'

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
   Color follows the entity, never rank order. */
export const SERIES_COLORS = {
  own: '#2fd058',      // green — matches the followed kart on the ring
} as const

// Comparison colors for user-selected karts; distinct from the ring's
// green/purple/red/blue/yellow so selections pop and match across ring + charts.
export const COMPARE_COLORS = ['#f59e0b', '#06b6d4', '#ec4899'] as const   // amber, cyan, pink

export interface ChartSeries {
  key: string          // kart number
  color: string
  label: string
  points: LapPoint[]
  width?: number       // stroke width (own kart is drawn thicker)
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

/** Lap-time trend: own kart vs its selected comparisons. Pit laps are kept
 *  off the Y-scale (so normal laps stay readable) and drawn as a vertical
 *  marker at that lap carrying the pit lap time. */
export function LapTimeChart({ series, lastN = 40 }: { series: ChartSeries[]; lastN?: number }) {
  const t = useT()
  const { hidden, onLegendClick, legendFormatter } = useHiddenSeries()
  const trimmed = useMemo(
    () => series.map((s) => ({ ...s, points: s.points.slice(-lastN) })),
    [series, lastN],
  )
  const rows = useMemo(
    () => buildRows(trimmed, (p) => (p.pit ? null : p.ms)),   // pit laps off the scale
    [trimmed],
  )
  const pitMarks = useMemo(
    () => trimmed.flatMap((s) =>
      hidden.has(s.key) ? [] : s.points.filter((p) => p.pit).map((p) => ({ key: `${s.key}-${p.lap}`, lap: p.lap, ms: p.ms, color: s.color })),
    ),
    [trimmed, hidden],
  )

  if (rows.length < 2) {
    return <ChartEmpty title={t('Lap times')} note={t('Charts appear after a couple of laps.')} />
  }
  return (
    <ChartFrame title={t('Lap times')}>
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
        {pitMarks.map((m) => (
          <ReferenceLine
            key={m.key}
            x={m.lap}
            stroke={m.color}
            strokeDasharray="3 3"
            label={{ value: `pit ${fmtLap(m.ms)}`, position: 'insideTopLeft', fill: m.color, fontSize: 9, angle: -90 }}
          />
        ))}
        {series.map((s) => (
          <Line
            key={s.key}
            dataKey={s.key}
            name={s.label}
            hide={hidden.has(s.key)}
            stroke={s.color}
            strokeWidth={s.width ?? 2}
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ChartFrame>
  )
}

/** Time behind an explicit reference kart at each completed lap (+ = behind),
 *  from the wall time of the crossings — immune to histories starting on
 *  different laps. The caller picks the reference (leader normally; the own
 *  kart when it leads, so the leading team sees the car behind it). */
export function GapEvolutionChart({ series, reference, title = 'Gap to leader (s, + = behind)' }: {
  series: ChartSeries[]
  reference: { key: string; label: string; points: LapPoint[] } | null
  title?: string
}) {
  const t = useT()
  const { hidden, onLegendClick, legendFormatter } = useHiddenSeries()
  const rows = useMemo(() => {
    if (!reference) return []
    const refTs = new Map(reference.points.map((p) => [p.lap, p.ts]))
    const byLap = new Map<number, Record<string, number | null>>()
    for (const s of series) {
      if (s.key === reference.key) continue
      for (const p of s.points) {
        const ref = refTs.get(p.lap)
        if (ref == null || !p.ts) continue
        const row = byLap.get(p.lap) ?? { lap: p.lap }
        row[s.key] = Math.round((p.ts - ref) * 10) / 10   // s, + = behind reference
        byLap.set(p.lap, row)
      }
    }
    return [...byLap.values()].sort((a, b) => (a.lap as number) - (b.lap as number))
  }, [series, reference])

  if (rows.length < 2) {
    return <ChartEmpty title={t('Gap to leader')} note={t('Needs shared laps between karts.')} />
  }
  return (
    <ChartFrame title={t(title)}>
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
        {series.filter((s) => s.key !== reference?.key).map((s) => (
          <Line
            key={s.key}
            dataKey={s.key}
            name={s.label}
            hide={hidden.has(s.key)}
            stroke={s.color}
            strokeWidth={s.width ?? 2}
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
