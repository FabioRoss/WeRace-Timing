import type { WsStatus } from '../lib/ws'

export function ConnectionDot({ status }: { status: WsStatus }) {
  const color =
    status === 'open' ? 'bg-race-green' : status === 'connecting' ? 'bg-race-yellow' : 'bg-race-red'
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-500">
      <span className={`h-2 w-2 rounded-full ${color}`} />
      {status === 'open' ? 'live' : status}
    </span>
  )
}

export function PageHeader({
  title,
  subtitle,
  right,
  nav,
}: {
  title: string
  subtitle?: string
  right?: React.ReactNode
  nav?: React.ReactNode
}) {
  return (
    <header className="border-b border-pit-700 px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="checker h-6 w-6 rounded-sm shrink-0" />
          <div className="min-w-0">
            <h1 className="text-base font-bold leading-tight uppercase tracking-wider truncate">
              {title}
            </h1>
            {subtitle && <p className="text-xs text-ink-500 truncate">{subtitle}</p>}
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">{right}</div>
      </div>
      {nav && <div className="mt-2">{nav}</div>}
    </header>
  )
}
