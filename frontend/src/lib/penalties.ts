import type { Penalty } from './types'

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

/** Short label for a penalty's effect, e.g. "+10s", "−1 lap", "Warning". */
export function penaltyLabel(p: Penalty): string {
  if (p.kind === 'warning') return 'Warning'
  if (p.kind === 'lap') return `−${p.laps} lap${p.laps === 1 ? '' : 's'}`
  return `+${p.seconds}s`
}

/** Longer label for the notification/log heading. */
export function penaltyKindLabel(p: Penalty): string {
  if (p.kind === 'warning') return 'Warning'
  if (p.kind === 'lap') return 'Lap penalty'
  return 'Time penalty'
}

/** Tailwind classes for the kind badge (severity: warning < lap < time). */
export function penaltyBadgeClass(p: Penalty): string {
  if (p.kind === 'warning') return 'bg-race-yellow text-pit-950'
  return 'bg-race-red text-white'
}

/** Time penalties are served in the pit lane; lap penalties are results-only. */
export function isServable(p: Penalty): boolean {
  return p.kind === 'time'
}
