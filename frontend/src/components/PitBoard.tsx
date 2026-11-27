import { useMemo, useState } from 'react'
import type { DriverRow, Snapshot } from '../lib/types'
import { fmtClock } from '../lib/format'
import { useT } from '../lib/i18n'
import { Segmented } from './ui'

/**
 * Race Control pit board (venues with automatic pit lane): every kart's pit
 * stops and stints against the race rules — minimum pit time, maximum stint,
 * minimum number of stops. Each rule break is its own "irregularity" that
 * race control can mark as managed (stored on the server, shared by every
 * race-control screen); managed ones stop counting and stop showing red.
 */

export type IrregularKind = 'pit' | 'stint' | 'stops'

export interface Irregularity {
  key: string                  // "<kart>:<kind>:<n>" — n = stop / stint index
  kind: IrregularKind
  n: number
  managed: boolean
  running?: boolean            // stint still going (already over the limit)
  value: string                // the offending time / count
}

export interface Rules { minPitS: number; maxStintS: number; minPits: number; finished: boolean }

export function rulesOf(snapshot: Snapshot): Rules {
  const race = snapshot.race
  return {
    minPitS: snapshot.min_pit_s ?? 0,
    maxStintS: snapshot.max_stint_s ?? 0,
    minPits: snapshot.min_pits ?? 0,
    finished: race.ended || race.flag === 'finish',
  }
}

/** Every rule break for one kart, in race order. */
export function irregularities(d: DriverRow, rules: Rules, managed: Set<string>): Irregularity[] {
  const out: Irregularity[] = []
  const add = (kind: IrregularKind, n: number, value: string, running = false) => {
    const key = `${d.kart_no}:${kind}:${n}`
    out.push({ key, kind, n, value, running, managed: managed.has(key) })
  }
  if (rules.minPitS > 0) {
    // 0 = a stop the feed counted whose time isn't known (yet): not judged.
    ;(d.pit_times_ms ?? []).forEach((ms, i) => { if (ms > 0 && ms < rules.minPitS * 1000) add('pit', i, fmtPit(ms)) })
  }
  if (rules.maxStintS > 0) {
    const stints = d.stints_s ?? []
    stints.forEach((sec, i) => { if (sec > rules.maxStintS) add('stint', i, fmtClock(sec)) })
    // The running stint keeps the index it will have once completed, so a
    // "managed" mark carries over when the kart finally pits.
    if (!d.in_pit && (d.stint_seconds ?? 0) > rules.maxStintS) add('stint', stints.length, fmtClock(d.stint_seconds ?? 0), true)
  }
  if (rules.minPits > 0 && d.pits < rules.minPits && (rules.finished || d.finished)) {
    // Missing stops only become a break once the kart can't make them any more.
    add('stops', 0, `${d.pits}/${rules.minPits}`)
  }
  return out
}

/** Open (not managed) rule breaks across the field — the section badge. */
export function countIssues(snapshot: Snapshot | null | undefined): number {
  if (!snapshot) return 0
  const rules = rulesOf(snapshot)
  if (!rules.minPitS && !rules.maxStintS && !rules.minPits) return 0
  const managed = new Set(snapshot.pit_managed ?? [])
  return snapshot.drivers.reduce((n, d) => n + irregularities(d, rules, managed).filter((i) => !i.managed).length, 0)
}

