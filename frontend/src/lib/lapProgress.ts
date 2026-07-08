import { useEffect, useRef, useState } from 'react'
import type { DriverRow, Snapshot } from './types'

/** Re-renders at `tickMs` and returns the current time on the SERVER clock
 *  (prog_ts anchors are server wall time; correct for client clock skew). */
export function useServerNow(snapshot: Snapshot, tickMs = 300): number {
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), tickMs)
    return () => clearInterval(t)
  }, [tickMs])
  const skewRef = useRef(0)
  useEffect(() => {
    if (snapshot.updated_at > 0) {
      skewRef.current = Date.now() / 1000 - snapshot.updated_at
    }
  }, [snapshot.updated_at])
  return Date.now() / 1000 - skewRef.current
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
