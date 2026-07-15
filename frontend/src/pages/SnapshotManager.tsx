import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { SafewordGate } from '../components/SafewordGate'
import { PageHeader } from '../components/StatusBar'
import { PageNav } from '../components/PageNav'
import type { SnapshotRecord } from '../lib/useSnapshot'

type Meta = Omit<SnapshotRecord, 'snapshot'>

export function SnapshotManager() {
  return (
    <SafewordGate>
      <ManagerInner />
    </SafewordGate>
  )
}

function ManagerInner() {
  const [items, setItems] = useState<Meta[]>([])
  const [error, setError] = useState('')
  const [track, setTrack] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await api<{ snapshots: Meta[] }>('/api/admin/snapshots', { safeword: true })
      setItems(r.snapshots)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const tracks = useMemo(
    () => [...new Set(items.map((i) => i.track).filter(Boolean))].sort(),
    [items],
  )
  const shown = track ? items.filter((i) => i.track === track) : items

  const patch = (id: string, body: Record<string, unknown>) =>
    api(`/api/admin/snapshots/${id}`, { method: 'PATCH', body, safeword: true }).then(load)

  const remove = (m: Meta) => {
    if (!window.confirm(`Delete snapshot “${m.name}”? This cannot be undone.`)) return
    void api(`/api/admin/snapshots/${m.id}`, { method: 'DELETE', safeword: true }).then(load)
  }

  return (
    <div className="mx-auto flex min-h-full max-w-5xl flex-col">
      <PageHeader title="Saved snapshots" subtitle="Results archive" nav={<PageNav slot="1" />} />
      <main className="flex-1 space-y-3 p-4">
        {error && <p className="text-sm text-race-red">{error}</p>}
        {tracks.length > 1 && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="label-race text-ink-500">Track</span>
            <button type="button" onClick={() => setTrack('')}
              className={`rounded-full px-3 py-1 text-xs ${!track ? 'bg-race-blue' : 'bg-pit-700'}`}>
              All
            </button>
            {tracks.map((t) => (
              <button key={t} type="button" onClick={() => setTrack(t)}
                className={`rounded-full px-3 py-1 text-xs ${track === t ? 'bg-race-blue' : 'bg-pit-700'}`}>
                {t}
              </button>
            ))}
          </div>
        )}
        {shown.length === 0 && (
          <p className="text-sm text-ink-500">
            No snapshots yet. They are auto-saved when a session ends, or from “Save snapshot” in Race Control.
          </p>
        )}
        {shown.map((m) => (
          <SnapshotCard key={m.id} m={m}
            onKeep={(v) => patch(m.id, { keep: v })}
            onPublish={(v) => patch(m.id, { published: v })}
            onDelete={() => remove(m)} />
        ))}
      </main>
    </div>
  )
}

function SnapshotCard({ m, onKeep, onPublish, onDelete }: {
  m: Meta
  onKeep: (v: boolean) => void
  onPublish: (v: boolean) => void
  onDelete: () => void
}) {
  const created = m.created_at ? new Date(m.created_at * 1000).toLocaleString() : '—'
  const daysLeft = m.expires_at
    ? Math.max(0, Math.ceil((m.expires_at - Date.now() / 1000) / 86400))
    : null
  return (
    <div className="rounded-xl bg-pit-900 p-4 ring-1 ring-pit-800">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to={`/admin/snapshots/${m.id}`} className="font-bold hover:text-race-red">
            {m.name || m.id}
          </Link>
          <div className="mt-0.5 text-xs text-ink-500">
            {[m.track, `${m.driver_count ?? 0} karts`, created].filter(Boolean).join(' · ')}
          </div>
          {m.podium && m.podium.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-2 text-xs">
              {m.podium.map((p) => (
                <span key={p.kart_no} className="text-ink-300">
                  <span className="font-bold text-race-red">P{p.position}</span> #{p.kart_no} {p.name}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {m.published && <Badge className="bg-race-green text-pit-950">PUBLISHED</Badge>}
          {m.keep ? (
            <Badge className="bg-race-blue text-white">KEPT</Badge>
          ) : daysLeft != null && (
            <Badge className="bg-pit-700 text-ink-300">{daysLeft}d left</Badge>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link to={`/admin/snapshots/${m.id}`}
          className="rounded bg-pit-700 px-3 py-1 text-xs font-bold uppercase hover:bg-pit-600">
          Open
        </Link>
        <button type="button" onClick={() => onPublish(!m.published)}
          className="rounded bg-pit-700 px-3 py-1 text-xs font-bold uppercase hover:bg-pit-600">
          {m.published ? 'Unpublish' : 'Publish'}
        </button>
        <button type="button" onClick={() => onKeep(!m.keep)}
          className="rounded bg-pit-700 px-3 py-1 text-xs font-bold uppercase hover:bg-pit-600">
          {m.keep ? 'Stop keeping' : 'Keep forever'}
        </button>
        <button type="button" onClick={onDelete}
          className="rounded bg-pit-700 px-3 py-1 text-xs font-bold uppercase text-race-red hover:bg-pit-600">
          Delete
        </button>
      </div>
    </div>
  )
}

function Badge({ children, className }: { children: React.ReactNode; className: string }) {
  return <span className={`rounded px-1.5 py-0.5 text-[0.6rem] font-bold ${className}`}>{children}</span>
}
