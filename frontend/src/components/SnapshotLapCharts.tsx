import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import type { LapPoint } from '../lib/types'
import { COMPARE_COLORS, LapTimeChart, SERIES_COLORS, type ChartSeries } from './LapCharts'

// Distinct series colours, cycled when more karts than colours are picked.
const PALETTE = [SERIES_COLORS.own, ...COMPARE_COLORS, '#a78bfa', '#f43f5e'] as const

interface KartLite {
  kart_no: string
  name?: string
}

/**
 * Lap-time charts for a saved snapshot: pick karts, fetch their lap-by-lap
 * history from `{baseUrl}/laps`, and draw the trend. Surfaces the full lap data
 * every snapshot already stores. Used by the public results page, event tabs,
 * and the admin editor (pass `safeword` for the admin endpoint).
 */
export function SnapshotLapCharts({ baseUrl, drivers, safeword = false, maxKarts = 5 }: {
  baseUrl: string
  drivers: KartLite[]
  safeword?: boolean
  maxKarts?: number
}) {
  const karts = useMemo(() => drivers.map((d) => d.kart_no).filter(Boolean), [drivers])
  const [selected, setSelected] = useState<string[]>(() => karts.slice(0, 3))
  const [laps, setLaps] = useState<Record<string, LapPoint[]>>({})

  const fetchKey = selected.join(',')
  useEffect(() => {
    if (!fetchKey) { setLaps({}); return }
    let alive = true
    api<{ laps: Record<string, LapPoint[]> }>(
      `${baseUrl}/laps?karts=${encodeURIComponent(fetchKey)}`, { safeword },
    ).then((r) => { if (alive) setLaps(r.laps) }).catch(() => {})
    return () => { alive = false }
  }, [baseUrl, fetchKey, safeword])

  const toggle = (k: string) => setSelected((cur) => {
    if (cur.includes(k)) return cur.filter((x) => x !== k)
    if (cur.length >= maxKarts) return cur   // cap the comparison set
    return [...cur, k]
  })

  const colorFor = (kart: string) => PALETTE[selected.indexOf(kart) % PALETTE.length]

  const series: ChartSeries[] = useMemo(
    () => selected.flatMap((k) => {
      const pts = laps[k]
      if (!pts?.length) return []
      const d = drivers.find((x) => x.kart_no === k)
      const label = d?.name ? `#${k} ${d.name}` : `#${k}`
      return [{ key: k, color: colorFor(k), label, points: pts }]
    }),
    // colorFor is derived from `selected`; drivers only supplies labels.
    [selected, laps, drivers],
  )

  if (!karts.length) return null
  return (
    <div className="space-y-3">
      <div>
        <div className="label-race mb-2">Lap times — pick up to {maxKarts} karts</div>
        <div className="flex flex-wrap gap-1.5">
          {drivers.map((d) => {
            const on = selected.includes(d.kart_no)
            return (
              <button
                key={d.kart_no}
                type="button"
                onClick={() => toggle(d.kart_no)}
                className={`rounded px-2 py-1 text-xs font-semibold ring-1 ${
                  on ? 'text-pit-950 ring-transparent' : 'bg-pit-800 text-ink-300 ring-pit-700 hover:bg-pit-700'
                }`}
                style={on ? { backgroundColor: colorFor(d.kart_no) } : undefined}
              >
                #{d.kart_no}
              </button>
            )
          })}
        </div>
      </div>
      <LapTimeChart series={series} />
    </div>
  )
}
