import { Link, useLocation } from 'react-router-dom'

/** Menu linking the staff-facing pages for one event slot. Rendered only on
 * Race Control / Staff / Export (never the public dashboards). */
const LINKS = [
  { label: 'Control', path: 'control' },
  { label: 'Staff', path: 'staff' },
  { label: 'Export', path: 'export' },
] as const

export function PageNav({ slot }: { slot: string }) {
  const { pathname } = useLocation()
  const chip = (to: string, label: string, active: boolean) => (
    <Link
      key={to}
      to={to}
      className={`rounded px-2.5 py-1 text-xs font-semibold uppercase tracking-wider ${
        active ? 'bg-race-red text-white' : 'bg-pit-800 text-ink-300 hover:bg-pit-700'
      }`}
    >
      {label}
    </Link>
  )
  return (
    <nav className="flex flex-wrap gap-1">
      {LINKS.map((l) => chip(`/e/${slot}/${l.path}`, l.label, pathname === `/e/${slot}/${l.path}`))}
      {chip('/admin/snapshots', 'Snapshots', pathname.startsWith('/admin/snapshots'))}
    </nav>
  )
}
