import { useEffect } from 'react'
import { Link, useParams } from 'react-router-dom'
import { PageHeader } from '../components/StatusBar'
import { FlagBanner } from '../components/FlagBanner'
import { SessionResult } from '../components/SessionResult'
import { useSnapshotRecord } from '../lib/useSnapshot'

/** Public read-only summary of a published session. */
export function ResultsDetail() {
  const { id = '' } = useParams()
  const { record, error, loading } = useSnapshotRecord(`/api/results/${id}`, false)

  const snapshot = record?.snapshot ?? null
  const race = snapshot?.race

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

  return (
    <div className="mx-auto flex min-h-full max-w-4xl flex-col">
      <PageHeader
        title={record.name || record.id}
        subtitle={record.track}
        right={<FlagBanner flag={race?.flag ?? 'finish'} compact />}
      />
      <main className="flex-1 space-y-4 p-4">
        <Link to="/results" className="text-xs text-race-blue">← All results</Link>
        <SessionResult record={record} baseUrl={`/api/results/${id}`} />
      </main>
    </div>
  )
}
