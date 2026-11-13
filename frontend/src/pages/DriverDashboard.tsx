import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import type { DriverEvent, DriverView } from '../lib/types'
import { useJsonSocket } from '../lib/ws'
import { fmtClock, fmtGap, fmtLap } from '../lib/format'
import { fmtRemaining, useServerNow } from '../lib/lapProgress'
import { DriverAlert, useDriverAlerts } from '../components/MessageOverlay'
import { flagAccent } from '../components/FlagBanner'
import { useT } from '../lib/i18n'
import { FitText, toHundredths } from '../components/FitText'
import { InstallWizard } from '../components/InstallWizard'
import { QrScanner } from '../components/QrScanner'
import { LandscapeBox, RotateHint, useLandscapeLock } from '../components/LandscapeLock'
import {
  goFullscreenLandscape, installSkipped, isStandalone, platform, rememberDriverLink, skipInstall, usePwaHead,
} from '../lib/pwa'

const FLAG_LABEL: Record<string, string> = {
  green: 'GREEN', yellow: 'YELLOW', red: 'RED', finish: 'FINISH',
  warmup: 'WARM UP', stopped: 'STOPPED', none: '',
}

export function DriverDashboard() {
  const t = useT()
  const { slot = '1', token = '' } = useParams()
  const [view, setView] = useState<DriverView | null>(null)
  const [now, setNow] = useState(Date.now())

  // Installable app: the link is remembered so the installed app reopens it;
  // phones not yet running the app get the install guide (once per 12h if skipped).
  const path = `/e/${slot}/driver/${token}`
  usePwaHead(path)
  useEffect(() => { rememberDriverLink(path) }, [path])
  // Checked once: tapping for full screen in a browser tab also matches display-mode: fullscreen.
  const [standalone] = useState(isStandalone)
  const [showInstall, setShowInstall] = useState(
    () => !standalone && platform() !== 'other' && !installSkipped())
  const [scanning, setScanning] = useState(false)
  const onScan = useCallback((next: string) => { window.location.assign(next) }, [])

  // Offset between this phone's clock and the server's, from the server time
  // stamped on each payload — used to tell a fresh message from a replayed one.
  const skew = useRef<number | null>(null)
  const serverSkew = useCallback(() => skew.current ?? 0, [])
  const alerts = useDriverAlerts(`wrb_seen_${slot}_${token}`, serverSkew)
  const { offer } = alerts

  const onEvent = useCallback((msg: DriverEvent) => {
    if (msg.type === 'driver') {
      if (msg.server_ts) skew.current = Date.now() / 1000 - msg.server_ts
      setView(msg)
    } else if (msg.type === 'message') {
      offer(msg)
    }
  }, [offer])
  const { status, lastSeen } = useJsonSocket<DriverEvent>(
    `/e/${slot}/ws/driver/${token}`,
    onEvent,
  )

  // Wake lock + tick for staleness display
  useWakeLock()
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
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
      const timer = setTimeout(() => setGlow(false), 1500)
      return () => clearTimeout(timer)
    }
  }, [view?.laps, view?.in_pit])

  const stale = status !== 'open' || (lastSeen > 0 && now - lastSeen > 10000)
  const accent = flagAccent(view?.flag ?? 'none')
  const serverNow = useServerNow(view?.updated_at ?? 0, 1000)
  const remaining = view ? fmtRemaining(view, serverNow) : '--:--'

  // Unserved time penalties the driver has been told about (notified once the
  // grace window passed): what is left to serve in the pit lane.
  const toServe = useMemo(
    () => (view?.penalties ?? [])
      .filter((p) => p.kind === 'time' && !p.served && p.notified)
      .reduce((sum, p) => sum + p.seconds, 0),
    [view?.penalties],
  )

  const requestFullscreen = goFullscreenLandscape
  const lock = useLandscapeLock()
  const boxH = lock.height

  // Overlays shared by every state of the screen.
  const overlays = (
    <>
      {showInstall && <InstallWizard onSkip={() => { skipInstall(); setShowInstall(false) }} />}
      {scanning && <QrScanner onResult={onScan} onClose={() => setScanning(false)} />}
    </>
  )
  // New race, same app: scan the next QR code (only inside the installed app —
  // in a browser the phone camera opens the link directly).
  const scanButton = standalone && (
    <button type="button" className="btn btn-quiet"
      onClick={(e) => { e.stopPropagation(); setScanning(true) }}>
      <QrIcon /> {t('Scan new QR')}
    </button>
  )

  // The dashboard lives on a stage pinned to the phone's landscape (see
  // LandscapeLock); install guide and QR scanner stay upright, outside it.
  const frame = (shell: React.ReactNode) => (
    <>
      <LandscapeBox lock={lock}>{shell}</LandscapeBox>
      <RotateHint lock={lock} />
      {overlays}
    </>
  )

  if (view && !view.found) {
    return frame(
      <Shell accent={accent} onTap={requestFullscreen}>
        <div className="grid flex-1 place-items-center px-8 text-center">
          <div>
            <div className="label-race mb-2">{t('Waiting for timing')}</div>
            <p className="text-xl text-ink-300">
              {t("Your kart isn't in the live feed yet.")}
              <br />
              {t('This screen starts automatically when the session begins.')}
            </p>
            {view.time_to_go && (
              <p className="timing mt-6 text-5xl font-bold">{view.time_to_go}</p>
            )}
            {scanButton && (
              <div className="mt-6">
                <p className="mb-2 text-sm text-ink-500">{t('Different race or kart?')}</p>
                {scanButton}
              </div>
            )}
          </div>
        </div>
      </Shell>,
    )
  }

  return frame(
    <Shell accent={accent} onTap={requestFullscreen} glow={glow}>
      <DriverAlert message={alerts.current} pending={alerts.pending} onDone={alerts.next} />

      {/* Top strip: session + flag + position */}
      <div className="flex items-stretch justify-between gap-3 px-4 pt-2">
        <div className="min-w-0">
          <div className="label-race">{t('Remaining')}</div>
          <div className="timing truncate text-3xl font-extrabold leading-none sm:text-4xl">
            {remaining}
          </div>
        </div>
        <div className="flex items-center">
          {view?.flag && FLAG_LABEL[view.flag] && (
            <span
              className="rounded px-3 py-1 text-sm font-extrabold tracking-[0.2em]"
              style={{ background: accent, color: '#07080c' }}
            >
              {t(FLAG_LABEL[view.flag])}
            </span>
          )}
          {toServe > 0 && (
            <span
              className="ml-2 inline-flex items-baseline gap-1 rounded border border-race-red/70 px-2 py-0.5 text-race-red"
              title={t('Time penalty to serve')}
            >
              <span className="text-[0.6rem] font-bold tracking-wider">{t('PEN')}</span>
              <span className="timing text-sm font-extrabold">+{toServe}s</span>
            </span>
          )}
          {stale && (
            <span className="ml-2 rounded bg-pit-700 px-2 py-1 text-xs text-race-yellow msg-flash">
              {t('STALE')}
            </span>
          )}
        </div>
        <div className="shrink-0 text-right">
          <div className="label-race">{t('Position')}</div>
          <div className="leading-none">
            <span className="timing text-4xl font-extrabold sm:text-5xl">
              {view?.position || '–'}
            </span>
            <span className="timing text-xl text-ink-500">/{view?.total_karts || '–'}</span>
          </div>
        </div>
      </div>

      {/* Middle: gaps + last lap */}
      <div className="grid flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)_minmax(0,1fr)] items-center gap-3 px-4">
        <GapCell
          label={`${t('Ahead')} ${view?.kart_ahead ? `· #${view.kart_ahead}` : ''}`}
          value={view?.position === 1 ? t('LEADER') : fmtGap(view?.gap_ahead)}
          tone="text-race-green"
          h={boxH}
        />
        <div className="min-w-0 text-center">
          <div className="label-race">{t('Last lap')}</div>
          <LastLap ms={view?.last_lap_ms} h={boxH} />
          <div className="mt-1 text-sm text-ink-500 timing">
            {t('best {v}', { v: fmtLap(view?.best_lap_ms) })}
          </div>
        </div>
        <GapCell
          label={`${t('Behind')} ${view?.kart_behind ? `· #${view.kart_behind}` : ''}`}
          value={fmtGap(view?.gap_behind)}
          tone="text-race-red"
          h={boxH}
          right
        />
      </div>

      {/* Bottom strip */}
      <div className="grid grid-cols-[repeat(4,minmax(0,1fr))_auto] gap-2 px-4 pb-3">
        <Stat label={t('Stint')} value={view?.stint_seconds != null ? fmtClock(view.stint_seconds) : '--:--'} />
        <Stat label={t('Laps')} value={String(view?.laps ?? '–')} />
        <Stat label={t('Pits')} value={String(view?.pits ?? '–')} />
        <Stat
          label={t('Kart')}
          value={view?.kart_no ? `#${view.kart_no}` : '–'}
          sub={view?.name}
        />
        {/* Small tools: turn the screen 180° (phone mounted the other way), new QR. */}
        <div className="flex w-11 flex-col gap-1.5">
          <ToolButton label={t('Turn screen upside down')} onClick={lock.flip}><FlipIcon /></ToolButton>
          {standalone && (
            <ToolButton label={t('Scan new QR')} onClick={() => setScanning(true)}><QrIcon /></ToolButton>
          )}
        </div>
      </div>

    </Shell>,
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
      className={`flex h-full select-none flex-col overflow-hidden bg-pit-950 ${glow ? 'lap-glow' : ''}`}
      style={{
        borderTop: `6px solid ${accent}`,
        borderBottom: `6px solid ${accent}`,
        // Keep every readout clear of the notch, rounded corners and home
        // indicator in landscape (viewport-fit=cover exposes these insets;
        // LandscapeBox maps them to the sides they land on when rotated).
        paddingLeft: 'var(--sa-left)',
        paddingRight: 'var(--sa-right)',
        paddingTop: 'var(--sa-top)',
        paddingBottom: 'var(--sa-bottom)',
      }}
      onClick={onTap}
    >
      {children}
    </div>
  )
}

/**
 * Font cap for the big readouts: a share of the screen height (landscape
 * phones are short), within a fixed maximum.
 */
function bigPx(share: number, max: number, height: number): number {
  return Math.round(Math.min(max, Math.max(28, height * share)))
}

/** Last lap, as large as the column allows: full time, or cut to hundredths. Never "…". */
function LastLap({ ms, h }: { ms: number | null | undefined; h: number }) {
  const full = fmtLap(ms)
  return (
    <FitText full={full} short={toHundredths(full)} maxPx={bigPx(0.2, 96, h)} minPx={34}
      className="timing font-extrabold leading-tight" />
  )
}

function ToolButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label}
      className="grid min-h-0 flex-1 place-items-center rounded-lg bg-pit-850 text-ink-500 [min-height:0]"
      onClick={(e) => { e.stopPropagation(); onClick() }}>
      {children}
    </button>
  )
}

function FlipIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 12a8 8 0 0 1-14.3 4.9" /><path d="M4 12a8 8 0 0 1 14.3-4.9" />
      <path d="M18.5 3v4.2h-4.2" /><path d="M5.5 21v-4.2h4.2" />
    </svg>
  )
}

function QrIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3" />
    </svg>
  )
}

function GapCell({ label, value, tone, h, right = false }: {
  label: string
  h: number
  value: string
  tone: string
  right?: boolean
}) {
  return (
    <div className={`min-w-0 ${right ? 'text-right' : ''}`}>
      <div className="label-race">{label}</div>
      <FitText full={value} maxPx={bigPx(0.115, 52, h)}
        className={`timing font-extrabold leading-tight ${tone}`} />
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
