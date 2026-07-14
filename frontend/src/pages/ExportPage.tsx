import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { SafewordGate } from '../components/SafewordGate'
import { ConnectionDot, PageHeader } from '../components/StatusBar'
import { PageNav } from '../components/PageNav'
import { StoryStudio } from '../components/StoryStudio'
import { useLive } from '../lib/useLive'
import { fmtLap } from '../lib/format'

export function ExportPage() {
  return (
    <SafewordGate>
      <ExportInner />
    </SafewordGate>
  )
}

type Tab = 'timesheet' | 'story'

function ExportInner() {
  const { slot = '1' } = useParams()
  const { snapshot, status } = useLive(slot)
  const [tab, setTab] = useState<Tab>('timesheet')

  const race = snapshot?.race
  const drivers = snapshot?.drivers ?? []
  const leader = drivers[0]
  const fastest = useMemo(() => {
    if (!snapshot?.session_best_ms) return null
    return { ms: snapshot.session_best_ms, kart: snapshot.session_best_kart }
  }, [snapshot])

  return (
    <div className="mx-auto flex min-h-full max-w-5xl flex-col">
      <PageHeader
        title={`Export — Event ${slot}`}
        subtitle={[race?.event_name, race?.track_name].filter(Boolean).join(' · ')}
        nav={<PageNav slot={slot} />}
        right={<ConnectionDot status={status} />}
      />

      {race && !race.ended && (
        <div className="mx-4 mt-4 rounded-lg bg-race-yellow/10 px-3 py-2 text-sm text-race-yellow ring-1 ring-race-yellow/30">
          Session still live — an export reflects the current standings, not a final result.
        </div>
      )}

      <div className="flex gap-2 px-4 pt-4">
        {(['timesheet', 'story'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded px-3 py-1.5 text-xs font-bold uppercase tracking-wider ${
              tab === t ? 'bg-race-red text-white' : 'bg-pit-800 text-ink-300 hover:bg-pit-700'
            }`}
          >
            {t === 'timesheet' ? 'PDF timesheet' : 'Instagram story'}
          </button>
        ))}
      </div>

      <main className="flex-1 p-4">
        {tab === 'timesheet' ? (
          <TimesheetPanel
            slot={slot}
            eventName={race?.event_name ?? ''}
            trackName={race?.track_name ?? ''}
            kartCount={drivers.length}
            leaderName={leader?.name ?? ''}
            leaderKart={leader?.kart_no ?? ''}
            fastest={fastest}
          />
        ) : (
          <StoryStudio snapshot={snapshot} />
        )}
      </main>
    </div>
  )
}

function TimesheetPanel({
  slot,
  eventName,
  trackName,
  kartCount,
  leaderName,
  leaderKart,
  fastest,
}: {
  slot: string
  eventName: string
  trackName: string
  kartCount: number
  leaderName: string
  leaderKart: string
  fastest: { ms: number; kart: string } | null
}) {
  const href = `/e/${slot}/api/export/timesheet.pdf`
  return (
    <div className="max-w-2xl space-y-4">
      <div className="rounded-xl bg-pit-900 p-5 ring-1 ring-pit-800">
        <h2 className="text-sm font-bold uppercase tracking-wider text-ink-300">
          Chrono timesheet (PDF)
        </h2>
        <p className="mt-1 text-sm text-ink-500">
          Full classification plus a lap-by-lap grid for every kart and summary charts —
          the print-style sheet you'd hand out after the race.
        </p>

        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <Summary label="Event" value={eventName || '—'} />
          <Summary label="Track" value={trackName || '—'} />
          <Summary label="Karts" value={kartCount ? String(kartCount) : '—'} />
          <Summary label="Leader" value={leaderName ? `#${leaderKart} ${leaderName}` : '—'} />
          <Summary
            label="Fastest lap"
            value={fastest ? `${fmtLap(fastest.ms)} (#${fastest.kart})` : '—'}
          />
        </dl>

        <a
          href={href}
          className="mt-5 inline-block rounded bg-race-red px-4 py-2 text-sm font-bold uppercase tracking-wider text-white hover:brightness-110"
        >
          Download PDF
        </a>
        {!kartCount && (
          <p className="mt-3 text-xs text-ink-500">
            No timing data yet — connect a source (or replay a recording) first.
          </p>
        )}
      </div>
    </div>
  )
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="label-race">{label}</dt>
      <dd className="truncate">{value}</dd>
    </div>
  )
}
