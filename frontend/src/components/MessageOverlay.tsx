import { useCallback, useEffect, useRef, useState } from 'react'
import type { RaceMessage } from '../lib/types'
import { useT } from '../lib/i18n'

/**
 * Full-screen alerts for the driver: race-control and pit-wall messages,
 * including penalty and warning notifications (they arrive as race-control
 * messages once their grace window has passed). Each covers the whole screen
 * in huge type, closes itself after a few seconds, and the next one follows.
 * There is deliberately no history while driving.
 */

const DURATION_MS: Record<RaceMessage['priority'], number> = {
  info: 6000,
  warning: 8000,
  urgent: 10000,
}

const TONE: Record<RaceMessage['priority'], string> = {
  info: 'bg-race-blue text-white',
  warning: 'bg-race-yellow text-pit-950',
  urgent: 'bg-race-red text-white',
}

const SENDER: Record<RaceMessage['sender'], string> = {
  race_control: 'RACE CONTROL',
  team_manager: 'PIT WALL',
}

// The server replays a kart's last messages on every (re)connect, and signal
// drops on track are routine — so remember what was shown, and ignore anything
// older than this on a fresh load.
const MAX_AGE_S = 45
const SEEN_CAP = 60

/** Queue of fresh messages to show; `offer` dedupes and drops stale replays. */
export function useDriverAlerts(storageKey: string, serverSkewS: () => number) {
  const [queue, setQueue] = useState<RaceMessage[]>([])
  const seen = useRef<Set<number>>(new Set())

  useEffect(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(storageKey) ?? '[]')
      if (Array.isArray(raw)) seen.current = new Set(raw.filter((n) => typeof n === 'number'))
    } catch { /* nothing remembered */ }
  }, [storageKey])

  const remember = useCallback((id: number) => {
    seen.current.add(id)
    try {
      localStorage.setItem(storageKey, JSON.stringify([...seen.current].slice(-SEEN_CAP)))
    } catch { /* storage full or blocked — dedupe still works in memory */ }
  }, [storageKey])

  const offer = useCallback((m: RaceMessage) => {
    if (seen.current.has(m.id)) return
    const serverNow = Date.now() / 1000 - serverSkewS()
    remember(m.id)
    if (serverNow - m.ts > MAX_AGE_S) return     // a replay of something old
    setQueue((q) => [...q, m])
  }, [remember, serverSkewS])

  const next = useCallback(() => setQueue((q) => q.slice(1)), [])
  return { current: queue[0] ?? null, pending: queue.length, offer, next }
}

export function DriverAlert({ message, pending, onDone }: {
  message: RaceMessage | null
  pending: number
  onDone: () => void
}) {
  const t = useT()
  // Auto-close: the timer restarts for each message.
  useEffect(() => {
    if (!message) return
    const timer = setTimeout(onDone, DURATION_MS[message.priority])
    return () => clearTimeout(timer)
  }, [message, onDone])

  if (!message) return null
  const len = message.text.length
  // Type as large as the text allows while still fitting a landscape phone.
  const size = len <= 18 ? 'min(13vw, 30vh)' : len <= 40 ? 'min(9vw, 20vh)' : len <= 90 ? 'min(6.5vw, 14vh)' : 'min(5vw, 10vh)'
  return (
    <button
      key={message.id}
      type="button"
      onClick={(e) => { e.stopPropagation(); onDone() }}
      className={`rise-in fixed inset-0 z-50 flex flex-col text-left ${TONE[message.priority]}`}
      style={{
        paddingTop: 'max(1rem, env(safe-area-inset-top))',
        paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
        paddingLeft: 'max(1.5rem, env(safe-area-inset-left))',
        paddingRight: 'max(1.5rem, env(safe-area-inset-right))',
      }}
      aria-live="assertive"
    >
      <div className="flex w-full items-center justify-between gap-4 text-sm font-extrabold tracking-[0.3em] opacity-85">
        <span>{t(SENDER[message.sender])}</span>
        {pending > 1 && <span className="timing tracking-normal">1 / {pending}</span>}
      </div>
      <p
        className="grid w-full flex-1 place-items-center text-center font-extrabold leading-[1.05] [text-wrap:balance]"
        style={{ fontSize: size }}
      >
        {message.text}
      </p>
      {/* Time left before it closes itself. */}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/20">
        <div
          key={message.id}
          className="drain h-full rounded-full bg-current opacity-60"
          style={{ ['--dur' as string]: `${DURATION_MS[message.priority]}ms` }}
        />
      </div>
    </button>
  )
}
