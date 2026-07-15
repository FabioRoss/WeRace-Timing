import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { PageHeader } from '../components/StatusBar'
import type { EventGroup, SnapshotMeta } from '../lib/useSnapshot'

/** Public index: published events (grouped snapshots) plus loose sessions. */
export function ResultsIndex() {
  const [events, setEvents] = useState<EventGroup[]>([])
  const [loose, setLoose] = useState<SnapshotMeta[]>([])
  const [track, setTrack] = useState('')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    void api<{ events: EventGroup[]; loose: SnapshotMeta[] }>('/api/events')
      .then((r) => { setEvents(r.events); setLoose(r.loose) })
      .catch(() => { setEvents([]); setLoose([]) })
      .finally(() => setLoaded(true))
  }, [])

  const tracks = useMemo(
    () => [...new Set([...events.map((e) => e.track), ...loose.map((l) => l.track)]
      .filter(Boolean))].sort(),
    [events, loose],
  )
  const shownEvents = track ? events.filter((e) => e.track === track) : events
  const shownLoose = track ? loose.filter((l) => l.track === track) : loose
  const empty = shownEvents.length === 0 && shownLoose.length === 0

  return (
    <div className="mx-auto flex min-h-full max-w-4xl flex-col">
      <PageHeader title="Results" subtitle="Published events & sessions" />
      <main className="flex-1 space-y-3 p-4">
        {tracks.length > 1 && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <button type="button" onClick={() => setTrack('')}
              className={`rounded-full px-3 py-1 text-xs ${!track ? 'bg-race-blue' : 'bg-pit-700'}`}>
              All tracks
            </button>
            {tracks.map((t) => (
              <button key={t} type="button" onClick={() => setTrack(t)}
                className={`rounded-full px-3 py-1 text-xs ${track === t ? 'bg-race-blue' : 'bg-pit-700'}`}>
                {t}
              </button>
            ))}
          </div>
        )}

        {loaded && empty && (
          <p className="text-sm text-ink-500">No published results yet.</p>
        )}

        {shownEvents.map((e) => (
          <Link key={e.id} to={`/events/${e.id}`}
            className="block rounded-xl bg-pit-900 p-4 ring-1 ring-pit-800 hover:ring-race-red">
            <div className="flex items-center gap-2">
              <span className="rounded bg-race-red px-1.5 py-0.5 text-[0.6rem] font-bold uppercase tracking-wider text-white">
                Event
              </span>
              <span className="font-bold">{e.name}</span>
            </div>
            <div className="mt-0.5 text-xs text-ink-500">
              {[e.track, `${e.sessions.length} session${e.sessions.length === 1 ? '' : 's'}`]
                .filter(Boolean).join(' · ')}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
              {e.sessions.map((s) => (
                <span key={s.id} className="rounded bg-pit-800 px-2 py-0.5 text-ink-300">
                  {s.run_type || s.name}
                </span>
              ))}
            </div>
          </Link>
        ))}

        {shownLoose.map((m) => (
          <Link key={m.id} to={`/results/${m.id}`}
            className="block rounded-xl bg-pit-900 p-4 ring-1 ring-pit-800 hover:ring-race-red">
            <div className="font-bold">{m.name || m.id}</div>
            <div className="mt-0.5 text-xs text-ink-500">
              {[m.track, `${m.driver_count ?? 0} karts`,
                m.created_at ? new Date(m.created_at * 1000).toLocaleDateString() : '']
                .filter(Boolean).join(' · ')}
            </div>
            {m.podium && m.podium.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-3 text-sm">
                {m.podium.map((p) => (
                  <span key={p.kart_no} className="text-ink-300">
                    <span className="font-bold text-race-red">P{p.position}</span> #{p.kart_no} {p.name}
                  </span>
                ))}
              </div>
            )}
          </Link>
        ))}
      </main>
    </div>
  )
}
