import { useMemo, useState } from 'react'
import type { DriverRow, Snapshot } from '../lib/types'
import { fmtClock } from '../lib/format'
import { useT } from '../lib/i18n'
import { Segmented } from './ui'

/**
 * Race Control pit board (venues with automatic pit lane): every kart's pit
 * stops and stints against the race rules — minimum pit time and maximum
 * stint. Karts in the pit lane show a live timer that turns green once they've
 * served the minimum.
 */

export interface PitCheck {
  shortPits: number[]          // indexes of stops under the minimum
  longStints: number[]         // indexes of completed stints over the maximum
  stintOver: boolean           // the running stint is already over the maximum
  pitsDue: number              // mandatory stops still to make
  pitsMissed: boolean          // session over with stops still due
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

export function checkKart(d: DriverRow, { minPitS, maxStintS, minPits, finished }: Rules): PitCheck {
  const shortPits = minPitS > 0
    ? (d.pit_times_ms ?? []).flatMap((ms, i) => (ms < minPitS * 1000 ? [i] : []))
    : []
  const longStints = maxStintS > 0
    ? (d.stints_s ?? []).flatMap((s, i) => (s > maxStintS ? [i] : []))
    : []
  const stintOver = maxStintS > 0 && !d.in_pit && (d.stint_seconds ?? 0) > maxStintS
  const pitsDue = Math.max(0, minPits - (d.pits ?? 0))
  // Missing stops only become a break once the kart can't make them any more.
  const pitsMissed = pitsDue > 0 && (finished || d.finished)
  return { shortPits, longStints, stintOver, pitsDue, pitsMissed }
}

export const hasIssue = (c: PitCheck) =>
  c.shortPits.length > 0 || c.longStints.length > 0 || c.stintOver || c.pitsMissed

/** Karts breaking a rule (for the section badge). */
export function countIssues(snapshot: Snapshot | null | undefined): number {
  if (!snapshot) return 0
  const rules = rulesOf(snapshot)
  if (!rules.minPitS && !rules.maxStintS && !rules.minPits) return 0
  return snapshot.drivers.filter((d) => hasIssue(checkKart(d, rules))).length
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

export function PitBoard({ snapshot, serverNow }: { snapshot: Snapshot; serverNow: number }) {
  const t = useT()
  const rules = rulesOf(snapshot)
  const { minPitS: min, maxStintS: max, minPits } = rules
  const [view, setView] = useState<View>('all')

  const rows = useMemo(
    () => snapshot.drivers.map((d) => ({ d, c: checkKart(d, rules) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot.drivers, min, max, minPits, rules.finished],
  )
  const issues = rows.filter((r) => hasIssue(r.c)).length
  const inPit = rows.filter((r) => r.d.in_pit).length
  const due = rows.filter((r) => r.c.pitsDue > 0).length
  const shown = rows.filter((r) =>
    view === 'all' || (view === 'issues' ? hasIssue(r.c) : view === 'due' ? r.c.pitsDue > 0 : r.d.in_pit))

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
            { value: 'issues', label: `${t('Issues')} ${issues || ''}`.trim() },
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

      {shown.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-ink-500">
          {view === 'issues' ? t('No rule breaks.') : view === 'pit' ? t('No kart in the pit lane.')
            : view === 'due' ? t('Every kart has made its mandatory stops.') : t('No karts yet.')}
        </p>
      ) : (
        <div className="scroll-x">
          <table className="w-full min-w-0 text-sm">
            <thead>
              <tr className="label-race border-y border-pit-800 text-left">
                <th className="py-2 pl-4 pr-2 font-semibold">{t('Kart')}</th>
                <th className="px-2 font-semibold">{t('Now')}</th>
                <th className="px-2 text-right font-semibold">{t('Pits')}</th>
                <th className="hidden px-2 text-right font-semibold sm:table-cell">{t('Last pit')}</th>
                <th className="hidden px-2 text-right font-semibold sm:table-cell">{t('Shortest pit')}</th>
                <th className="hidden pl-2 pr-4 text-right font-semibold sm:table-cell">{t('Longest stint')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(({ d, c }) => (
                <PitRow key={d.kart_no} d={d} c={c} min={min} max={max} minPits={minPits} serverNow={serverNow} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="px-4 py-3 text-xs text-ink-500">
        {t('Stint = time on track between pit exit and the next pit entry. Pit times are measured by the pit-lane gates.')}
      </p>
    </div>
  )
}

function PitRow({ d, c, min, max, minPits, serverNow }: {
  d: DriverRow
  c: PitCheck
  min: number
  max: number
  minPits: number
  serverNow: number
}) {
  const t = useT()
  const stops = d.pit_times_ms ?? []
  const stints = d.stints_s ?? []
  const last = stops.length ? stops[stops.length - 1] : d.last_pit_ms
  const shortest = stops.length ? Math.min(...stops) : null
  const longest = stints.length ? Math.max(...stints) : null
  const lastShort = stops.length > 0 && c.shortPits.includes(stops.length - 1)
  const issue = hasIssue(c)

  // Live: time in the pit lane, or the running stint.
  let now: React.ReactNode
  if (d.in_pit) {
    const inFor = d.pit_since_ts ? Math.max(0, serverNow - d.pit_since_ts) : null
    const served = !min || (inFor != null && inFor >= min)
    now = (
      <span className={`inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-extrabold ${
        served ? 'bg-race-green/15 text-race-green' : 'bg-race-yellow/15 text-race-yellow'
      }`}>
        {t('PIT')}
        <span className="timing">{inFor != null ? fmtClock(Math.floor(inFor)) : '–'}</span>
      </span>
    )
  } else {
    const s = d.stint_seconds ?? 0
    const tone = c.stintOver ? 'text-race-red font-extrabold' : max && s >= max * 0.9 ? 'text-race-yellow font-bold' : 'text-ink-100'
    now = <span className={`timing ${tone}`}>{d.stint_seconds != null ? fmtClock(s) : '–'}</span>
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
          <div>
            <span className={lastShort ? 'font-bold text-race-red' : ''}>{t('Last pit')} {fmtPit(last)}</span>
            {stops.length > 1 && (
              <span className={c.shortPits.length ? 'font-bold text-race-red' : ''}> · {t('min')} {fmtPit(shortest)}</span>
            )}
          </div>
          <div className={c.longStints.length ? 'font-bold text-race-red' : ''}>
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
function PitCount({ pits, min, c }: { pits: number; min: number; c: PitCheck }) {
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
