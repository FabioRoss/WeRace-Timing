import { useEffect, useRef, useState } from 'react'
import { driverPathFromText } from '../lib/pwa'
import { useT } from '../lib/i18n'

interface Detector { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> }
type DetectorCtor = new (opts: { formats: string[] }) => Detector

/**
 * Full-screen camera scanner for a driver QR code. Inside the installed app,
 * this is how a driver switches to the next race: the phone camera app would
 * open the link in the browser instead (always on iOS).
 * Uses the browser's BarcodeDetector when present, else jsQR (loaded lazily).
 */
export function QrScanner({ onResult, onClose }: {
  onResult: (driverPath: string) => void
  onClose: () => void
}) {
  const t = useT()
  const video = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [wrong, setWrong] = useState(false)

  useEffect(() => {
    let stream: MediaStream | null = null
    let stopped = false
    let timer = 0
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError(t('This browser can’t use the camera.'))
        return
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' }, audio: false,
        })
      } catch {
        setError(t('Camera access was refused. Allow the camera for this app in your phone settings.'))
        return
      }
      if (stopped) { stream.getTracks().forEach((tr) => tr.stop()); return }
      const v = video.current
      if (!v) return
      v.srcObject = stream
      await v.play().catch(() => {})

      const Native = (window as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector
      let detector: Detector | null = null
      if (Native) {
        try { detector = new Native({ formats: ['qr_code'] }) } catch { detector = null }
      }
      const jsQR = detector ? null : (await import('jsqr')).default

      const tick = async () => {
        if (stopped) return
        let text: string | null = null
        if (v.readyState >= 2 && v.videoWidth) {
          try {
            if (detector) {
              text = (await detector.detect(v))[0]?.rawValue ?? null
            } else if (jsQR && ctx) {
              // Downscale: jsQR is plenty accurate at ~640px and much faster.
              const scale = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight))
              canvas.width = Math.round(v.videoWidth * scale)
              canvas.height = Math.round(v.videoHeight * scale)
              ctx.drawImage(v, 0, 0, canvas.width, canvas.height)
              const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
              text = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data ?? null
            }
          } catch { /* keep scanning */ }
        }
        if (text) {
          const path = driverPathFromText(text)
          if (path) { onResult(path); return }
          setWrong(true)
        }
        timer = window.setTimeout(tick, 200)
      }
      void tick()
    }
    void start()
    return () => {
      stopped = true
      clearTimeout(timer)
      stream?.getTracks().forEach((tr) => tr.stop())
    }
  }, [onResult, t])

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-black text-ink-100"
      style={{ padding: 'env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)' }}
      onClick={(e) => e.stopPropagation()}>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <video ref={video} playsInline muted className="h-full w-full object-cover" />
        {/* Aim frame */}
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="aspect-square h-[60%] max-h-72 rounded-2xl border-4 border-white/80 shadow-[0_0_0_100vmax_rgba(0,0,0,0.45)]" />
        </div>
        {error && (
          <div className="absolute inset-0 grid place-items-center bg-pit-950/95 p-6 text-center">
            <p className="max-w-sm text-ink-300">{error}</p>
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 bg-pit-950 px-4 py-3">
        <p className={`min-w-0 text-sm ${wrong ? 'text-race-yellow' : 'text-ink-300'}`}>
          {wrong ? t('That isn’t a driver QR code — scan the one for your kart.') : t('Point the camera at your driver QR code.')}
        </p>
        <button type="button" className="btn btn-quiet shrink-0" onClick={onClose}>{t('Cancel')}</button>
      </div>
    </div>
  )
}
