import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { DriverEvent, DriverView, RaceMessage } from '../lib/types'
import { useJsonSocket } from '../lib/ws'
import { fmtClock, fmtGap, fmtLap } from '../lib/format'
import { fmtRemaining, useServerNow } from '../lib/lapProgress'
import { MessageOverlay } from '../components/MessageOverlay'
import { flagAccent } from '../components/FlagBanner'

const FLAG_LABEL: Record<string, string> = {
  green: 'GREEN', yellow: 'YELLOW', red: 'RED', finish: 'FINISH',
  warmup: 'WARM UP', stopped: 'STOPPED', none: '',
}

export function DriverDashboard() {
  const { slot = '1', token = '' } = useParams()
  const [view, setView] = useState<DriverView | null>(null)
  const [message, setMessage] = useState<RaceMessage | null>(null)
  const [now, setNow] = useState(Date.now())

  const onEvent = useCallback((msg: DriverEvent) => {
    if (msg.type === 'driver') setView(msg)
    else if (msg.type === 'message') setMessage(msg)
  }, [])
  const { status, lastSeen } = useJsonSocket<DriverEvent>(
    `/e/${slot}/ws/driver/${token}`,
    onEvent,
  )

  // Wake lock + tick for staleness display
  useWakeLock()
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  // Glow briefly when the driver crosses the start/finish line
  const prevLap = useRef<number | undefined>(undefined)
  const [glow, setGlow] = useState(false)
  useEffect(() => {
    const laps = view?.laps
    if (laps == null) return
    const prev = prevLap.current
    prevLap.current = laps
    if (prev !== undefined && laps > prev && !view?.in_pit) {
      setGlow(true)
      const t = setTimeout(() => setGlow(false), 1500)
      return () => clearTimeout(t)
    }
  }, [view?.laps, view?.in_pit])

  const stale = status !== 'open' || (lastSeen > 0 && now - lastSeen > 10000)
  const accent = flagAccent(view?.flag ?? 'none')
  const serverNow = useServerNow(view?.updated_at ?? 0, 1000)
  const remaining = view ? fmtRemaining(view, serverNow) : '--:--'

  const requestFullscreen = () => {
    const el = document.documentElement
    if (!document.fullscreenElement) el.requestFullscreen?.().catch(() => {})
  }

  if (view && !view.found) {
    return (
      <Shell accent={accent} onTap={requestFullscreen}>
        <div className="grid flex-1 place-items-center px-8 text-center">
          <div>
            <div className="label-race mb-2">Waiting for timing</div>
            <p className="text-xl text-ink-300">
              Your kart isn't in the live feed yet.
              <br />
              This screen starts automatically when the session begins.
            </p>
            {view.time_to_go && (
              <p className="timing mt-6 text-5xl font-bold">{view.time_to_go}</p>
            )}
          </div>
        </div>
      </Shell>
    )
  }

  return (
    <Shell accent={accent} onTap={requestFullscreen} glow={glow}>
      <MessageOverlay message={message} onDismiss={() => setMessage(null)} />

      {/* Top strip: session + flag + position */}
      <div className="flex items-stretch justify-between gap-3 px-4 pt-2">
        <div>
          <div className="label-race">Remaining</div>
          <div className="timing text-4xl font-extrabold leading-none sm:text-5xl">
            {remaining}
          </div>
        </div>
        <div className="flex items-center">
          {view?.flag && FLAG_LABEL[view.flag] && (
            <span
              className="rounded px-3 py-1 text-sm font-extrabold tracking-[0.2em]"
              style={{ background: accent, color: '#07080c' }}
            >
              {FLAG_LABEL[view.flag]}
            </span>
          )}
          {stale && (
            <span className="ml-2 rounded bg-pit-700 px-2 py-1 text-xs text-race-yellow msg-flash">
              STALE
            </span>
          )}
        </div>
        <div className="text-right">
          <div className="label-race">Position</div>
          <div className="leading-none">
            <span className="timing text-5xl font-extrabold sm:text-6xl">
              {view?.position || '–'}
            </span>
            <span className="timing text-2xl text-ink-500">/{view?.total_karts || '–'}</span>
          </div>
        </div>
      </div>

      {/* Middle: gaps + last lap */}
      <div className="grid flex-1 grid-cols-3 items-center gap-2 px-4">
        <GapCell
          label={`Ahead ${view?.kart_ahead ? `· #${view.kart_ahead}` : ''}`}
          value={view?.position === 1 ? 'LEADER' : fmtGap(view?.gap_ahead)}
          tone="text-race-green"
        />
        <div className="text-center">
          <div className="label-race">Last lap</div>
          <div className="timing text-6xl font-extrabold leading-tight sm:text-7xl">
            {fmtLap(view?.last_lap_ms)}
          </div>
          <div className="mt-1 text-sm text-ink-500 timing">
            best {fmtLap(view?.best_lap_ms)}
          </div>
        </div>
        <GapCell
          label={`Behind ${view?.kart_behind ? `· #${view.kart_behind}` : ''}`}
          value={fmtGap(view?.gap_behind)}
          tone="text-race-red"
          right
        />
      </div>

      {/* Bottom strip */}
      <div className="grid grid-cols-4 gap-2 px-4 pb-3">
        <Stat label="Stint" value={view?.stint_seconds != null ? fmtClock(view.stint_seconds) : '--:--'} />
        <Stat label="Laps" value={String(view?.laps ?? '–')} />
        <Stat label="Pits" value={String(view?.pits ?? '–')} />
        <Stat
          label="Kart"
          value={view?.kart_no ? `#${view.kart_no}` : '–'}
          sub={view?.name}
        />
      </div>
    </Shell>
  )
}

function Shell({ children, accent, onTap, glow = false }: {
  children: React.ReactNode
  accent: string
  onTap: () => void
  glow?: boolean
}) {
  return (
    <div
      className={`flex h-dvh select-none flex-col overflow-hidden bg-pit-950 ${glow ? 'lap-glow' : ''}`}
      style={{ borderTop: `6px solid ${accent}`, borderBottom: `6px solid ${accent}` }}
      onClick={onTap}
    >
      {children}
      <RotateHint />
    </div>
  )
}

function GapCell({ label, value, tone, right = false }: {
  label: string
  value: string
  tone: string
  right?: boolean
}) {
  return (
    <div className={right ? 'text-right' : ''}>
      <div className="label-race">{label}</div>
      <div className={`timing text-5xl font-extrabold leading-tight sm:text-6xl ${tone}`}>
        {value}
      </div>
    </div>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg bg-pit-850 px-3 py-1.5">
      <div className="label-race">{label}</div>
      <div className="timing text-xl font-bold leading-tight">{value}</div>
      {sub && <div className="truncate text-[0.65rem] text-ink-500">{sub}</div>}
    </div>
  )
}

/** Portrait hint — the dashboard is designed for landscape. */
function RotateHint() {
  return (
    <div className="pointer-events-none fixed inset-0 z-40 hidden place-items-center bg-pit-950/95 portrait:grid">
      <div className="text-center">
        <div className="mx-auto mb-4 h-10 w-16 rotate-90 rounded-md border-2 border-ink-500" />
        <p className="text-ink-300">Rotate your phone to landscape</p>
      </div>
    </div>
  )
}

function useWakeLock() {
  const lock = useRef<WakeLockSentinel | null>(null)
  useEffect(() => {
    const acquire = async () => {
      try {
        lock.current = await navigator.wakeLock?.request('screen')
      } catch { /* unsupported or denied — harmless */ }
    }
    void acquire()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquire()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      void lock.current?.release()
    }
  }, [])
}
