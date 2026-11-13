import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  CartesianGrid, Line, LineChart, ReferenceLine, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { LapPoint } from '../lib/types'
import { fmtLap } from '../lib/format'
import { useT } from '../lib/i18n'

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

type Row = Record<string, number | null>

const AXIS_INK = '#7c86a3'
const GRID_INK = '#232939'
const PLOT_H = 220              // plot + x-axis height (px)
const X_AXIS_H = 24
const Y_AXIS_W = 52
const PX_PER_LAP = 26           // full-session charts keep laps this far apart, then scroll
const MARGIN = { top: 10, right: 14, bottom: 0, left: 0 }

const tooltipStyle = {
  backgroundColor: '#10131d',
  border: '1px solid #333b52',
  borderRadius: 10,
  fontSize: 12,
  color: '#f4f6fb',
} as const

function buildRows(series: ChartSeries[], field: (p: LapPoint) => number | null): Row[] {
  const byLap = new Map<number, Row>()
  for (const s of series) {
    for (const p of s.points) {
      const row = byLap.get(p.lap) ?? { lap: p.lap }
      row[s.key] = field(p)
      byLap.set(p.lap, row)
    }
  }
  return [...byLap.values()].sort((a, b) => (a.lap as number) - (b.lap as number))
}

/** Round axis bounds + evenly spaced ticks (1/2/2.5/5 x 10^n steps). */
function niceScale(lo: number, hi: number, count = 5): { domain: [number, number]; ticks: number[]; step: number } {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { domain: [0, 1], ticks: [0, 1], step: 1 }
  if (hi - lo < 1e-9) { lo -= 1; hi += 1 }
  const raw = (hi - lo) / (count - 1)
  const pow = 10 ** Math.floor(Math.log10(raw))
  const m = raw / pow
  const step = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * pow
  const start = Math.floor(lo / step) * step
  const end = Math.ceil(hi / step) * step
  const ticks: number[] = []
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toFixed(6)))
  return { domain: [start, end], ticks, step }
}

/** Compact lap-time axis label: "39.2" under a minute, "1:02.5" above. */
function axisLap(ms: number, step: number): string {
  const digits = step < 100 ? 2 : step < 1000 ? 1 : 0
  if (ms < 60000) return (ms / 1000).toFixed(digits)
  const m = Math.floor(ms / 60000)
  const s = ((ms % 60000) / 1000).toFixed(digits).padStart(digits ? 3 + digits : 2, '0')
  return `${m}:${s}`
}

