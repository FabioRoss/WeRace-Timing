/** Milliseconds -> "M:SS.mmm" lap time (or placeholder). */
export function fmtLap(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '--:--.-'
  const totalSeconds = Math.floor(ms / 1000)
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  const frac = ms % 1000
  return `${m}:${String(s).padStart(2, '0')}.${String(frac).padStart(3, '0')}`
}

/** Milliseconds -> "SS.mmm" sector time (falls back to lap format >60s). */
export function fmtSector(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '\u2014'
  if (ms >= 60000) return fmtLap(ms)
  const s = Math.floor(ms / 1000)
  return `${s}.${String(ms % 1000).padStart(3, '0')}`
}

/** Seconds -> "H:MM:SS" or "MM:SS" stint/clock display. */
export function fmtClock(seconds: number | null | undefined): string {
  if (seconds == null || seconds < 0) return '--:--'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** Gap strings from the feeds are already formatted; add a placeholder. */
export function fmtGap(gap: string | undefined | null): string {
  const g = (gap ?? '').trim()
  return g === '' ? '—' : g
}

export function fmtTimeOfDay(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}
