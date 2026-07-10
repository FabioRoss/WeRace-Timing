import { useEffect, useRef, useState } from 'react'
import { fmtClock } from './format'
import type { DriverRow } from './types'

/** Re-renders at `tickMs` and returns the current time on the SERVER clock
 *  (backend timestamps are server wall time; correct for client clock skew
 *  using the last snapshot's updated_at). */
export function useServerNow(updatedAt: number, tickMs = 300): number {
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), tickMs)
    return () => clearInterval(t)
  }, [tickMs])
  const skewRef = useRef(0)
  useEffect(() => {
    if (updatedAt > 0) {
      skewRef.current = Date.now() / 1000 - updatedAt
    }
  }, [updatedAt])
  return Date.now() / 1000 - skewRef.current
}

interface RemainingLike {
  time_to_go: string
  togo_ms?: number | null
  togo_ts?: number | null
  counting?: boolean
}

/** Remaining-session clock: ticks down locally from the last server anchor
 *  (re-synced every snapshot), falls back to the raw text ("13 laps", …). */
export function fmtRemaining(race: RemainingLike, serverNow: number): string {
  if (race.togo_ms == null || race.togo_ts == null) {
    return race.time_to_go || '--:--'
  }
  let ms = race.togo_ms
  if (race.counting) {
    ms -= Math.max(serverNow - race.togo_ts, 0) * 1000
  }
  return fmtClock(Math.max(Math.round(ms / 1000), 0))
}

/** Fraction of the lap completed (0..1), interpolated between the last
 *  timing event and the next expected one (Apex sector anchors), or null
 *  when the kart's position on track is unknown. */
export function lapFraction(d: DriverRow, serverNow: number): number | null {
  if (d.prog_ts == null) return null
  let p = d.prog_from
  if (d.prog_ms) {
    const t = ((serverNow - d.prog_ts) * 1000) / d.prog_ms
    p = d.prog_from + (d.prog_to - d.prog_from) * Math.min(Math.max(t, 0), 1)
  }
  return Math.min(Math.max(p, 0), 1)
}
