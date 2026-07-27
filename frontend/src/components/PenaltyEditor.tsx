import { useMemo, useState } from 'react'
import { api } from '../lib/api'
import { PenaltyLog } from './PenaltyLog'
import { LAP_PENALTY_PRESETS, PENALTY_REASONS, TIME_PENALTY_PRESETS } from '../lib/penalties'
import type { DriverRow, Penalty } from '../lib/types'
import { useT } from '../lib/i18n'

/**
 * Assign / serve / remove penalties, with a summed "to serve in pit" panel and
 * the full log. Parametrized by `apiBase` so it drives both the live event
 * (`/e/{slot}/api/admin`, updates flow back over the websocket) and a saved
 * snapshot (`/api/admin/snapshots/{id}`, where `onChanged` refetches).
 */
export function PenaltyEditor({ apiBase, drivers, penalties, onChanged, canRevert, allowAdjust }: {
  apiBase: string
  drivers: DriverRow[]
  penalties: Penalty[]
  onChanged?: () => void
  canRevert?: boolean
  // Enable a neutral "time adjustment" mode (signed seconds) — organizer-side
  // corrections. Snapshot-only; live Race Control leaves it off.
  allowAdjust?: boolean
}) {
  const t = useT()
  const [penKart, setPenKart] = useState('')
  const [penKind, setPenKind] = useState<'time' | 'lap' | 'warning' | 'adjust'>('time')
  const [penSeconds, setPenSeconds] = useState(10)
  const [penLaps, setPenLaps] = useState(1)
  const [adjustMode, setAdjustMode] = useState<'seconds' | 'laps'>('seconds')
  const [adjustSec, setAdjustSec] = useState(24)   // signed; + adds time, − credits back
  const [adjustLaps, setAdjustLaps] = useState(1)  // signed; + gives laps back, − removes
  const [penReason, setPenReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState('')
  const [error, setError] = useState('')

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      onChanged?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // Kart selector ordered by number (not race order, which shuffles).
  const karts = useMemo(
    () => [...drivers].sort(
      (a, b) => (parseInt(a.kart_no, 10) || 0) - (parseInt(b.kart_no, 10) || 0)
        || a.kart_no.localeCompare(b.kart_no),
    ),
    [drivers],
  )
  const inPit = useMemo(
    () => new Set(drivers.filter((d) => d.in_pit).map((d) => d.kart_no)),
    [drivers],
  )
  // Outstanding time penalties summed per kart (5s + 10s -> +15s), in-pit first.
  const toServeGroups = useMemo(() => {
    const byKart = new Map<string, { kart: string; seconds: number; ids: number[]; reasons: string[] }>()
    for (const p of penalties) {
      if (p.kind !== 'time' || p.served) continue
      const g = byKart.get(p.kart_no) ?? { kart: p.kart_no, seconds: 0, ids: [], reasons: [] }
      g.seconds += p.seconds
      g.ids.push(p.id)
      if (p.reason) g.reasons.push(p.reason)
      byKart.set(p.kart_no, g)
    }
    return [...byKart.values()].sort((a, b) => {
      const ap = inPit.has(a.kart) ? 1 : 0
      const bp = inPit.has(b.kart) ? 1 : 0
      return bp - ap
        || (parseInt(a.kart, 10) || 0) - (parseInt(b.kart, 10) || 0)
        || a.kart.localeCompare(b.kart)
    })
  }, [penalties, inPit])

  const assign = (e: React.FormEvent) => {
    e.preventDefault()
    if (!penKart) { setError(t('Select a kart')); return }
    if (penKind === 'time' && penSeconds <= 0) { setError(t('Enter penalty seconds')); return }
    if (penKind === 'lap' && penLaps <= 0) { setError(t('Enter penalty laps')); return }
    const adjustVal = adjustMode === 'seconds' ? adjustSec : adjustLaps
    if (penKind === 'adjust' && !adjustVal) { setError(t('Enter a non-zero adjustment')); return }
    const body = {
      kart_no: penKart,
      kind: penKind,
      seconds: penKind === 'time' ? penSeconds
        : penKind === 'adjust' && adjustMode === 'seconds' ? adjustSec : 0,
      laps: penKind === 'lap' ? penLaps
        : penKind === 'adjust' && adjustMode === 'laps' ? adjustLaps : 0,
      reason: penReason.trim(),
    }
    const noun = penKind === 'warning' ? t('Warning') : penKind === 'adjust' ? t('Adjustment') : t('Penalty')
    void run(async () => {
      await api(`${apiBase}/penalty`, { body, safeword: true })
      setSent(t('{noun} applied to #{kart}', { noun, kart: penKart }))
      setPenReason('')
      setTimeout(() => setSent(''), 3000)
    })
  }

  const serve = (id: number, served: boolean) => void run(() =>
    api(`${apiBase}/penalty/${id}/served`, { body: { served }, safeword: true }))
  const serveKart = (ids: number[]) => void run(() =>
    Promise.all(ids.map((id) =>
      api(`${apiBase}/penalty/${id}/served`, { body: { served: true }, safeword: true }))))
  const remove = (id: number) => {
    const p = penalties.find((x) => x.id === id)
    const what = p
      ? (p.kind === 'warning'
          ? t('the warning for #{kart}', { kart: p.kart_no })
          : t('the penalty for #{kart}', { kart: p.kart_no }))
      : t('this penalty')
    if (!window.confirm(t('Remove {what}? This cannot be undone.', { what }))) return
    void run(() => api(`${apiBase}/penalty/${id}`, { method: 'DELETE', safeword: true }))
  }
  const revert = () => {
    if (!window.confirm(t('Revert to the as-finished penalties? Amendments will be lost.'))) return
    void run(() => api(`${apiBase}/penalty/revert`, { safeword: true }))
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {/* Assign */}
      <form onSubmit={assign} className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="label-race text-ink-500">{t('Kart')}</span>
          <select
            value={penKart}
            onChange={(e) => setPenKart(e.target.value)}
            className="rounded bg-pit-950 px-2 py-1.5 ring-1 ring-pit-600 focus:ring-race-blue"
          >
            <option value="">{t('Select…')}</option>
            {karts.map((d) => (
              <option key={d.kart_no} value={d.kart_no}>
                #{d.kart_no}{d.name ? ` — ${d.name}` : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {([['time', 'Time'], ['lap', 'Lap'], ['warning', 'Warning'],
             ...(allowAdjust ? [['adjust', 'Adjust'] as const] : [])] as const).map(([k, lbl]) => (
            <button key={k} type="button" onClick={() => setPenKind(k)}
              className={`rounded-full px-3 py-1 text-xs font-bold uppercase ${
                penKind === k
                  ? (k === 'adjust' ? 'bg-race-blue text-white' : 'bg-race-red text-white')
                  : 'bg-pit-700'
              }`}>
              {t(lbl)}
            </button>
          ))}
        </div>
        {penKind === 'time' && (
          <div className="flex flex-wrap items-center gap-1.5">
            {TIME_PENALTY_PRESETS.map((s) => (
              <button key={s} type="button" onClick={() => setPenSeconds(s)}
                className={`min-w-9 rounded px-2 py-1 text-xs font-bold ${
                  penSeconds === s ? 'bg-race-yellow text-pit-950' : 'bg-pit-700'
                }`}>
                +{s}s
              </button>
            ))}
            <input type="number" min={1} max={3600} value={penSeconds}
              onChange={(e) => setPenSeconds(Math.max(0, parseInt(e.target.value, 10) || 0))}
              className="w-20 rounded bg-pit-950 px-2 py-1 ring-1 ring-pit-600" />
            <span className="text-xs text-ink-500">{t('seconds')}</span>
          </div>
        )}
        {penKind === 'adjust' && (
          <div className="space-y-1.5">
            <div className="flex flex-wrap gap-1.5">
              {(['seconds', 'laps'] as const).map((m) => (
                <button key={m} type="button" onClick={() => setAdjustMode(m)}
                  className={`rounded-full px-3 py-1 text-xs font-bold uppercase ${
                    adjustMode === m ? 'bg-race-blue text-white' : 'bg-pit-700'
                  }`}>
                  {m === 'seconds' ? t('Time (s)') : t('Laps')}
                </button>
              ))}
            </div>
            {adjustMode === 'seconds' ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {[-30, -10, -5, 5, 10, 30].map((s) => (
                  <button key={s} type="button" onClick={() => setAdjustSec(s)}
                    className={`min-w-9 rounded px-2 py-1 text-xs font-bold ${
                      adjustSec === s ? 'bg-race-blue text-white' : 'bg-pit-700'
                    }`}>
                    {s > 0 ? `+${s}` : s}s
                  </button>
                ))}
                <input type="number" min={-3600} max={3600} value={adjustSec}
                  onChange={(e) => setAdjustSec(parseInt(e.target.value, 10) || 0)}
                  className="w-20 rounded bg-pit-950 px-2 py-1 ring-1 ring-pit-600" />
                <span className="text-xs text-ink-500">{t('seconds')}</span>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-1.5">
                {[-2, -1, 1, 2].map((l) => (
                  <button key={l} type="button" onClick={() => setAdjustLaps(l)}
                    className={`min-w-9 rounded px-2 py-1 text-xs font-bold ${
                      adjustLaps === l ? 'bg-race-blue text-white' : 'bg-pit-700'
                    }`}>
                    {l > 0 ? `+${l}` : l}
                  </button>
                ))}
                <input type="number" min={-100} max={100} value={adjustLaps}
                  onChange={(e) => setAdjustLaps(parseInt(e.target.value, 10) || 0)}
                  className="w-20 rounded bg-pit-950 px-2 py-1 ring-1 ring-pit-600" />
                <span className="text-xs text-ink-500">{t('laps')}</span>
              </div>
            )}
            <p className="text-[0.65rem] text-ink-500">
              {adjustMode === 'seconds' ? (
                <>{t('A neutral timing correction (not a penalty).')}{' '}
                  <b>+</b> {t('adds time,')} <b>−</b> {t('credits it back.')}</>
              ) : (
                <>{t('A neutral lap correction (not a penalty).')}{' '}
                  <b>+</b> {t('gives laps back,')} <b>−</b> {t('removes them.')}</>
              )}
            </p>
          </div>
        )}
        {penKind === 'lap' && (
          <div className="flex flex-wrap items-center gap-1.5">
            {LAP_PENALTY_PRESETS.map((l) => (
              <button key={l} type="button" onClick={() => setPenLaps(l)}
                className={`min-w-9 rounded px-2 py-1 text-xs font-bold ${
                  penLaps === l ? 'bg-race-yellow text-pit-950' : 'bg-pit-700'
                }`}>
                −{l}
              </button>
            ))}
            <input type="number" min={1} max={100} value={penLaps}
              onChange={(e) => setPenLaps(Math.max(0, parseInt(e.target.value, 10) || 0))}
              className="w-20 rounded bg-pit-950 px-2 py-1 ring-1 ring-pit-600" />
            <span className="text-xs text-ink-500">{t('laps')}</span>
          </div>
        )}
        {penKind !== 'adjust' && (
          <div className="flex flex-wrap gap-1.5">
            {PENALTY_REASONS.map((r) => (
              <button key={r} type="button" onClick={() => setPenReason(t(r))}
                className="rounded-full bg-pit-700 px-3 py-1 text-xs hover:bg-pit-600">
                {t(r)}
              </button>
            ))}
          </div>
        )}
        <input value={penReason} onChange={(e) => setPenReason(e.target.value)} maxLength={120}
          placeholder={penKind === 'adjust' ? t('Reason, e.g. early pit release (optional)…') : t('Reason (optional)…')}
          className="w-full rounded bg-pit-950 px-3 py-2 outline-none ring-1 ring-pit-600 focus:ring-race-blue" />
        <button type="submit" disabled={busy || !penKart}
          className="rounded bg-race-red px-4 py-2 font-bold uppercase tracking-wider disabled:opacity-40 hover:brightness-110">
          {t('Assign')}
        </button>
        {sent && <p className="text-xs text-race-green">{sent}</p>}
        {error && <p className="text-xs text-race-red">{error}</p>}
      </form>

      {/* To serve in pit (outstanding time penalties, summed per kart) */}
      <div>
        <h4 className="label-race mb-2 text-race-yellow">{t('To serve in pit')}</h4>
        {toServeGroups.length === 0 ? (
          <p className="text-sm text-ink-500">{t('No time penalties outstanding.')}</p>
        ) : (
          <ul className="max-h-56 space-y-2 overflow-y-auto text-sm">
            {toServeGroups.map((g) => (
              <li key={g.kart}
                className={`flex items-center gap-2 rounded px-3 py-2 ${
                  inPit.has(g.kart) ? 'bg-pit-850 ring-1 ring-race-red' : 'bg-pit-850'
                }`}>
                <span className="min-w-[2.5rem] font-timing font-bold">#{g.kart}</span>
                {inPit.has(g.kart) && (
                  <span className="rounded bg-race-red px-1.5 py-0.5 text-[0.6rem] font-bold text-white">
                    {t('IN PIT')}
                  </span>
                )}
                <span className="flex-1 truncate">
                  <span className="font-bold text-race-red">+{g.seconds}s</span>
                  {g.reasons.length > 0 && (
                    <span className="text-ink-300"> — {[...new Set(g.reasons)].join(', ')}</span>
                  )}
                  {g.ids.length > 1 && (
                    <span className="ml-1 text-[0.65rem] text-ink-500">({t('{n} penalties', { n: g.ids.length })})</span>
                  )}
                </span>
                <button type="button" onClick={() => serveKart(g.ids)}
                  className="rounded bg-race-green px-2 py-0.5 text-[0.65rem] font-bold uppercase text-pit-950">
                  {t('serve')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Full log */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h4 className="label-race">{t('All penalties & warnings')}</h4>
          {canRevert && (
            <button type="button" onClick={revert} disabled={busy}
              className="rounded bg-pit-700 px-2 py-0.5 text-[0.65rem] font-bold uppercase text-ink-300 hover:bg-pit-600 disabled:opacity-40">
              {t('revert')}
            </button>
          )}
        </div>
        <PenaltyLog penalties={penalties} onServe={serve} onRemove={remove} />
      </div>
    </div>
  )
}
