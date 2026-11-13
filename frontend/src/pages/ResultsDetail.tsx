import { useEffect } from 'react'
import { Link, useParams } from 'react-router-dom'
import { PageHeader } from '../components/StatusBar'
import { CheckerFlag } from '../components/CheckerFlag'
import { SessionResult } from '../components/SessionResult'
import { Page } from '../components/ui'
import { useSnapshotRecord } from '../lib/useSnapshot'
import { useT } from '../lib/i18n'

/** Public read-only summary of a published session. */
export function ResultsDetail() {
  const t = useT()
  const { id = '' } = useParams()
  const { record, error, loading } = useSnapshotRecord(`/api/results/${id}`, false)

  const snapshot = record?.snapshot ?? null

  useEffect(() => {
    if (record) document.title = `${record.name || 'Results'} — WeRace`
    return () => { document.title = 'WeRace Bridge' }
  }, [record])

  if (loading) return <p className="p-6 text-ink-500">{t('Loading…')}</p>
  if (error || !record || !snapshot) {
    return (
      <div className="p-6">
        <p className="text-race-red">{error || t('Result not found.')}</p>
        <Link to="/results" className="text-race-blue">{t('← All results')}</Link>
      </div>
    )
  }

  return (
    <Page width="max-w-4xl" className="pb-8">
      <PageHeader
        title={record.name || record.id}
        subtitle={record.track}
        left={<CheckerFlag />}
      />
      <main className="flex-1 space-y-3 px-3 pt-3 sm:space-y-4 sm:px-4 sm:pt-4">
        <Link to="/results" className="inline-flex min-h-10 items-center text-sm text-race-blue">{t('← All results')}</Link>
        <SessionResult record={record} baseUrl={`/api/results/${id}`} />
      </main>
    </Page>
  )
}
