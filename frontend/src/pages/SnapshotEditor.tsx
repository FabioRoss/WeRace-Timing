import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, getSafeword } from '../lib/api'
import { SafewordGate } from '../components/SafewordGate'
import { PageHeader } from '../components/StatusBar'
import { PageNav } from '../components/PageNav'
import { TimingTable } from '../components/TimingTable'
import { PenaltyEditor } from '../components/PenaltyEditor'
import { TimesheetPanel } from '../components/TimesheetPanel'
import { StoryStudio } from '../components/StoryStudio'
import { useSnapshotRecord } from '../lib/useSnapshot'

type Tab = 'result' | 'pdf' | 'story'

export function SnapshotEditor() {
  return (
    <SafewordGate>
      <EditorInner />
    </SafewordGate>
  )
}

function EditorInner() {
  const { id = '' } = useParams()
  const url = `/api/admin/snapshots/${id}`
  const { record, error, loading, refetch } = useSnapshotRecord(url, true)
  const [tab, setTab] = useState<Tab>('result')

  const snapshot = record?.snapshot ?? null
  const race = snapshot?.race
  const fastest = useMemo(() => {
    if (!snapshot?.session_best_ms) return null
    return { ms: snapshot.session_best_ms, kart: snapshot.session_best_kart }
  }, [snapshot])
  const leader = snapshot?.drivers?.[0]

  if (loading) return <p className="p-6 text-ink-500">Loading…</p>
  if (error || !record || !snapshot) {
    return (
      <div className="p-6">
        <p className="text-race-red">{error || 'Snapshot not found.'}</p>
        <Link to="/admin/snapshots" className="text-race-blue">← Back to snapshots</Link>
      </div>
    )
  }

  return (
    <div className="mx-auto flex min-h-full max-w-5xl flex-col">
      <PageHeader
        title={record.name || record.id}
        subtitle={[record.track, `${record.driver_count ?? snapshot.drivers.length} karts`].filter(Boolean).join(' · ')}
        nav={<PageNav slot={String(record.slot ?? 1)} />}
      />
      <main className="flex-1 space-y-4 p-4">
        <Link to="/admin/snapshots" className="text-xs text-race-blue">← All snapshots</Link>

        <DetailsCard record={record} url={url} onSaved={refetch} />

        <div className="flex gap-2">
          {(['result', 'pdf', 'story'] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)}
              className={`rounded px-3 py-1.5 text-xs font-bold uppercase tracking-wider ${
                tab === t ? 'bg-race-red text-white' : 'bg-pit-800 text-ink-300 hover:bg-pit-700'
              }`}>
              {t === 'result' ? 'Result & penalties' : t === 'pdf' ? 'PDF' : 'Instagram story'}
            </button>
          ))}
        </div>

        {tab === 'result' && (
          <>
            <div className="rounded-xl bg-pit-900 ring-1 ring-pit-800">
              <TimingTable snapshot={snapshot} ring={false} />
            </div>
            <div className="rounded-xl bg-pit-900 p-4 ring-1 ring-pit-800">
              <h3 className="label-race mb-3">Penalties &amp; warnings</h3>
              <PenaltyEditor
                apiBase={url}
                drivers={snapshot.drivers}
                penalties={snapshot.penalties}
                onChanged={refetch}
                canRevert
              />
            </div>
          </>
        )}
        {tab === 'pdf' && (
          <TimesheetPanel
            pdfBase={url}
            safeword={getSafeword()}
            eventName={race?.event_name ?? ''}
            trackName={race?.track_name ?? ''}
            runType={race?.run_type ?? ''}
            autoPitlane={snapshot.auto_pitlane}
            kartCount={snapshot.drivers.length}
            leaderName={leader?.name ?? ''}
            leaderKart={leader?.kart_no ?? ''}
            fastest={fastest}
            initialConfig={record.pdf_config}
            onSaveConfig={(pdf_config) =>
              api(url, { method: 'PATCH', body: { pdf_config }, safeword: true }).then(refetch)
            }
          />
        )}
        {tab === 'story' && <StoryStudio snapshot={snapshot} />}
      </main>
    </div>
  )
}

function DetailsCard({ record, url, onSaved }: {
  record: { name: string; track: string; private_notes?: string; public_notes?: string; keep: boolean; published: boolean }
  url: string
  onSaved: () => void
}) {
  const [name, setName] = useState(record.name)
  const [track, setTrack] = useState(record.track)
  const [priv, setPriv] = useState(record.private_notes ?? '')
  const [pub, setPub] = useState(record.public_notes ?? '')
  const [saved, setSaved] = useState('')
  // Reseed when the record reloads (e.g. after a penalty edit refetch).
  useEffect(() => {
    setName(record.name); setTrack(record.track)
    setPriv(record.private_notes ?? ''); setPub(record.public_notes ?? '')
  }, [record.name, record.track, record.private_notes, record.public_notes])

  const patch = (body: Record<string, unknown>) =>
    api(url, { method: 'PATCH', body, safeword: true }).then(onSaved)

  const save = () => {
    void patch({ name: name.trim(), track: track.trim(), private_notes: priv, public_notes: pub })
      .then(() => { setSaved('Saved ✓'); setTimeout(() => setSaved(''), 2500) })
  }

  return (
    <div className="rounded-xl bg-pit-900 p-4 ring-1 ring-pit-800">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="label-race">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120}
            className="mt-1 w-full rounded bg-pit-950 px-3 py-2 text-sm ring-1 ring-pit-600 focus:ring-race-red" />
        </label>
        <label className="block">
          <span className="label-race">Track</span>
          <input value={track} onChange={(e) => setTrack(e.target.value)} maxLength={120}
            className="mt-1 w-full rounded bg-pit-950 px-3 py-2 text-sm ring-1 ring-pit-600 focus:ring-race-red" />
        </label>
        <label className="block">
          <span className="label-race">Private notes (staff only)</span>
          <textarea value={priv} onChange={(e) => setPriv(e.target.value)} rows={2} maxLength={5000}
            className="mt-1 w-full rounded bg-pit-950 px-3 py-2 text-sm ring-1 ring-pit-600 focus:ring-race-red" />
        </label>
        <label className="block">
          <span className="label-race">Public notes (shown on the results page)</span>
          <textarea value={pub} onChange={(e) => setPub(e.target.value)} rows={2} maxLength={5000}
            className="mt-1 w-full rounded bg-pit-950 px-3 py-2 text-sm ring-1 ring-pit-600 focus:ring-race-red" />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={save}
          className="rounded bg-race-red px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-white hover:brightness-110">
          Save details
        </button>
        <button type="button" onClick={() => void patch({ published: !record.published })}
          className={`rounded px-3 py-1.5 text-xs font-bold uppercase ${
            record.published ? 'bg-race-green text-pit-950' : 'bg-pit-700 hover:bg-pit-600'
          }`}>
          {record.published ? 'Published — click to unpublish' : 'Publish'}
        </button>
        <button type="button" onClick={() => void patch({ keep: !record.keep })}
          className={`rounded px-3 py-1.5 text-xs font-bold uppercase ${
            record.keep ? 'bg-race-blue text-white' : 'bg-pit-700 hover:bg-pit-600'
          }`}>
          {record.keep ? 'Kept forever' : 'Keep forever'}
        </button>
        {saved && <span className="text-xs text-race-green">{saved}</span>}
      </div>
    </div>
  )
}
