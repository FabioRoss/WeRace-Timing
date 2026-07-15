import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../lib/api'
import { PageHeader } from '../components/StatusBar'
import { SessionResult } from '../components/SessionResult'
import type { SnapshotRecord } from '../lib/useSnapshot'

interface EventDetailData {
  id: string
  name: string
  track: string
  sessions: SnapshotRecord[]
}

/** Public view of an event: one tab per session, each a full SessionResult. */
export function EventDetail() {
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

  if (loading) return <p className="p-6 text-ink-500">Loading…</p>
  if (error || !event || event.sessions.length === 0) {
    return (
      <div className="p-6">
        <p className="text-race-red">{error || 'Event not found.'}</p>
        <Link to="/results" className="text-race-blue">← All results</Link>
      </div>
    )
  }

  const session = event.sessions[Math.min(active, event.sessions.length - 1)]
  return (
    <div className="mx-auto flex min-h-full max-w-4xl flex-col">
      <PageHeader title={event.name} subtitle={event.track} />
      <main className="flex-1 space-y-4 p-4">
        <Link to="/results" className="text-xs text-race-blue">← All results</Link>

        <div className="flex flex-wrap gap-2">
          {event.sessions.map((s, i) => (
            <button key={s.id} type="button" onClick={() => setActive(i)}
              className={`rounded px-3 py-1.5 text-xs font-bold uppercase tracking-wider ${
                i === active ? 'bg-race-red text-white' : 'bg-pit-800 text-ink-300 hover:bg-pit-700'
              }`}>
              {s.snapshot?.race?.run_type || s.name || `Session ${i + 1}`}
            </button>
          ))}
        </div>

        <SessionResult record={session} baseUrl={`/api/results/${session.id}`} />
      </main>
    </div>
  )
}
