import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { SafewordGate } from '../components/SafewordGate'
import { ConnectionDot, PageHeader } from '../components/StatusBar'
import { PageNav } from '../components/PageNav'
import { StoryStudio } from '../components/StoryStudio'
import { TimesheetPanel } from '../components/TimesheetPanel'
import { useLive } from '../lib/useLive'

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
            pdfBase={`/e/${slot}/api/export`}
            eventName={race?.event_name ?? ''}
            trackName={race?.track_name ?? ''}
            runType={race?.run_type ?? ''}
            autoPitlane={snapshot?.auto_pitlane ?? true}
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
