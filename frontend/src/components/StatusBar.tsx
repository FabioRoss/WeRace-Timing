import type { ReactNode } from 'react'
import type { WsStatus } from '../lib/ws'
import type { Flag } from '../lib/types'
import { LangSwitch, useT } from '../lib/i18n'
import { flagAccent } from './FlagBanner'

export function ConnectionDot({ status, compact = false }: { status: WsStatus; compact?: boolean }) {
  const t = useT()
  const color =
    status === 'open' ? 'bg-race-green' : status === 'connecting' ? 'bg-race-yellow' : 'bg-race-red'
  const label =
    status === 'open' ? t('live') : status === 'connecting' ? t('connecting') : t('offline')
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-500" title={label}>
      <span className="relative flex h-2 w-2">
        {status === 'open' && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-race-green opacity-50 motion-reduce:hidden" />
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${color}`} />
      </span>
      {!compact && label}
    </span>
  )
}

/**
 * Page title bar. The title keeps a usable width: when the right-hand controls
 * don't fit beside it (phones), they wrap onto their own line instead of
 * squeezing the title down to "RACE …".
 */
export function PageHeader({ title, subtitle, left, right, nav }: {
  title: string
  subtitle?: string
  left?: ReactNode
  right?: ReactNode
  nav?: ReactNode
}) {
  return (
    <header className="border-b border-pit-800 px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-[13rem] items-center gap-3">
          {left}
          <div className="min-w-0">
            <h1 className="truncate text-base font-extrabold uppercase leading-tight tracking-wider sm:text-lg">
              {title}
            </h1>
            {subtitle && <p className="truncate text-xs text-ink-500">{subtitle}</p>}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2.5">
          {right}
          <LangSwitch />
        </div>
      </div>
      {nav && <div className="no-scrollbar -mx-3 mt-3 overflow-x-auto px-3 sm:-mx-4 sm:px-4">{nav}</div>}
    </header>
  )
}

const FLAG_WORD: Record<Flag, string> = {
  none: 'STANDBY', green: 'GREEN FLAG', yellow: 'YELLOW FLAG', red: 'RED FLAG',
  finish: 'CHEQUERED FLAG', warmup: 'WARM UP', stopped: 'SESSION STOPPED',
}

/**
 * Sticky live-session strip: flag, time remaining and session best stay in view
 * while the standings scroll. The flag colour runs along the top edge.
 */
export function RaceStrip({ flag, remaining, best, bestKart, status, extra }: {
  flag: Flag
  remaining: string
  best?: string
  bestKart?: string | null
  status: WsStatus
  extra?: ReactNode
}) {
  const t = useT()
  const accent = flag === 'finish' ? '#e8eaf2' : flagAccent(flag)
  const flashing = flag === 'yellow' || flag === 'red'
  return (
    <div
      className="sticky top-0 z-30 border-b border-pit-800 bg-pit-950/90 backdrop-blur-md"
      style={{ boxShadow: `inset 0 3px 0 ${accent}` }}
    >
      <div className="flex h-14 items-center gap-3 px-3 sm:gap-5 sm:px-4">
        <span
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[0.7rem] font-extrabold uppercase tracking-wider ${
            flag === 'finish' ? 'checker text-transparent' : ''
          } ${flashing ? 'msg-flash' : ''}`}
          style={flag === 'finish' ? { minWidth: '3.5rem' } : {
            background: flag === 'none' ? 'var(--color-pit-700)' : accent,
            color: flag === 'none' || flag === 'red' || flag === 'stopped' || flag === 'warmup' ? '#fff' : '#07080c',
          }}
          title={t(FLAG_WORD[flag] ?? 'STANDBY')}
        >
          {flag === 'finish' ? ' ' : t(FLAG_WORD[flag] ?? 'STANDBY')}
        </span>
        <div className="min-w-0">
          <div className="label-race leading-none">{t('Remaining')}</div>
          <div className="timing text-xl font-extrabold leading-tight">{remaining}</div>
        </div>
        {best && (
          <div className="min-w-0">
            <div className="label-race leading-none">{t('Best')}</div>
            <div className="timing truncate text-base font-bold leading-tight text-race-purple">
              {best}{bestKart && <span className="ml-1 text-xs text-ink-500">#{bestKart}</span>}
            </div>
          </div>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-3">
          {extra}
          <ConnectionDot status={status} compact />
        </div>
      </div>
    </div>
  )
}
