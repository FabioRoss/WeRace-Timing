import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { PageHeader } from '../components/StatusBar'
import type { SnapshotRecord } from '../lib/useSnapshot'

type Meta = Omit<SnapshotRecord, 'snapshot'>

export function ResultsIndex() {
  const [items, setItems] = useState<Meta[]>([])
  const [track, setTrack] = useState('')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    void api<{ results: Meta[] }>('/api/results')
      .then((r) => setItems(r.results))
      .catch(() => setItems([]))
      .finally(() => setLoaded(true))
  }, [])

  const tracks = useMemo(
    () => [...new Set(items.map((i) => i.track).filter(Boolean))].sort(),
    [items],
  )
  const shown = track ? items.filter((i) => i.track === track) : items

  return (
    <div className="mx-auto flex min-h-full max-w-4xl flex-col">
      <PageHeader title="Results" subtitle="Published sessions" />
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
        {loaded && shown.length === 0 && (
          <p className="text-sm text-ink-500">No published results yet.</p>
        )}
        {shown.map((m) => (
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
