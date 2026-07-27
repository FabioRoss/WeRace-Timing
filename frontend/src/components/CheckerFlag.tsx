/**
 * A small chequered-flag mark for the left of results/snapshot headers — the
 * finished-session motif, replacing the old full-width chequered strip.
 */
export function CheckerFlag({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`checker inline-block h-7 w-7 shrink-0 rounded-sm ring-1 ring-pit-700 ${className}`}
    />
  )
}
