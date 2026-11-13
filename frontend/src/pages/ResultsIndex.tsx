import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { PageHeader } from '../components/StatusBar'
import { CheckerFlag } from '../components/CheckerFlag'
import { Page } from '../components/ui'
import type { EventGroup, SnapshotMeta } from '../lib/useSnapshot'
import { useT } from '../lib/i18n'

/** Public index: published events (grouped snapshots) plus loose sessions. */
export function ResultsIndex() {
  const t = useT()
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
    <Page width="max-w-4xl" className="pb-8">
      <PageHeader title={t('Results')} subtitle={t('Published events & sessions')} left={<CheckerFlag />} />
      <main className="flex-1 space-y-3 px-3 pt-3 sm:px-4 sm:pt-4">
        <Link to="/" className="inline-flex min-h-10 items-center text-sm text-race-blue">{t('← Home')}</Link>
        {tracks.length > 1 && (
          <div className="no-scrollbar -mx-3 flex gap-2 overflow-x-auto px-3 sm:mx-0 sm:flex-wrap sm:px-0">
            <button type="button" onClick={() => setTrack('')}
              className={`chip ${!track ? 'bg-race-blue! text-white' : ''}`}>
              {t('All tracks')}
            </button>
            {tracks.map((tk) => (
              <button key={tk} type="button" onClick={() => setTrack(tk)}
                className={`chip ${track === tk ? 'bg-race-blue! text-white' : ''}`}>
                {tk}
              </button>
            ))}
          </div>
        )}

        {loaded && empty && (
          <p className="text-sm text-ink-500">{t('No published results yet.')}</p>
        )}

        {shownEvents.map((e) => (
          <Link key={e.id} to={`/events/${e.id}`}
            className="block rounded-2xl bg-pit-900 p-4 ring-1 ring-pit-800 transition hover:ring-race-red active:scale-[0.99]">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 truncate text-base font-bold">{e.name}</div>
              <span className="shrink-0 text-xl text-ink-500" aria-hidden>›</span>
            </div>
            <div className="mt-0.5 text-xs text-ink-500">
              {[e.track, e.sessions.length === 1 ? t('{n} session', { n: 1 }) : t('{n} sessions', { n: e.sessions.length })]
                .filter(Boolean).join(' · ')}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
              {e.sessions.map((s) => (
                <span key={s.id} className="rounded bg-pit-800 px-2 py-0.5 text-ink-300">
                  {s.short_name || s.name || s.run_type}
                </span>
              ))}
            </div>
          </Link>
        ))}

        {shownLoose.map((m) => (
          <Link key={m.id} to={`/results/${m.id}`}
            className="block rounded-2xl bg-pit-900 p-4 ring-1 ring-pit-800 transition hover:ring-race-red active:scale-[0.99]">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 truncate text-base font-bold">{m.name || m.id}</div>
              <span className="shrink-0 text-xl text-ink-500" aria-hidden>›</span>
            </div>
            <div className="mt-0.5 text-xs text-ink-500">
              {[m.track, t('{n} karts', { n: m.driver_count ?? 0 }),
                m.created_at ? new Date(m.created_at * 1000).toLocaleDateString() : '']
                .filter(Boolean).join(' · ')}
            </div>
            {m.podium && m.podium.length > 0 && (
              <ol className="mt-3 grid grid-cols-1 gap-1 text-sm sm:grid-cols-3">
                {m.podium.map((p) => (
                  <li key={p.kart_no} className="flex min-w-0 items-center gap-2 rounded-lg bg-pit-850 px-2.5 py-1.5">
                    <span className="timing font-extrabold text-race-red">P{p.position}</span>
                    <span className="timing text-ink-500">#{p.kart_no}</span>
                    <span className="truncate text-ink-100">{p.name}</span>
                  </li>
                ))}
              </ol>
            )}
          </Link>
        ))}
      </main>
    </Page>
  )
}
