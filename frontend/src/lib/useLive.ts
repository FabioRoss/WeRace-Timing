import { useCallback, useRef, useState } from 'react'
import type { LiveEvent, RaceMessage, Snapshot } from './types'
import { useJsonSocket } from './ws'

/** Subscribes to a slot's live channel: latest snapshot + message log. */
export function useLive(slot: string | number) {
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

  const { status, lastSeen } = useJsonSocket<LiveEvent>(`/e/${slot}/ws/live`, onMessage)
  return { snapshot, messages, status, lastSeen }
}
