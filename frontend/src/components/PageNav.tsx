import { useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { rememberSlot } from '../lib/nav'
import { useT } from '../lib/i18n'

/** Menu linking the staff-facing pages for one event slot. Rendered only on
 * Race Control / Staff / Export (never the public dashboards). */
const LINKS = [
  { label: 'Control', path: 'control' },
  { label: 'Staff', path: 'staff' },
  { label: 'Export', path: 'export' },
] as const

export function PageNav({ slot }: { slot: string }) {
  const t = useT()
  const { pathname } = useLocation()
  // On a real slot page (/e/N/…), remember the slot so the slot-less admin pages
  // (Snapshots) can link back to it instead of defaulting to slot 1.
  useEffect(() => {
    if (/^\/e\/\d+\//.test(pathname)) rememberSlot(slot)
  }, [pathname, slot])
  const chip = (to: string, label: string, active: boolean) => (
    <Link
      key={to}
      to={to}
      aria-current={active ? 'page' : undefined}
      className={`inline-flex min-h-10 shrink-0 items-center rounded-lg px-3.5 text-xs font-bold uppercase tracking-wider transition-colors ${
        active ? 'bg-race-red text-white' : 'bg-pit-800 text-ink-300 hover:bg-pit-700'
      }`}
    >
      {label}
    </Link>
  )
  return (
    <nav className="flex gap-1.5">
      {LINKS.map((l) => chip(`/e/${slot}/${l.path}`, t(l.label), pathname === `/e/${slot}/${l.path}`))}
      {chip('/admin/snapshots', t('Snapshots'), pathname.startsWith('/admin/snapshots'))}
    </nav>
  )
}
