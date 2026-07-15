import { useMemo, useState } from 'react'
import { TimingTable } from './TimingTable'
import { PenaltyLog } from './PenaltyLog'
import { OrderToggle, useOrderMode } from './OrderToggle'
import { SnapshotLapCharts } from './SnapshotLapCharts'
import type { SnapshotRecord } from '../lib/useSnapshot'

/**
 * The public read-only body for one saved session: public notes, the
 * classification (no track ring), penalties, lap-time charts, and the PDF
 * download. Shared by the single results page and each tab of an event, so both
 * surface the same full saved data.
 */
export function SessionResult({ record, baseUrl }: { record: SnapshotRecord; baseUrl: string }) {
  const snapshot = record.snapshot
  const race = snapshot.race
  const isRace = race?.session_kind === 'race'
  const [orderMode, setOrderMode] = useOrderMode()
  const pdfUrl = useMemo(() => `${baseUrl}/timesheet.pdf?t=${Date.now()}`, [baseUrl])
  const [downloading, setDownloading] = useState(false)

  return (
    <div className="space-y-4">
      {record.public_notes && (
        <div className="rounded-xl bg-pit-900 p-4 text-sm text-ink-200 ring-1 ring-pit-800">
          {record.public_notes}
        </div>
      )}

      <div className="rounded-xl bg-pit-900 ring-1 ring-pit-800">
        {isRace && (
          <div className="flex justify-end px-3 pt-3">
            <OrderToggle mode={orderMode} onChange={setOrderMode} />
          </div>
        )}
        <TimingTable
          snapshot={snapshot}
          orderMode={isRace ? orderMode : 'race'}
          ring={false}
          lapsBase={baseUrl}
        />
      </div>

      {snapshot.penalties.length > 0 && (
        <div className="rounded-xl bg-pit-900 p-4 ring-1 ring-pit-800">
          <h3 className="label-race mb-3">Penalties &amp; warnings</h3>
          <PenaltyLog penalties={snapshot.penalties} />
        </div>
      )}

      <SnapshotLapCharts baseUrl={baseUrl} drivers={snapshot.drivers} />

      <a
        href={pdfUrl}
        onClick={() => { setDownloading(true); setTimeout(() => setDownloading(false), 1500) }}
        className="inline-block rounded bg-race-red px-4 py-2 text-sm font-bold uppercase tracking-wider text-white hover:brightness-110"
      >
        {downloading ? 'Preparing…' : 'Download PDF timesheet'}
      </a>
    </div>
  )
}
