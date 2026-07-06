import type { Flag } from '../lib/types'

const FLAG_STYLES: Record<Flag, { label: string; cls: string }> = {
  none: { label: 'STANDBY', cls: 'bg-pit-700 text-ink-300' },
  green: { label: 'GREEN FLAG', cls: 'bg-race-green text-pit-950' },
  yellow: { label: 'YELLOW FLAG', cls: 'bg-race-yellow text-pit-950 msg-flash' },
  red: { label: 'RED FLAG', cls: 'bg-race-red text-white msg-flash' },
  finish: { label: 'CHEQUERED FLAG', cls: 'checker text-transparent' },
  warmup: { label: 'WARM UP', cls: 'bg-race-blue text-white' },
  stopped: { label: 'SESSION STOPPED', cls: 'bg-race-red text-white' },
}

export function FlagBanner({ flag, compact = false }: { flag: Flag; compact?: boolean }) {
  const style = FLAG_STYLES[flag] ?? FLAG_STYLES.none
  return (
    <div
      className={`rounded font-bold uppercase tracking-widest text-center ${style.cls} ${
        compact ? 'px-3 py-1 text-xs' : 'px-4 py-2 text-sm'
      }`}
    >
      {flag === 'finish' ? <span className="text-shadow-none select-none">▓</span> : style.label}
    </div>
  )
}

export function flagAccent(flag: Flag): string {
  switch (flag) {
    case 'green': return 'var(--color-race-green)'
    case 'yellow': return 'var(--color-race-yellow)'
    case 'red':
    case 'stopped': return 'var(--color-race-red)'
    case 'warmup': return 'var(--color-race-blue)'
    default: return 'var(--color-pit-600)'
  }
}
