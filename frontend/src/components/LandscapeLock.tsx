import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useT } from '../lib/i18n'

/**
 * Software landscape lock for the driver screen.
 *
 * iOS ignores the manifest orientation and has no orientation-lock API, so on
 * a kart the G forces rotate the screen. Instead of relying on the OS, the
 * dashboard is pinned to the phone's physical frame: we remember which
 * landscape the phone was in (`locked`, as an OS screen angle) and, whenever the
 * OS rotates the viewport to another angle, rotate our content back by the
 * difference. The driver sees no change at all.
 *
 * Angles are the OS screen rotation (window.orientation / screen.orientation
 * angle, normalised to 0/90/180/270): 90 = phone turned counter-clockwise
 * (camera on the left). The OS draws its viewport rotated clockwise by that
 * angle relative to the device, so rotating our content clockwise by
 * (locked − current) puts it back where it was.
 *
 * Best on iPhone: Portrait Orientation Lock ON in Control Center. The OS then
 * never rotates at all (no re-layout flicker on bumps) and the driver picks the
 * landscape side once, with the buttons on the rotate hint.
 */

const KEY = 'wrb_lock_angle'
type Angle = 0 | 90 | 180 | 270

const norm = (a: number) => ((((Math.round(a / 90) * 90) % 360) + 360) % 360) as Angle
const isLandscape = (a: number) => a === 90 || a === 270

function osAngle(): Angle {
  const legacy = (window as unknown as { orientation?: unknown }).orientation
  if (typeof legacy === 'number') return norm(legacy)
  return norm(screen.orientation?.angle ?? 0)
}

function stored(): Angle | null {
  try {
    const v = norm(Number(localStorage.getItem(KEY)))
    return localStorage.getItem(KEY) !== null && isLandscape(v) ? v : null
  } catch { return null }
}

export interface Lock {
  /** Locked landscape angle, or null (not yet known: phone held in portrait). */
  locked: Angle | null
  /** Clockwise rotation applied to the content. */
  rotation: Angle
  /** Content box size, in CSS px (landscape when locked). */
  width: number
  height: number
  /** Viewport is portrait and no landscape is locked yet. */
  needsLandscape: boolean
  /** Lock with the content turned this way from the current screen (OS portrait-locked phones). */
  lockTurned: (clockwise: 90 | 270) => void
  /** Turn the content upside down (phone mounted the other way round). */
  flip: () => void
}

export function useLandscapeLock(): Lock {
  const [os, setOs] = useState(() => ({ angle: osAngle(), w: window.innerWidth, h: window.innerHeight }))
  const [locked, setLocked] = useState<Angle | null>(() => {
    const a = osAngle()
    return isLandscape(a) ? a : stored()
  })

  useEffect(() => {
    const update = () => setOs({ angle: osAngle(), w: window.innerWidth, h: window.innerHeight })
    // Re-opening the app re-captures the landscape the phone is in now.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      const a = osAngle()
      if (isLandscape(a)) setLocked(a)
      update()
    }
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    screen.orientation?.addEventListener?.('change', update)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
      screen.orientation?.removeEventListener?.('change', update)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  // First landscape seen becomes the lock.
  useEffect(() => {
    if (locked === null && isLandscape(os.angle)) setLocked(os.angle)
  }, [locked, os.angle])

  useEffect(() => {
    if (locked === null) return
    try { localStorage.setItem(KEY, String(locked)) } catch { /* storage blocked */ }
  }, [locked])

  const lockTurned = useCallback((clockwise: 90 | 270) => {
    setLocked(norm(osAngle() + clockwise))
  }, [])
  const flip = useCallback(() => setLocked((l) => (l === null ? l : norm(l + 180))), [])

  const rotation = locked === null ? 0 : norm(locked - os.angle)
  const sideways = rotation === 90 || rotation === 270
  return {
    locked,
    rotation,
    width: sideways ? os.h : os.w,
    height: sideways ? os.w : os.h,
    needsLandscape: locked === null && os.h > os.w,
    lockTurned,
    flip,
  }
}

const SIDES = ['top', 'right', 'bottom', 'left'] as const

/**
 * The rotated stage. `position: fixed` descendants (alert overlays) are
 * positioned against it, so they turn with the dashboard. Safe-area insets are
 * re-mapped to the sides they land on after rotation, exposed as --sa-*.
 */
export function LandscapeBox({ lock, children }: { lock: Lock; children: ReactNode }) {
  const k = lock.rotation / 90
  const vars: Record<string, string> = {}
  SIDES.forEach((side, i) => {
    // Content side i ends up on OS side (i + k) after a clockwise turn of k×90°.
    vars[`--sa-${side}`] = `env(safe-area-inset-${SIDES[(i + k) % 4]})`
  })
  const style: CSSProperties = lock.rotation === 0
    ? { position: 'fixed', inset: 0, ...vars }
    : {
        position: 'fixed',
        left: '50%',
        top: '50%',
        width: lock.width,
        height: lock.height,
        transform: `translate(-50%, -50%) rotate(${lock.rotation === 270 ? -90 : lock.rotation}deg)`,
        ...vars,
      }
  return <div style={style} data-rotation={lock.rotation}>{children}</div>
}

/**
 * Shown while the phone is in portrait and no landscape is locked yet. Phones
 * with the OS rotation lock on never report landscape, so the driver can pick
 * the side here instead.
 */
export function RotateHint({ lock }: { lock: Lock }) {
  const t = useT()
  if (!lock.needsLandscape) return null
  return (
    <div className="fixed inset-0 z-40 grid place-items-center overflow-y-auto bg-pit-950 p-6 text-center"
      onClick={(e) => e.stopPropagation()}>
      <div className="max-w-sm">
        <div className="mx-auto mb-4 h-10 w-16 rotate-90 rounded-md border-2 border-ink-500" />
        <p className="text-lg font-semibold text-ink-100">{t('Rotate your phone to landscape')}</p>
        <p className="mt-4 text-sm text-ink-300">
          {t('Screen not turning (rotation lock on)? Hold the phone sideways and pick where the camera is:')}
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button type="button" className="btn btn-quiet" onClick={() => lock.lockTurned(90)}>
            {t('Camera on the left')}
          </button>
          <button type="button" className="btn btn-quiet" onClick={() => lock.lockTurned(270)}>
            {t('Camera on the right')}
          </button>
        </div>
        <p className="mt-4 text-xs text-ink-500">
          {t('Tip for iPhone: turn on Portrait Orientation Lock in Control Center. WR Timing still shows in landscape and never flips on bumps.')}
        </p>
      </div>
    </div>
  )
}
