import type { DriverRow, Penalty, Snapshot } from './types'

// Reason presets offered in Race Control (free text is always allowed too).
export const PENALTY_REASONS = [
  'Contact',
  'Aggressive/dangerous driving',
  'Track limits',
  'Jump start',
  'Ignoring flags',
]

// Quick-pick amounts for time / lap penalties.
export const TIME_PENALTY_PRESETS = [5, 10, 30]
export const LAP_PENALTY_PRESETS = [1, 2]

/** Short label for a penalty's effect, e.g. "+10s", "−1 lap", "Warning". A time
 * adjustment is signed (e.g. "+24s" / "−10s"). */
export function penaltyLabel(p: Penalty): string {
  if (p.kind === 'warning') return 'Warning'
  if (p.kind === 'lap') return `−${p.laps} lap${p.laps === 1 ? '' : 's'}`
  if (p.kind === 'adjust') return `${p.seconds >= 0 ? '+' : '−'}${Math.abs(p.seconds)}s`
  return `+${p.seconds}s`
}

/** Longer label for the notification/log heading. */
export function penaltyKindLabel(p: Penalty): string {
  if (p.kind === 'warning') return 'Warning'
  if (p.kind === 'lap') return 'Lap penalty'
  if (p.kind === 'adjust') return 'Time adjustment'
  return 'Time penalty'
}

/** Tailwind classes for the kind badge. Adjustments are neutral (a correction,
 * not a sanction); penalties are red; warnings amber. */
export function penaltyBadgeClass(p: Penalty): string {
  if (p.kind === 'warning') return 'bg-race-yellow text-pit-950'
  if (p.kind === 'adjust') return 'bg-race-blue text-white'
  return 'bg-race-red text-white'
}

/** Time penalties are served in the pit lane; lap penalties are results-only. */
export function isServable(p: Penalty): boolean {
  return p.kind === 'time'
}

/** Gap string of `d` relative to `ref` from laps + cumulative time — mirrors the
 * backend `_classify_gap`: same lap -> "S.mmm" behind; laps down -> "+N L". */
function classifyGap(d: DriverRow, ref: DriverRow | null): string {
  if (!ref || ref === d) return ''
  const lapsDown = ref.laps - d.laps
  if (lapsDown > 0) return `+${lapsDown} L`
  if (d.total_time_ms != null && ref.total_time_ms != null) {
    const delta = (d.total_time_ms - ref.total_time_ms) / 1000
    return delta >= 0 ? delta.toFixed(3) : ''
  }
  return ''
}

/** The standings recomputed with outstanding (unserved, non-warning) penalties
 * applied — time penalties add to total time, lap penalties subtract laps —
 * then re-sorted by (-laps, total time) with fresh position / gap-to-leader /
 * interval. Mirrors the PDF's `_penalty_adjusted_drivers`. Best lap and pit
 * counts are penalty-independent, so they carry over unchanged. */
export function penaltyAdjustedDrivers(snapshot: Snapshot | null): DriverRow[] {
  const drivers = snapshot?.drivers ?? []
  const add = new Map<string, { seconds: number; laps: number }>()
  for (const p of snapshot?.penalties ?? []) {
    if (p.kind === 'warning' || p.served) continue
    const a = add.get(p.kart_no) ?? { seconds: 0, laps: 0 }
    // Time penalties and signed time adjustments both fold into total time.
    if (p.kind === 'time' || p.kind === 'adjust') a.seconds += p.seconds
    else if (p.kind === 'lap') a.laps += p.laps
    add.set(p.kart_no, a)
  }
  const adjusted = drivers.map((d) => {
    const a = add.get(d.kart_no)
    if (!a) return { ...d }
    return {
      ...d,
      laps: Math.max(0, d.laps - a.laps),
      total_time_ms: d.total_time_ms != null ? d.total_time_ms + a.seconds * 1000 : d.total_time_ms,
    }
  })
  adjusted.sort((x, y) =>
    (y.laps - x.laps)
    || ((x.total_time_ms ?? Infinity) - (y.total_time_ms ?? Infinity)))
  const leader = adjusted[0] ?? null
  adjusted.forEach((d, i) => {
    d.position = i + 1
    d.gap_leader = classifyGap(d, leader)
    d.gap_ahead = classifyGap(d, i > 0 ? adjusted[i - 1] : null)
  })
  return adjusted
}