/** 58123 -> "58.1", 83400 -> "1:23.4" */
export function fmtPit(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return '–'
  const tenths = Math.floor(ms / 100)
  const s = Math.floor(tenths / 10)
  const frac = tenths % 10
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.${frac}` : `${s}.${frac}`
}

type View = 'all' | 'issues' | 'pit' | 'due'

export function PitBoard({ snapshot, serverNow, onManaged }: {
  snapshot: Snapshot
  serverNow: number
  onManaged: (key: string, managed: boolean) => void
}) {
  const t = useT()
  const rules = rulesOf(snapshot)
  const { minPitS: min, maxStintS: max, minPits } = rules
  const [view, setView] = useState<View>('all')
  const managedKey = (snapshot.pit_managed ?? []).join(',')

  const rows = useMemo(() => {
    const managed = new Set(managedKey ? managedKey.split(',') : [])
    return snapshot.drivers.map((d) => ({ d, irr: irregularities(d, rules, managed) }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.drivers, min, max, minPits, rules.finished, managedKey])
  const open = rows.reduce((n, r) => n + r.irr.filter((i) => !i.managed).length, 0)
  const inPit = rows.filter((r) => r.d.in_pit).length
  const due = rows.filter((r) => minPits > 0 && r.d.pits < minPits).length
  const shown = rows.filter((r) => view === 'all' || (view === 'due' ? minPits > 0 && r.d.pits < minPits : r.d.in_pit))

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-3">
        <Segmented<View>
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: 'all', label: t('All') },
            { value: 'pit', label: `${t('In pit')} ${inPit || ''}`.trim() },
            ...(minPits ? [{ value: 'due' as const, label: `${t('Pits due')} ${due || ''}`.trim() }] : []),
            { value: 'issues', label: `${t('Issues')} ${open || ''}`.trim() },
          ]}
        />
        <p className="text-xs text-ink-500">
          {t('Min pit')} <b className="timing text-ink-300">{min ? fmtClock(min) : t('off')}</b>
          {' · '}
          {t('Max stint')} <b className="timing text-ink-300">{max ? fmtClock(max) : t('off')}</b>
          {' · '}
          {t('Min pits')} <b className="timing text-ink-300">{minPits || t('off')}</b>
        </p>
      </div>

      {view === 'issues' ? (
        <IssueList rows={rows} rules={rules} onManaged={onManaged} />
      ) : shown.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-ink-500">
          {view === 'pit' ? t('No kart in the pit lane.')
            : view === 'due' ? t('Every kart has made its mandatory stops.') : t('No karts yet.')}
        </p>
      ) : (
        <div className="scroll-x">
          <table className="w-full min-w-0 text-sm">
            <thead>
              <tr className="label-race border-y border-pit-800 text-left">
                <th className="py-2 pl-4 pr-2 font-semibold">{t('Kart')}</th>
                <th className="whitespace-nowrap px-2 font-semibold" title={t('On track: time since leaving the pits. In the pit lane: time since entering it.')}>
                  <span className="sm:hidden">{t('Stint / pit')}</span>
                  <span className="hidden sm:inline">{t('Stint / pit now')}</span>
                </th>
                <th className="px-2 text-right font-semibold">{t('Pits')}</th>
                <th className="hidden px-2 text-right font-semibold sm:table-cell">{t('Last pit')}</th>
                <th className="hidden px-2 text-right font-semibold sm:table-cell">{t('Shortest pit')}</th>
                <th className="hidden pl-2 pr-4 text-right font-semibold sm:table-cell">{t('Longest stint')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(({ d, irr }) => (
                <PitRow key={d.kart_no} d={d} irr={irr} min={min} max={max} minPits={minPits} serverNow={serverNow} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="px-4 py-3 text-xs text-ink-500">
        {view === 'issues'
          ? t('Each rule break is listed on its own. Mark it managed once dealt with (penalty given, or no action needed); it stops counting and can be switched back.')
          : <>
              {t('Stint / pit now: on track, the running stint (time since leaving the pits); in the pit lane, the time since entering it, turning green once the minimum is served.')}
              {' '}
              {t('Stint = time on track between pit exit and the next pit entry. Pit times are measured by the pit-lane gates.')}
            </>}
      </p>
    </div>
  )
}

/** Rule breaks, one line each, grouped by kart; open ones first. */
function IssueList({ rows, rules, onManaged }: {
  rows: { d: DriverRow; irr: Irregularity[] }[]
  rules: Rules
  onManaged: (key: string, managed: boolean) => void
}) {
  const t = useT()
  const groups = rows
    .filter((r) => r.irr.length > 0)
    .map((r) => ({ ...r, open: r.irr.filter((i) => !i.managed).length }))
    .sort((a, b) => (b.open > 0 ? 1 : 0) - (a.open > 0 ? 1 : 0) || (a.d.position || 999) - (b.d.position || 999))
  if (groups.length === 0) {
    return <p className="px-4 pb-4 text-sm text-ink-500">{t('No rule breaks.')}</p>
  }
  const describe = (i: Irregularity): { title: string; detail: string } => {
    switch (i.kind) {
      case 'pit':
        return { title: t('Short pit stop'), detail: t('Stop {n}: {v} (min {min})', { n: i.n + 1, v: i.value, min: fmtClock(rules.minPitS) }) }
      case 'stint':
        return {
          title: i.running ? t('Stint over max (still on track)') : t('Stint over max'),
          detail: t('Stint {n}: {v} (max {max})', { n: i.n + 1, v: i.value, max: fmtClock(rules.maxStintS) }),
        }
      default:
        return { title: t('Missing pit stops'), detail: t('{v} mandatory stops made', { v: i.value }) }
    }
  }
  return (
    <div className="space-y-3 px-3 pb-1 sm:px-4">
      {groups.map(({ d, irr, open }) => (
        <div key={d.kart_no} className={`overflow-hidden rounded-xl ring-1 ${open ? 'ring-race-red/40' : 'ring-pit-700'}`}>
          <div className={`flex items-baseline gap-2 px-3 py-2 ${open ? 'bg-race-red/10' : 'bg-pit-850'}`}>
            <span className="timing font-extrabold">#{d.kart_no}</span>
            <span className="min-w-0 flex-1 truncate text-sm text-ink-300">{d.name}</span>
            <span className="timing text-xs text-ink-500">P{d.position || '–'}</span>
          </div>
          <ul className="divide-y divide-pit-800">
            {[...irr].sort((a, b) => Number(a.managed) - Number(b.managed)).map((i) => {
              const { title, detail } = describe(i)
              return (
                <li key={i.key} className={`flex items-center gap-3 px-3 py-2.5 ${i.managed ? 'opacity-60' : ''}`}>
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${i.managed ? 'bg-race-green' : 'bg-race-red'}`} />
                  <div className="min-w-0 flex-1">
                    <div className={`text-sm font-bold ${i.managed ? 'text-ink-300 line-through decoration-ink-500' : 'text-ink-100'}`}>{title}</div>
                    <div className="timing text-xs text-ink-300">{detail}</div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={i.managed}
                    onClick={() => onManaged(i.key, !i.managed)}
                    className={`inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-xs font-bold uppercase tracking-wider ring-1 transition-colors ${
                      i.managed ? 'bg-race-green/15 text-race-green ring-race-green/40' : 'bg-pit-800 text-ink-300 ring-pit-600 hover:bg-pit-700'
                    }`}
                  >
                    <span className={`grid h-4 w-4 place-items-center rounded border ${i.managed ? 'border-race-green bg-race-green text-pit-950' : 'border-ink-500'}`}>
                      {i.managed && (
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="4" aria-hidden="true"><path d="m5 12 5 5 9-10" /></svg>
                      )}
                    </span>
                    {t('Managed')}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}

