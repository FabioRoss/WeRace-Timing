import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../lib/api'
import { PageHeader } from '../components/StatusBar'
import { CheckerFlag } from '../components/CheckerFlag'
import { SessionResult } from '../components/SessionResult'
import { Page, Tabs } from '../components/ui'
import type { SnapshotRecord } from '../lib/useSnapshot'
import { useT } from '../lib/i18n'

interface EventDetailData {
  id: string
  name: string
  track: string
  sessions: SnapshotRecord[]
}

/** Public view of an event: one tab per session, each a full SessionResult. */
export function EventDetail() {
  const t = useT()
  const { id = '' } = useParams()
  const [event, setEvent] = useState<EventDetailData | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [active, setActive] = useState(0)

  useEffect(() => {
    setLoading(true)
    api<EventDetailData>(`/api/events/${id}`)
      .then((e) => { setEvent(e); setError(''); setActive(0) })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [id])

  useEffect(() => {
    if (event) document.title = `${event.name || 'Event'} — WeRace`
    return () => { document.title = 'WeRace Bridge' }
  }, [event])

  if (loading) return <p className="p-6 text-ink-500">{t('Loading…')}</p>
  if (error || !event || event.sessions.length === 0) {
    return (
      <div className="p-6">
        <p className="text-race-red">{error || t('Event not found.')}</p>
        <Link to="/results" className="text-race-blue">{t('← All results')}</Link>
      </div>
    )
  }

  const session = event.sessions[Math.min(active, event.sessions.length - 1)]
  return (
    <Page width="max-w-4xl" className="pb-8">
      <PageHeader
        title={event.name}
        subtitle={event.track}
        left={<CheckerFlag />}
      />
      <Tabs<string>
        value={String(Math.min(active, event.sessions.length - 1))}
        onChange={(v) => setActive(Number(v))}
        tabs={event.sessions.map((s, i) => ({
          id: String(i),
          label: s.short_name || s.name || s.snapshot?.race?.run_type || t('Session {n}', { n: i + 1 }),
        }))}
      />
      <main className="flex-1 space-y-3 px-3 pt-3 sm:space-y-4 sm:px-4 sm:pt-4">
        <Link to="/results" className="inline-flex min-h-10 items-center text-sm text-race-blue">{t('← All results')}</Link>
        <SessionResult key={session.id} record={session} baseUrl={`/api/results/${session.id}`} />
      </main>
    </Page>
  )
}
