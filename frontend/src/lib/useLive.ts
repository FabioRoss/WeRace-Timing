import { useCallback, useRef, useState } from 'react'
import type { LiveEvent, RaceMessage, Snapshot } from './types'
import { useJsonSocket } from './ws'
import { getSafeword } from './api'

/** Subscribes to a slot's live channel: latest snapshot + message log.
 *  `staff` sends the safeword, so penalties race control is holding back from
 *  the public are still included (Race Control, Export). */
export function useLive(slot: string | number, { staff = false }: { staff?: boolean } = {}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [messages, setMessages] = useState<RaceMessage[]>([])
  const seen = useRef<Set<number>>(new Set())

  const onMessage = useCallback((msg: LiveEvent) => {
    if (msg.type === 'snapshot') {
      setSnapshot(msg)
    } else if (msg.type === 'message') {
      if (!seen.current.has(msg.id)) {
        seen.current.add(msg.id)
        setMessages((prev) => [...prev.slice(-99), msg])
      }
    }
  }, [])

  const path = staff
    ? `/e/${slot}/ws/live?safeword=${encodeURIComponent(getSafeword())}`
    : `/e/${slot}/ws/live`
  const { status, lastSeen } = useJsonSocket<LiveEvent>(path, onMessage)
  return { snapshot, messages, status, lastSeen }
}