function PitRow({ d, irr, min, max, minPits, serverNow }: {
  d: DriverRow
  irr: Irregularity[]
  min: number
  max: number
  minPits: number
  serverNow: number
}) {
  const t = useT()
  const stops = d.pit_times_ms ?? []
  const known = stops.filter((ms) => ms > 0)
  const stints = d.stints_s ?? []
  const last = stops.length ? stops[stops.length - 1] : d.last_pit_ms
  const shortest = known.length ? Math.min(...known) : null
  const longest = stints.length ? Math.max(...stints) : null
  // Red only for rule breaks still open (managed ones are dealt with).
  const openIrr = irr.filter((i) => !i.managed)
  const c = {
    shortPits: openIrr.filter((i) => i.kind === 'pit').map((i) => i.n),
    longStints: openIrr.filter((i) => i.kind === 'stint' && !i.running).map((i) => i.n),
    stintOver: openIrr.some((i) => i.kind === 'stint' && i.running),
    pitsMissed: openIrr.some((i) => i.kind === 'stops'),
    pitsDue: Math.max(0, minPits - d.pits),
  }
  const lastShort = stops.length > 0 && c.shortPits.includes(stops.length - 1)
  const issue = openIrr.length > 0

  // Live: time in the pit lane, or the running stint.
  // Live cell: either the running stint (on track) or the time in the pit lane.
  let now: React.ReactNode
  if (d.in_pit) {
    const inFor = d.pit_since_ts ? Math.max(0, serverNow - d.pit_since_ts) : null
    const served = !min || (inFor != null && inFor >= min)
    const toGo = min && inFor != null && !served ? Math.ceil(min - inFor) : 0
    now = (
      <div className={`inline-block rounded-md px-1.5 py-0.5 ${served ? 'bg-race-green/15 text-race-green' : 'bg-race-yellow/15 text-race-yellow'}`}>
        <div className="text-[0.65rem] font-extrabold uppercase tracking-wider">{t('In pit')}</div>
        <div className="timing font-extrabold leading-tight">{inFor != null ? fmtClock(Math.floor(inFor)) : '–'}</div>
        {toGo > 0 && <div className="text-[0.65rem] font-semibold">{t('{s}s to min', { s: toGo })}</div>}
      </div>
    )
  } else {
    const s = d.stint_seconds ?? 0
    const tone = c.stintOver ? 'text-race-red font-extrabold'
      : max && s >= max * 0.9 ? 'text-race-yellow font-bold' : 'text-ink-100'
    now = (
      <div className="px-1.5 py-0.5">
        <div className="text-[0.65rem] font-semibold uppercase tracking-wider text-ink-500">{t('Stint')}</div>
        <div className={`timing leading-tight ${tone}`}>{d.stint_seconds != null ? fmtClock(s) : '–'}</div>
        {c.stintOver && <div className="text-[0.65rem] font-semibold text-race-red">{t('over max')}</div>}
      </div>
    )
  }


  return (
    <tr className={`border-b border-pit-800/70 align-top ${d.in_pit ? 'bg-race-yellow/5' : ''} ${issue ? 'shadow-[inset_3px_0_0_var(--color-race-red)]' : ''}`}>
      <td className="w-full py-2 pl-4 pr-2 sm:w-auto">
        <div className="flex items-baseline gap-2">
          <span className="timing font-extrabold">#{d.kart_no}</span>
          <span className="timing text-xs text-ink-500">P{d.position || '–'}</span>
        </div>
        <div className="truncate text-xs text-ink-300">{d.name}</div>
        {/* Phones: the pit/stint record columns as extra lines. */}
        <div className="timing mt-0.5 text-[0.75rem] leading-snug text-ink-500 sm:hidden">
          <div className={`truncate ${lastShort ? 'font-bold text-race-red' : ''}`}>{t('Last pit')} {fmtPit(last)}</div>
          {stops.length > 1 && (
            <div className={`truncate ${c.shortPits.length ? 'font-bold text-race-red' : ''}`}>{t('Shortest pit')} {fmtPit(shortest)}</div>
          )}
          <div className={`truncate ${c.longStints.length ? 'font-bold text-race-red' : ''}`}>
            {t('Longest stint')} {longest != null ? fmtClock(longest) : '–'}
          </div>
        </div>
      </td>
      <td className="whitespace-nowrap px-2 py-2">{now}</td>
      <td className="whitespace-nowrap px-2 py-2 text-right"><PitCount pits={d.pits} min={minPits} c={c} /></td>
      <td className={`timing hidden whitespace-nowrap px-2 py-2 text-right sm:table-cell ${lastShort ? 'font-extrabold text-race-red' : ''}`}>
        {fmtPit(last)}
      </td>
      <td className={`timing hidden whitespace-nowrap px-2 py-2 text-right sm:table-cell ${c.shortPits.length ? 'font-extrabold text-race-red' : ''}`}>
        {fmtPit(shortest)}
        {c.shortPits.length > 1 && <span className="ml-1 text-xs">×{c.shortPits.length}</span>}
      </td>
      <td className={`timing hidden whitespace-nowrap py-2 pl-2 pr-4 text-right sm:table-cell ${c.longStints.length ? 'font-extrabold text-race-red' : ''}`}>
        {longest != null ? fmtClock(longest) : '–'}
        {c.longStints.length > 1 && <span className="ml-1 text-xs">×{c.longStints.length}</span>}
      </td>
    </tr>
  )
}

