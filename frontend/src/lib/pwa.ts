import { useEffect, useState } from 'react'

/**
 * The installable driver app ("WR Timing"). One app identity covers every race:
 * the installed app opens /drive, which forwards to the last driver link used
 * on this phone (or offers to scan the next race's QR code). See backend
 * app/pwa.py for the manifest.
 */

export const APP_NAME = 'WR Timing'
const LINK_KEY = 'wrb_driver_link'
const SKIP_KEY = 'wrb_install_skip'
/** "Not now" on the install wizard is remembered for this long. */
const SKIP_MS = 12 * 3600 * 1000

export const DRIVER_PATH = /^\/e\/\d{1,3}\/driver\/[0-9a-f]{16}$/

/** Running as the installed app (home screen), not in a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(display-mode: standalone)').matches
    || window.matchMedia('(display-mode: fullscreen)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true
}

export type Platform = 'ios' | 'android' | 'other'

export function platform(): Platform {
  const ua = navigator.userAgent
  // iPadOS reports itself as a Mac; touch points give it away.
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios'
  if (/Android/.test(ua)) return 'android'
  return 'other'
}

/** Embedded browsers (QR apps, WhatsApp, Instagram…) can't install web apps. */
export function inAppBrowser(): boolean {
  return /FBAN|FBAV|Instagram|WhatsApp|Line\/|Telegram|Snapchat|TikTok|; wv\)/.test(navigator.userAgent)
}

/** On iOS only Safari could install before 16.4; other browsers now can too via Share. */
export function iosNonSafari(): boolean {
  return /CriOS|FxiOS|EdgiOS|OPiOS/.test(navigator.userAgent)
}

// --- Last driver link -------------------------------------------------------

export function rememberDriverLink(path: string) {
  if (!DRIVER_PATH.test(path)) return
  try { localStorage.setItem(LINK_KEY, path) } catch { /* storage blocked */ }
}

export function lastDriverLink(): string | null {
  try {
    const v = localStorage.getItem(LINK_KEY)
    return v && DRIVER_PATH.test(v) ? v : null
  } catch { return null }
}

/** Driver path from a scanned QR text (full URL on any host, or a bare path). */
export function driverPathFromText(text: string): string | null {
  try {
    const url = new URL(text.trim(), window.location.origin)
    return DRIVER_PATH.test(url.pathname) ? url.pathname : null
  } catch { return null }
}

// --- Install wizard dismissal -----------------------------------------------

export function installSkipped(): boolean {
  try { return Date.now() - Number(localStorage.getItem(SKIP_KEY) || 0) < SKIP_MS } catch { return false }
}

export function skipInstall() {
  try { localStorage.setItem(SKIP_KEY, String(Date.now())) } catch { /* storage blocked */ }
}

// --- Install prompt (Chrome / Edge / Samsung on Android) ---------------------

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: BeforeInstallPromptEvent | null = null
let installed = false
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((fn) => fn())

if (typeof window !== 'undefined') {
  // The event can fire before any component mounts, so catch it at load.
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferred = e as BeforeInstallPromptEvent
    notify()
  })
  window.addEventListener('appinstalled', () => {
    installed = true
    deferred = null
    notify()
  })
}

/** Native install prompt, when the browser offers one. */
export function useInstallPrompt() {
  const [, force] = useState(0)
  useEffect(() => {
    const fn = () => force((n) => n + 1)
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }, [])
  return {
    canPrompt: deferred !== null,
    installed,
    prompt: async () => {
      const ev = deferred
      if (!ev) return false
      deferred = null
      await ev.prompt()
      const { outcome } = await ev.userChoice
      if (outcome === 'accepted') installed = true
      notify()
      return outcome === 'accepted'
    },
  }
}

// --- Page setup ---------------------------------------------------------------

function ensureTag(selector: string, make: () => HTMLElement) {
  if (!document.head.querySelector(selector)) document.head.appendChild(make())
}

/**
 * Install tags for this page. The server already injects them on a fresh load
 * of a driver link; this covers in-app navigation and the dev server.
 */
export function usePwaHead(driverPath?: string) {
  useEffect(() => {
    const href = '/api/pwa/manifest.webmanifest'
      + (driverPath && DRIVER_PATH.test(driverPath) ? `?to=${encodeURIComponent(driverPath)}` : '')
    let link = document.head.querySelector<HTMLLinkElement>('link[rel="manifest"]')
    if (!link) {
      link = document.createElement('link')
      link.rel = 'manifest'
      document.head.appendChild(link)
    }
    if (link.getAttribute('href') !== href) link.setAttribute('href', href)
    const meta = (name: string, content: string) => ensureTag(`meta[name="${name}"]`, () => {
      const m = document.createElement('meta')
      m.name = name
      m.content = content
      return m
    })
    meta('mobile-web-app-capable', 'yes')
    meta('apple-mobile-web-app-capable', 'yes')
    meta('apple-mobile-web-app-title', APP_NAME)
    meta('apple-mobile-web-app-status-bar-style', 'black-translucent')
    const prevTitle = document.title
    document.title = APP_NAME
    return () => { document.title = prevTitle }
  }, [driverPath])

  useEffect(() => {
    if ('serviceWorker' in navigator && window.isSecureContext) {
      navigator.serviceWorker.register('/sw.js').catch(() => { /* optional */ })
    }
  }, [])
}

/** Full screen + landscape lock where the browser allows it (Android). */
export function goFullscreenLandscape() {
  const el = document.documentElement
  const lock = () => {
    const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }
    // Lock the landscape the phone is in now, not "any landscape": the sensor
    // would otherwise flip between the two on bumps.
    const now = o?.type?.startsWith('landscape') ? o.type : 'landscape'
    o?.lock?.(now).catch(() => { /* not allowed here */ })
  }
  if (!document.fullscreenElement && el.requestFullscreen) {
    el.requestFullscreen().then(lock, () => {})
  } else {
    lock()
  }
}
