import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { PageHeader } from '../components/StatusBar'
import { FlagBanner } from '../components/FlagBanner'
import { TimingTable } from '../components/TimingTable'
import { PenaltyLog } from '../components/PenaltyLog'
import { OrderToggle, useOrderMode } from '../components/OrderToggle'
import { useSnapshotRecord } from '../lib/useSnapshot'

/** Public read-only summary of a published session. */
export function ResultsDetail() {
  const { id = '' } = useParams()
  const { record, error, loading } = useSnapshotRecord(`/api/results/${id}`, false)
  const [orderMode, setOrderMode] = useOrderMode()

  const snapshot = record?.snapshot ?? null
  const race = snapshot?.race
  // No params -> the backend applies the snapshot's saved public PDF layout.
  const pdfUrl = useMemo(
    () => `/api/results/${id}/timesheet.pdf?t=${Date.now()}`,
    [id],
  )
  const [downloading, setDownloading] = useState(false)

  useEffect(() => {
    if (record) document.title = `${record.name || 'Results'} — WeRace`
    return () => { document.title = 'WeRace Bridge' }
  }, [record])

  if (loading) return <p className="p-6 text-ink-500">Loading…</p>
  if (error || !record || !snapshot) {
    return (
      <div className="p-6">
        <p className="text-race-red">{error || 'Result not found.'}</p>
        <Link to="/results" className="text-race-blue">← All results</Link>
      </div>
    )
  }

  const isRace = race?.session_kind === 'race'
  return (
    <div className="mx-auto flex min-h-full max-w-4xl flex-col">
      <PageHeader
        title={record.name || record.id}
        subtitle={record.track}
        right={<FlagBanner flag={race?.flag ?? 'finish'} compact />}
      />
      <main className="flex-1 space-y-4 p-4">
        <Link to="/results" className="text-xs text-race-blue">← All results</Link>

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
          <TimingTable snapshot={snapshot} orderMode={isRace ? orderMode : 'race'} />
        </div>

        {snapshot.penalties.length > 0 && (
          <div className="rounded-xl bg-pit-900 p-4 ring-1 ring-pit-800">
            <h3 className="label-race mb-3">Penalties &amp; warnings</h3>
            <PenaltyLog penalties={snapshot.penalties} />
          </div>
        )}

        <a
          href={pdfUrl}
          onClick={() => { setDownloading(true); setTimeout(() => setDownloading(false), 1500) }}
          className="inline-block rounded bg-race-red px-4 py-2 text-sm font-bold uppercase tracking-wider text-white hover:brightness-110"
        >
          {downloading ? 'Preparing…' : 'Download PDF timesheet'}
        </a>
      </main>
    </div>
  )
}
