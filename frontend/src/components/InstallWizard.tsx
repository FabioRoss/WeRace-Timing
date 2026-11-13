import { useState } from 'react'
import type { ReactNode } from 'react'
import { APP_NAME, inAppBrowser, platform, useInstallPrompt } from '../lib/pwa'
import { useT } from '../lib/i18n'

/**
 * Full-screen guide that walks a driver through installing WR Timing on their
 * phone. Android/Chrome gets the native install button; iOS (and Android
 * browsers without one) get illustrated step-by-step instructions.
 */
export function InstallWizard({ onSkip }: { onSkip: () => void }) {
  const t = useT()
  const os = platform()
  const embedded = inAppBrowser()
  const { canPrompt, installed, prompt } = useInstallPrompt()
  const [copied, setCopied] = useState(false)

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopied(true)
    } catch { /* clipboard blocked */ }
  }

  let steps: ReactNode
  if (installed) {
    steps = (
      <Steps>
        <Step n={1} icon={<HomeIcon />}>{t('Installed! Open {app} from your home screen.', { app: APP_NAME })}</Step>
        <Step n={2} icon={<CloseIcon />}>{t('You can close this browser tab.')}</Step>
      </Steps>
    )
  } else if (embedded) {
    steps = (
      <>
        <Steps>
          <Step n={1} icon={<DotsIcon />}>{t('This page opened inside another app. Tap its menu (⋯ or ⋮).')}</Step>
          <Step n={2} icon={<GlobeIcon />}>
            {os === 'ios' ? t('Choose “Open in Safari”.') : t('Choose “Open in Chrome” (or “Open in browser”).')}
          </Step>
          <Step n={3} icon={<HomeIcon />}>{t('Then follow the install steps shown there.')}</Step>
        </Steps>
        <button type="button" className="btn btn-quiet mt-4" onClick={copyLink}>
          {copied ? t('Link copied') : t('Copy link')}
        </button>
      </>
    )
  } else if (os === 'ios') {
    steps = (
      <Steps>
        <Step n={1} icon={<ShareIcon />}>{t('Tap the Share button in the browser bar.')}</Step>
        <Step n={2} icon={<AddIcon />}>{t('Scroll down and tap “Add to Home Screen”.')}</Step>
        <Step n={3} icon={<CheckIcon />}>{t('Keep “Open as Web App” on, then tap Add.')}</Step>
        <Step n={4} icon={<HomeIcon />}>{t('Open {app} from your home screen.', { app: APP_NAME })}</Step>
      </Steps>
    )
  } else if (canPrompt) {
    steps = (
      <>
        <button type="button" className="btn btn-primary w-full py-3 text-base" onClick={() => void prompt()}>
          <DownloadIcon /> {t('Install {app}', { app: APP_NAME })}
        </button>
        <Steps>
          <Step n={1} icon={<DownloadIcon />}>{t('Tap Install, then confirm.')}</Step>
          <Step n={2} icon={<HomeIcon />}>{t('Open {app} from your home screen.', { app: APP_NAME })}</Step>
        </Steps>
      </>
    )
  } else {
    steps = (
      <Steps>
        <Step n={1} icon={<DotsIcon />}>{t('Tap the browser menu ⋮ (top right).')}</Step>
        <Step n={2} icon={<AddIcon />}>{t('Tap “Install app” or “Add to Home screen”.')}</Step>
        <Step n={3} icon={<CheckIcon />}>{t('Confirm with Install.')}</Step>
        <Step n={4} icon={<HomeIcon />}>{t('Open {app} from your home screen.', { app: APP_NAME })}</Step>
      </Steps>
    )
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="install-title"
      className="fixed inset-0 z-[60] overflow-y-auto bg-pit-950 text-ink-100"
      style={{ padding: 'env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)' }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mx-auto grid min-h-full max-w-4xl grid-cols-1 content-center gap-x-10 gap-y-5 px-5 py-6 landscape:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div className="min-w-0">
          <img src="/icons/wr-192.png" alt="" className="h-16 w-16 rounded-2xl shadow-lg ring-1 ring-white/10" />
          <h1 id="install-title" className="mt-4 text-2xl font-extrabold leading-tight">
            {t('Install {app}', { app: APP_NAME })}
          </h1>
          <p className="mt-2 text-sm text-ink-300">
            {t('Your live timing as an app: full screen, landscape, screen kept awake, one tap from your home screen.')}
          </p>
          <p className="mt-3 text-sm text-ink-500">
            {t('Install it once. At the next race, open the app and scan the new QR code.')}
          </p>
        </div>
        <div className="min-w-0">
          {steps}
          <button type="button" className="btn btn-quiet mt-4 w-full font-semibold normal-case tracking-normal text-ink-300" onClick={onSkip}>
            {installed ? t('Close') : t('Not now — continue in the browser')}
          </button>
        </div>
      </div>
    </div>
  )
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="mt-3 space-y-2">{children}</ol>
}

function Step({ n, icon, children }: { n: number; icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-center gap-3 rounded-xl bg-pit-900 px-3 py-2.5 ring-1 ring-pit-800">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-race-blue text-sm font-bold text-white">{n}</span>
      <span className="min-w-0 flex-1 text-[15px] leading-snug">{children}</span>
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-pit-800 text-ink-100">{icon}</span>
    </li>
  )
}

const svg = (path: ReactNode) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{path}</svg>
)
// iOS-style share: box with an arrow out of the top.
const ShareIcon = () => svg(<><path d="M12 3v12" /><path d="m8 7 4-4 4 4" /><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" /></>)
const AddIcon = () => svg(<><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M12 8v8M8 12h8" /></>)
const HomeIcon = () => <img src="/icons/wr-192.png" alt="" className="h-7 w-7 rounded-md" />
const CheckIcon = () => svg(<path d="m5 12 5 5 9-10" />)
const DotsIcon = () => svg(<><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></>)
const GlobeIcon = () => svg(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>)
const CloseIcon = () => svg(<path d="M6 6l12 12M18 6 6 18" />)
const DownloadIcon = () => svg(<><path d="M12 4v11" /><path d="m7 10 5 5 5-5" /><path d="M5 20h14" /></>)