/** "m:ss", "h:mm:ss" or plain seconds -> seconds; '' -> 0 (no limit); null = invalid. */
export function parseDuration(text: string): number | null {
  const v = text.trim()
  if (!v) return 0
  if (!/^\d+(:\d{1,2}){0,2}$/.test(v)) return null
  const parts = v.split(':').map(Number)
  if (parts.slice(1).some((p) => p >= 60)) return null
  return parts.reduce((acc, p) => acc * 60 + p, 0)
}

/** Pit stops made, against the mandatory number when one is set. */
function PitCount({ pits, min, c }: { pits: number; min: number; c: { pitsDue: number; pitsMissed: boolean } }) {
  const t = useT()
  if (!min) return <span className="timing">{pits}</span>
  const tone = c.pitsMissed
    ? 'bg-race-red/15 text-race-red'
    : c.pitsDue > 0 ? 'text-ink-100' : 'bg-race-green/15 text-race-green'
  return (
    <span className={`timing inline-block rounded-md px-1.5 py-0.5 font-bold ${tone}`}
      title={c.pitsDue > 0 ? t('{n} mandatory stops to go', { n: c.pitsDue }) : t('Mandatory stops done')}>
      {pits}<span className="font-normal opacity-60">/{min}</span>
    </span>
  )
}
