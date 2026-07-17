import { useMemo } from 'react'
import type { Penalty } from '../lib/types'
import { penaltyBadgeClass, penaltyKindLabel, penaltyLabel } from '../lib/penalties'
import { useT } from '../lib/i18n'

/**
 * Shared penalties & warnings log. Rendered on every dashboard
 * (control / team / driver / general). `filterKart` narrows to one kart;
 * `compact` tightens the rows for the driver phone view. Race Control passes
 * `onServe` / `onRemove` to turn each row into an actionable entry.
 */
export function PenaltyLog({ penalties, filterKart, compact, empty, onServe, onRemove }: {
  penalties: Penalty[]
  filterKart?: string
  compact?: boolean
  empty?: string
  onServe?: (id: number, served: boolean) => void
  onRemove?: (id: number) => void
}) {
  const t = useT()
  const rows = useMemo(() => {
    const list = filterKart ? penalties.filter((p) => p.kart_no === filterKart) : penalties
    // Newest first.
    return [...list].sort((a, b) => b.id - a.id)
  }, [penalties, filterKart])

  if (rows.length === 0) {
    return <p className="text-sm text-ink-500">{empty ?? t('No penalties or warnings.')}</p>
  }

  return (
    <ul className={`space-y-2 overflow-y-auto ${compact ? 'max-h-40 text-xs' : 'max-h-56 text-sm'}`}>
      {rows.map((p) => (
        <li key={p.id} className="flex items-center gap-2 rounded bg-pit-850 px-3 py-2">
          {!filterKart && (
            <span className="min-w-[2.5rem] font-timing font-bold">#{p.kart_no}</span>
          )}
          <span className={`rounded px-1.5 py-0.5 text-[0.65rem] font-bold ${penaltyBadgeClass(p)}`}>
            {t(penaltyLabel(p))}
          </span>
          <span className="flex-1 truncate">
            <span className="text-ink-300">{t(penaltyKindLabel(p))}</span>
            {p.reason && <span className="text-ink-100"> — {p.reason}</span>}
          </span>
          {p.kind === 'time' && !onServe && (
            <span className={`text-[0.65rem] font-semibold uppercase ${
              p.served ? 'text-race-green' : 'text-race-yellow'
            }`}>
              {p.served ? t('served') : t('to serve')}
            </span>
          )}
          {p.kind === 'lap' && !onRemove && (
            <span className="text-[0.65rem] font-semibold uppercase text-ink-500">{t('after race')}</span>
          )}
          {onServe && p.kind === 'time' && (
            <button
              type="button"
              onClick={() => onServe(p.id, !p.served)}
              className={`rounded px-2 py-0.5 text-[0.65rem] font-bold uppercase ${
                p.served ? 'bg-pit-700 text-ink-300' : 'bg-race-green text-pit-950'
              }`}
            >
              {p.served ? t('unserve') : t('serve')}
            </button>
          )}
          {onRemove && (
            <button
              type="button"
              onClick={() => onRemove(p.id)}
              className="rounded bg-pit-700 px-2 py-0.5 text-[0.65rem] font-bold uppercase text-ink-300 hover:bg-race-red hover:text-white"
            >
              ✕
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}
