import { useEffect, useRef, useState } from 'react'
import { AccentPicker, DEFAULT_ACCENT } from './AccentPicker'
import { fmtLap } from '../lib/format'

/** The chrono-timesheet layout options, matching the export endpoint params.
 * Persisted per snapshot (as `pdf_config`) to become the public download's
 * default. */
export interface PdfConfig {
  charts?: boolean
  grid?: boolean
  pits?: boolean
  stints?: boolean
  pitest?: boolean
  penalties?: boolean
  event?: string
  session?: string
  accent?: string
  status?: string        // '' (auto) | 'provisional' | 'definitive'
  notes?: string         // free-text notes printed on the sheet
}

/**
 * The chrono-timesheet PDF options panel. Reused for live export and for saved
 * snapshots by swapping `pdfBase` (the endpoint that builds the PDF); pass a
 * `safeword` when the endpoint is safeword-gated (the download is a plain
 * navigation, so it travels as a query param like the backgrounds serve).
 *
 * For a saved snapshot, `initialConfig` seeds the toggles from the persisted
 * layout and `onSaveConfig` adds a "Save as public default" button that stores
 * the current selection (what the public download then uses).
 */
export function TimesheetPanel({
  pdfBase,
  safeword,
  eventName,
  trackName,
  runType,
  autoPitlane,
  kartCount,
  leaderName,
  leaderKart,
  fastest,
  initialConfig,
  onSaveConfig,
}: {
  pdfBase: string
  safeword?: string
  eventName: string
  trackName: string
  runType: string
  autoPitlane: boolean
  kartCount: number
  leaderName: string
  leaderKart: string
  fastest: { ms: number; kart: string } | null
  initialConfig?: PdfConfig
  onSaveConfig?: (config: PdfConfig) => Promise<void> | void
}) {
  const [charts, setCharts] = useState(initialConfig?.charts ?? false)
  const [grid, setGrid] = useState(initialConfig?.grid ?? true)
  const [pits, setPits] = useState(initialConfig?.pits ?? false)
  const [stints, setStints] = useState(initialConfig?.stints ?? false)
  const [pitEstimate, setPitEstimate] = useState(initialConfig?.pitest ?? false)
  const [penalties, setPenalties] = useState(initialConfig?.penalties ?? false)
  const [accent, setAccent] = useState(initialConfig?.accent || DEFAULT_ACCENT)
  const [eventOverride, setEventOverride] = useState(initialConfig?.event ?? '')
  const [sessionOverride, setSessionOverride] = useState(initialConfig?.session ?? '')
  const [status, setStatus] = useState(initialConfig?.status ?? '')
  const [notes, setNotes] = useState(initialConfig?.notes ?? '')
  const [savedConfig, setSavedConfig] = useState('')

  // Seed the editable name fields once from the session (unless a saved config
  // already supplied them), then the user owns them.
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current) return
    if (eventName || runType) {
      if (eventName && !initialConfig?.event) setEventOverride(eventName)
      if (runType && !initialConfig?.session) setSessionOverride(runType)
      seeded.current = true
    }
  }, [eventName, runType, initialConfig])

  const currentConfig = (): PdfConfig => ({
    charts, grid, pits, stints,
    pitest: pits && pitEstimate,
    penalties, accent,
    event: eventOverride.trim(),
    session: sessionOverride.trim(),
    status,
    notes: notes.trim(),
  })

  const saveConfig = () => {
    if (!onSaveConfig) return
    void Promise.resolve(onSaveConfig(currentConfig())).then(() => {
      setSavedConfig('Saved as public default ✓')
      setTimeout(() => setSavedConfig(''), 2500)
    })
  }

  // Append a per-click timestamp so no cache ever hands back a stale copy, then
  // download it programmatically.
  const downloadPdf = () => {
    const params = new URLSearchParams({
      charts: charts ? '1' : '0',
      grid: grid ? '1' : '0',
      pits: pits ? '1' : '0',
      stints: stints ? '1' : '0',
      pitest: pits && pitEstimate ? '1' : '0',
      penalties: penalties ? '1' : '0',
      accent,
      t: String(Date.now()),
    })
    if (eventOverride.trim()) params.set('event', eventOverride.trim())
    if (sessionOverride.trim()) params.set('session', sessionOverride.trim())
    if (status) params.set('status', status)
    if (notes.trim()) params.set('notes', notes.trim())
    if (safeword) params.set('safeword', safeword)
    const a = document.createElement('a')
    a.href = `${pdfBase}/timesheet.pdf?${params.toString()}`
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div className="rounded-xl bg-pit-900 p-5 ring-1 ring-pit-800">
        <h2 className="text-sm font-bold uppercase tracking-wider text-ink-300">
          Chrono timesheet (PDF)
        </h2>
        <p className="mt-1 text-sm text-ink-500">
          A modern classification sheet with an optional lap-by-lap grid for every kart —
          the print-style sheet you'd hand out after the race.
        </p>

        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <Summary label="Event" value={eventName || '—'} />
          <Summary label="Track" value={trackName || '—'} />
          <Summary label="Karts" value={kartCount ? String(kartCount) : '—'} />
          <Summary label="Leader" value={leaderName ? `#${leaderKart} ${leaderName}` : '—'} />
          <Summary
            label="Fastest lap"
            value={fastest ? `${fmtLap(fastest.ms)} (#${fastest.kart})` : '—'}
          />
        </dl>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="label-race">Event name</span>
            <input
              value={eventOverride}
              onChange={(e) => setEventOverride(e.target.value)}
              placeholder="Event"
              className="mt-1 w-full rounded bg-pit-950 px-3 py-2 text-sm ring-1 ring-pit-600 focus:ring-race-red"
            />
          </label>
          <label className="block">
            <span className="label-race">Session name</span>
            <input
              value={sessionOverride}
              onChange={(e) => setSessionOverride(e.target.value)}
              placeholder="Session"
              className="mt-1 w-full rounded bg-pit-950 px-3 py-2 text-sm ring-1 ring-pit-600 focus:ring-race-red"
            />
          </label>
        </div>
        <p className="mt-1 text-[0.65rem] text-ink-500">
          Used on the sheet header and the file name (with the date).
        </p>

        <label className="mt-4 block">
          <span className="label-race">Result status</span>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="mt-1 w-full rounded bg-pit-950 px-3 py-2 text-sm ring-1 ring-pit-600 focus:ring-race-red sm:w-64"
          >
            <option value="">Auto (from session state)</option>
            <option value="provisional">Provisional</option>
            <option value="definitive">Definitive</option>
          </select>
          <span className="mt-1 block text-[0.65rem] text-ink-500">
            Stamped as a badge in the sheet header.
          </span>
        </label>

        <label className="mt-4 block">
          <span className="label-race">Notes</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="Optional notes printed on the sheet (e.g. stewards' decisions, conditions)…"
            className="mt-1 w-full rounded bg-pit-950 px-3 py-2 text-sm ring-1 ring-pit-600 focus:ring-race-red"
          />
        </label>

        <div className="mt-4 space-y-2">
          <div className="label-race">Include</div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={grid} onChange={(e) => setGrid(e.target.checked)} />
            Lap-by-lap grid
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={charts} onChange={(e) => setCharts(e.target.checked)} />
            Charts (best lap + pace trend)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={pits} onChange={(e) => setPits(e.target.checked)} />
            Pit stops
          </label>
          {pits && !autoPitlane && (
            <label className="ml-6 flex items-center gap-2 text-sm text-ink-300">
              <input
                type="checkbox"
                checked={pitEstimate}
                onChange={(e) => setPitEstimate(e.target.checked)}
              />
              Estimate stop durations (inferred)
            </label>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={stints} onChange={(e) => setStints(e.target.checked)} />
            Stint times
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={penalties} onChange={(e) => setPenalties(e.target.checked)} />
            Apply penalties (final result)
          </label>
          {penalties && (
            <p className="ml-6 text-[0.65rem] text-ink-500">
              Recomputes the classification with outstanding penalties applied and adds a summary.
            </p>
          )}
        </div>

        <div className="mt-4">
          <div className="label-race mb-1.5">Accent colour</div>
          <AccentPicker value={accent} onChange={setAccent} />
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={downloadPdf}
            className="inline-block rounded bg-race-red px-4 py-2 text-sm font-bold uppercase tracking-wider text-white hover:brightness-110"
          >
            Download PDF
          </button>
          {onSaveConfig && (
            <button
              type="button"
              onClick={saveConfig}
              className="inline-block rounded bg-pit-700 px-4 py-2 text-sm font-bold uppercase tracking-wider text-ink-100 hover:bg-pit-600"
            >
              Save as public default
            </button>
          )}
          {savedConfig && <span className="text-xs text-race-green">{savedConfig}</span>}
        </div>
        {onSaveConfig && (
          <p className="mt-2 text-[0.65rem] text-ink-500">
            The public results page downloads the PDF with this layout.
          </p>
        )}
        {!kartCount && (
          <p className="mt-3 text-xs text-ink-500">
            No timing data yet — connect a source (or replay a recording) first.
          </p>
        )}
      </div>
    </div>
  )
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="label-race">{label}</dt>
      <dd className="truncate">{value}</dd>
    </div>
  )
}