/** Click-to-toggle series visibility. */
function useHiddenSeries() {
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const toggle = (key: string) => setHidden((cur) => {
    const next = new Set(cur)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
  return { hidden, toggle }
}

function Legend({ series, hidden, onToggle }: {
  series: { key: string; label: string; color: string }[]
  hidden: Set<string>
  onToggle: (key: string) => void
}) {
  if (series.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 px-4 pb-2">
      {series.map((s) => {
        const off = hidden.has(s.key)
        return (
          <button
            key={s.key}
            type="button"
            onClick={() => onToggle(s.key)}
            aria-pressed={!off}
            className={`inline-flex items-center gap-1.5 rounded-full bg-pit-850 px-2.5 py-1 text-xs ring-1 ring-pit-700 transition-opacity ${
              off ? 'opacity-40 line-through' : ''
            }`}
          >
            <span className="h-0.5 w-3.5 rounded-full" style={{ background: s.color }} />
            {s.label}
          </button>
        )
      })}
    </div>
  )
}

interface ChartProps {
  title: string
  rows: Row[]
  series: ChartSeries[]
  hidden: Set<string>
  onToggle: (key: string) => void
  yFormat: (v: number, step: number) => string
  tipFormat: (v: number) => string
  /** Every lap, PX_PER_LAP apart; the plot scrolls sideways when it's wider than the card. */
  fullSession?: boolean
  /** Which end of a scrolling chart to show first: latest laps (live) or lap 1 (results). */
  startAt?: 'start' | 'end'
  overlay?: ReactNode     // extra recharts children (reference lines)
  zeroLine?: boolean
  toolbar?: ReactNode     // controls under the title (e.g. a kart picker)
}

/**
 * The shared chart card. The y-axis sits in its own fixed column and the plot
 * scrolls beside it, so the scale never scrolls out of view. The scroll box
 * measures itself and uses `contain: inline-size` (.scroll-x): however many
 * laps there are, the chart can never widen the page around it.
 */
function TimeChart({ title, rows, series, hidden, onToggle, yFormat, tipFormat,
  fullSession = false, startAt = 'end', overlay, zeroLine = false, toolbar }: ChartProps) {
  const t = useT()
  const scroller = useRef<HTMLDivElement>(null)
  const [boxW, setBoxW] = useState(0)
  const [edges, setEdges] = useState({ left: false, right: false })
  const pinned = useRef(startAt === 'end')   // follow new laps while parked at the end

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = () => setBoxW(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const plotW = Math.max(boxW, fullSession ? rows.length * PX_PER_LAP + MARGIN.right : 0)

  const updateEdges = () => {
    const el = scroller.current
    if (!el) return
    const max = el.scrollWidth - el.clientWidth
    setEdges({ left: el.scrollLeft > 4, right: el.scrollLeft < max - 4 })
    pinned.current = el.scrollLeft >= max - 8
  }
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (pinned.current) el.scrollLeft = el.scrollWidth
    updateEdges()
  }, [plotW, rows.length])

  // One y-scale for both halves, from the visible series only.
  const scale = useMemo(() => {
    let lo = Infinity, hi = -Infinity
    for (const r of rows) {
      for (const s of series) {
        if (hidden.has(s.key)) continue
        const v = r[s.key]
        if (typeof v === 'number') { lo = Math.min(lo, v); hi = Math.max(hi, v) }
      }
    }
    if (zeroLine) { lo = Math.min(lo, 0); hi = Math.max(hi, 0) }
    const pad = (hi - lo) * 0.06
    return niceScale(lo - pad, hi + pad)
  }, [rows, series, hidden, zeroLine])

  const plotH = PLOT_H
  const yProps = {
    domain: scale.domain,
    ticks: scale.ticks,
    allowDataOverflow: true,
    type: 'number' as const,
  }

  return (
    <section className="min-w-0 rounded-2xl bg-pit-900 ring-1 ring-pit-800">
      <header className="flex min-h-12 items-center justify-between gap-2 px-4 pt-3">
        <h3 className="label-race">{title}</h3>
        {fullSession && rows.length > 0 && (
          <span className="text-[0.7rem] text-ink-500">{t('{n} laps', { n: rows.length })}</span>
        )}
      </header>
      {toolbar}
      <Legend series={series} hidden={hidden} onToggle={onToggle} />
      <div className="flex min-w-0 pb-3 pl-1">
        {/* Fixed y-axis column: same height, margins and ticks as the plot. */}
        <LineChart width={Y_AXIS_W} height={plotH} data={rows} margin={{ ...MARGIN, right: 0 }}>
          <XAxis dataKey="lap" height={X_AXIS_H} tick={false} axisLine={false} tickLine={false} />
          <YAxis
            {...yProps}
            width={Y_AXIS_W}
            stroke={AXIS_INK}
            tick={{ fill: AXIS_INK, fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => yFormat(v, scale.step)}
          />
        </LineChart>
        <div className="relative min-w-0 flex-1">
          <div ref={scroller} onScroll={updateEdges} className="scroll-x">
            {plotW > 0 && (
              <LineChart width={plotW} height={plotH} data={rows} margin={MARGIN}>
                <CartesianGrid stroke={GRID_INK} vertical={false} />
                <XAxis
                  dataKey="lap"
                  height={X_AXIS_H}
                  stroke={AXIS_INK}
                  tick={{ fill: AXIS_INK, fontSize: 11 }}
                  tickLine={false}
                  interval="preserveStartEnd"
                  minTickGap={14}
                />
                <YAxis {...yProps} hide />
                <Tooltip
                  contentStyle={tooltipStyle}
                  labelFormatter={(lap) => t('Lap {n}', { n: String(lap) })}
                  formatter={(value, name) => [tipFormat(value as number), name as string]}
                />
                {zeroLine && <ReferenceLine y={0} stroke="#4a5372" />}
                {overlay}
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
            )}
          </div>
          {/* Scroll affordance: fade the edge that has more laps beyond it. */}
          <div className={`pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-pit-900 transition-opacity ${edges.left ? 'opacity-100' : 'opacity-0'}`} />
          <div className={`pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-pit-900 transition-opacity ${edges.right ? 'opacity-100' : 'opacity-0'}`} />
        </div>
      </div>
    </section>
  )
}

/** Lap-time trend: own kart vs its selected comparisons. Pit laps are kept
 *  off the Y-scale (so normal laps stay readable) and drawn as a vertical
 *  marker at that lap carrying the pit lap time. */
export function LapTimeChart({ series, lastN = 40, fullSession = false, startAt = 'end', toolbar, title }: {
  series: ChartSeries[]
  lastN?: number
  fullSession?: boolean   // show every lap of the session, scrolling sideways when there are many
  startAt?: 'start' | 'end'
  toolbar?: ReactNode
  title?: string
}) {
  const t = useT()
  const { hidden, toggle } = useHiddenSeries()
  const trimmed = useMemo(
    () => (fullSession ? series : series.map((s) => ({ ...s, points: s.points.slice(-lastN) }))),
    [series, lastN, fullSession],
  )
  const rows = useMemo(() => buildRows(trimmed, (p) => (p.pit ? null : p.ms)), [trimmed])
  const pitMarks = useMemo(
    () => trimmed.flatMap((s) =>
      hidden.has(s.key) ? [] : s.points.filter((p) => p.pit).map((p) => ({ key: `${s.key}-${p.lap}`, lap: p.lap, ms: p.ms, color: s.color })),
    ),
    [trimmed, hidden],
  )

  if (rows.length < 2) {
    return <ChartEmpty title={title ?? t('Lap times')} note={t('Charts appear after a couple of laps.')} toolbar={toolbar} />
  }
  return (
    <TimeChart
      title={title ?? t('Lap times')}
      toolbar={toolbar}
      rows={rows}
      series={trimmed}
      hidden={hidden}
      onToggle={toggle}
      yFormat={axisLap}
      tipFormat={(v) => fmtLap(v)}
      fullSession={fullSession}
      startAt={startAt}
      overlay={pitMarks.map((m) => (
        <ReferenceLine
          key={m.key}
          x={m.lap}
          stroke={m.color}
          strokeDasharray="3 3"
          label={{ value: 'PIT', position: 'insideTop', fill: m.color, fontSize: 9, fontWeight: 700 }}
        />
      ))}
    />
  )
}

/** Time behind an explicit reference kart at each completed lap (+ = behind),
 *  from the wall time of the crossings — immune to histories starting on
 *  different laps. The caller picks the reference (leader normally; the own
 *  kart when it leads, so the leading team sees the car behind it). */
export function GapEvolutionChart({ series, reference, title = 'Gap to leader (s, + = behind)', fullSession = false }: {
  series: ChartSeries[]
  reference: { key: string; label: string; points: LapPoint[] } | null
  title?: string
  fullSession?: boolean
}) {
  const t = useT()
  const { hidden, toggle } = useHiddenSeries()
  const shown = useMemo(() => series.filter((s) => s.key !== reference?.key), [series, reference])
  const rows = useMemo(() => {
    if (!reference) return []
    const refTs = new Map(reference.points.map((p) => [p.lap, p.ts]))
    const byLap = new Map<number, Row>()
    for (const s of shown) {
      for (const p of s.points) {
        const ref = refTs.get(p.lap)
        if (ref == null || !p.ts) continue
        const row = byLap.get(p.lap) ?? { lap: p.lap }
        row[s.key] = Math.round((p.ts - ref) * 10) / 10   // s, + = behind reference
        byLap.set(p.lap, row)
      }
    }
    return [...byLap.values()].sort((a, b) => (a.lap as number) - (b.lap as number))
  }, [shown, reference])

  if (rows.length < 2) {
    return <ChartEmpty title={t('Gap to leader')} note={t('Needs shared laps between karts.')} />
  }
  return (
    <TimeChart
      title={t(title)}
      rows={rows}
      series={shown}
      hidden={hidden}
      onToggle={toggle}
      yFormat={(v) => `${Number(v.toFixed(2))}`}
      tipFormat={(v) => t('{v}s behind', { v: String(v) })}
      fullSession={fullSession}
      zeroLine
    />
  )
}

function ChartEmpty({ title, note, toolbar }: { title: string; note: string; toolbar?: ReactNode }) {
  return (
    <section className="min-w-0 rounded-2xl bg-pit-900 ring-1 ring-pit-800">
      <header className="flex min-h-12 items-center px-4 pt-3">
        <h3 className="label-race">{title}</h3>
      </header>
      {toolbar}
      <div className="grid h-44 place-items-center px-4 pb-4 text-center text-sm text-ink-500">{note}</div>
    </section>
  )
}
