import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { QrScanner } from '../components/QrScanner'
import { APP_NAME, DRIVER_PATH, lastDriverLink, usePwaHead } from '../lib/pwa'
import { useT } from '../lib/i18n'

/**
 * Where the installed WR Timing app opens. Goes straight to the last driver
 * link used on this phone (or the one the app was installed from); with none
 * yet, asks to scan the driver QR code.
 */
export function DriveLauncher() {
  const t = useT()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  usePwaHead()
  const fromInstall = params.get('to') ?? ''
  const target = lastDriverLink() ?? (DRIVER_PATH.test(fromInstall) ? fromInstall : null)
  const [scanning, setScanning] = useState(false)

  useEffect(() => {
    if (target) navigate(target, { replace: true })
  }, [target, navigate])

  const onScan = useCallback((path: string) => {
    window.location.assign(path)
  }, [])

  if (target) return null
  return (
    <div className="grid h-dvh place-items-center bg-pit-950 px-6 text-center"
      style={{ padding: 'env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)' }}>
      <div className="max-w-sm">
        <img src="/icons/wr-192.png" alt="" className="mx-auto h-20 w-20 rounded-2xl ring-1 ring-white/10" />
        <h1 className="mt-4 text-2xl font-extrabold">{APP_NAME}</h1>
        <p className="mt-2 text-ink-300">{t('Scan the driver QR code for your kart to start.')}</p>
        <button type="button" className="btn btn-primary mt-6 px-6 py-3 text-base" onClick={() => setScanning(true)}>
          {t('Scan QR code')}
        </button>
      </div>
      {scanning && <QrScanner onResult={onScan} onClose={() => setScanning(false)} />}
    </div>
  )
}
