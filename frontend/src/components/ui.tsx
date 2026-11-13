import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

/**
 * Shared layout primitives. Two rules keep every page inside a phone's width:
 * grids always declare their columns (a column-less grid sizes its single track
 * to the widest child — a long <select> or a wide chart then widens the page),
 * and every panel is `min-w-0` so wide content scrolls inside it instead.
 */

/** Page body: centred, with gutters that clear the notch in landscape. */
export function Page({ children, width = 'max-w-7xl', className = '' }: {
  children: ReactNode
  width?: string
  className?: string
}) {
  return (
    <div
      className={`mx-auto flex min-h-full w-full ${width} flex-col ${className}`}
      style={{ paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' }}
    >
      {children}
    </div>
  )
}

/** A card with an optional label header and header actions. */
export function Panel({ title, actions, children, className = '', bodyClass = 'px-4 pb-4', id }: {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  bodyClass?: string
  id?: string
}) {
  return (
    <section id={id} className={`min-w-0 rounded-2xl bg-pit-900 ring-1 ring-pit-800 ${className}`}>
      {(title || actions) && (
        <header className="flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3">
          {title && <h2 className="label-race min-w-0">{title}</h2>}
          {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={`min-w-0 ${title || actions ? '' : 'pt-4'} ${bodyClass}`}>{children}</div>
    </section>
  )
}

/**
 * Animated show/hide that never jolts the layout: height eases between 0 and
 * the content's natural height (CSS grid 0fr <-> 1fr), with a fade. Closed
 * content is `inert`, so it can't be focused or read out while hidden.
 */
export function Collapse({ open, children, className = '' }: {
  open: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={`grid min-w-0 transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none ${
        open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
      } ${className}`}
      aria-hidden={!open}
      inert={!open}
    >
      <div className="min-h-0 min-w-0 overflow-hidden">{children}</div>
    </div>
  )
}

export interface SegOption<T extends string> { value: T; label: ReactNode }

/** Pill segmented control (one choice of a few). */
export function Segmented<T extends string>({ value, options, onChange, label, size = 'md' }: {
  value: T
  options: SegOption<T>[]
  onChange: (v: T) => void
  label?: string
  size?: 'sm' | 'md'
}) {
  return (
    <div className="inline-flex max-w-full items-center gap-2">
      {label && <span className="label-race hidden shrink-0 sm:inline">{label}</span>}
      <div role="radiogroup" aria-label={label}
        className="no-scrollbar inline-flex min-w-0 overflow-x-auto rounded-full bg-pit-850 p-0.5 ring-1 ring-pit-700">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            onClick={() => onChange(o.value)}
            className={`whitespace-nowrap rounded-full font-bold uppercase transition-colors ${
              size === 'sm' ? 'px-2.5 py-1 text-[0.7rem] tracking-wide' : 'px-3.5 py-1.5 text-xs tracking-wider'
            } ${value === o.value ? 'bg-race-blue text-white shadow' : 'text-ink-300 hover:text-ink-100'}`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export interface TabDef<T extends string> { id: T; label: ReactNode; badge?: ReactNode }

/** Horizontally scrollable tab bar (phones). Sticky when `sticky` is set. */
export function Tabs<T extends string>({ tabs, value, onChange, sticky = false }: {
  tabs: TabDef<T>[]
  value: T
  onChange: (v: T) => void
  sticky?: boolean
}) {
  return (
    <nav
      role="tablist"
      className={`no-scrollbar flex min-w-0 overflow-x-auto border-b border-pit-800 bg-pit-950/90 px-1 backdrop-blur ${
        sticky ? 'sticky top-[var(--strip-h,0px)] z-20' : ''
      }`}
    >
      {tabs.map((t) => {
        const on = value === t.id
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={(e) => {
              onChange(t.id)
              // On the narrowest phones the bar can scroll: keep the chosen tab in view.
              e.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' })
            }}
            className={`relative inline-flex flex-1 shrink-0 items-center justify-center gap-1 whitespace-nowrap px-2 py-3 text-[13px] font-semibold transition-colors ${
              on ? 'text-ink-100' : 'text-ink-500 hover:text-ink-300'
            }`}
          >
            {t.label}
            {t.badge}
            <span className={`absolute inset-x-2 bottom-0 h-0.5 rounded-full transition-colors ${on ? 'bg-race-red' : 'bg-transparent'}`} />
          </button>
        )
      })}
    </nav>
  )
}

/** Small numeric count bubble for tab labels. */
export function CountBadge({ n, tone = 'bg-pit-600 text-ink-100' }: { n: number; tone?: string }) {
  if (!n) return null
  return <span className={`rounded-full px-1.5 py-px text-[0.65rem] font-bold leading-4 ${tone}`}>{n}</span>
}

/** Label + big value. */
export function StatTile({ label, value, tone = '', sub, big = false }: {
  label: ReactNode
  value: ReactNode
  tone?: string
  sub?: ReactNode
  big?: boolean
}) {
  return (
    <div className="min-w-0 rounded-xl bg-pit-850 px-3 py-2.5">
      <div className="label-race truncate">{label}</div>
      <div className={`timing truncate font-bold leading-tight ${big ? 'text-3xl' : 'text-xl'} ${tone}`}>{value}</div>
      {sub && <div className="truncate text-xs text-ink-500">{sub}</div>}
    </div>
  )
}

/** `true` while the media query matches (e.g. '(min-width: 1024px)'). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = () => setMatches(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return matches
}

/** Desktop layout breakpoint shared by the dashboards (Tailwind `lg`). */
export const useIsDesktop = () => useMediaQuery('(min-width: 1024px)')
