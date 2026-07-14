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
  return (
    <nav className="flex flex-wrap gap-1">
      {LINKS.map((l) => {
        const to = `/e/${slot}/${l.path}`
        const active = pathname === to
        return (
          <Link
            key={l.path}
            to={to}
            className={`rounded px-2.5 py-1 text-xs font-semibold uppercase tracking-wider ${
              active ? 'bg-race-red text-white' : 'bg-pit-800 text-ink-300 hover:bg-pit-700'
            }`}
          >
            {l.label}
          </Link>
        )
      })}
    </nav>
  )
}
