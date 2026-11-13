import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { SafewordGate } from '../components/SafewordGate'
import { ConnectionDot, PageHeader } from '../components/StatusBar'
import { PageNav } from '../components/PageNav'
import { Page, Tabs } from '../components/ui'
import { StoryStudio } from '../components/StoryStudio'
import { TeamStoryStudio } from '../components/TeamStoryStudio'
import { TimesheetPanel } from '../components/TimesheetPanel'
import { useLive } from '../lib/useLive'
import { api } from '../lib/api'
import type { TeamStoryConfig } from '../lib/teamStoryRender'
import { useT } from '../lib/i18n'

export function ExportPage() {
  return (
    <SafewordGate>
      <ExportInner />
    </SafewordGate>
  )
}

type Tab = 'timesheet' | 'story' | 'teamstory'

const TAB_LABELS: Record<Tab, string> = {
  timesheet: 'PDF timesheet',
  story: 'Instagram story',
  teamstory: 'Team story',
}

function ExportInner() {
  const t = useT()
  const { slot = '1' } = useParams()
  const { snapshot, status } = useLive(slot, { staff: true })
  const [tab, setTab] = useState<Tab>('timesheet')

  const race = snapshot?.race
  const drivers = snapshot?.drivers ?? []
  const leader = drivers[0]
  const fastest = useMemo(() => {
    if (!snapshot?.session_best_ms) return null
    return { ms: snapshot.session_best_ms, kart: snapshot.session_best_kart }
  }, [snapshot])

  return (
    <Page width="max-w-5xl" className="pb-8">
      <PageHeader
        title={t('Export — Event {slot}', { slot })}
        subtitle={[race?.event_name, race?.track_name].filter(Boolean).join(' · ')}
        nav={<PageNav slot={slot} />}
        right={<ConnectionDot status={status} />}
      />

      <Tabs<typeof tab>
        value={tab}
        onChange={setTab}
        tabs={(['timesheet', 'story', 'teamstory'] as const).map((id) => ({ id, label: t(TAB_LABELS[id]) }))}
      />

      {race && !race.ended && (
        <div className="mx-3 mt-3 rounded-xl bg-race-yellow/10 px-3 py-2 text-sm text-race-yellow ring-1 ring-race-yellow/30 sm:mx-4">
          {t('Session still live — an export reflects the current standings, not a final result.')}
        </div>
      )}

      <main className="flex-1 px-3 pt-3 sm:px-4 sm:pt-4">
        {tab === 'timesheet' && (
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
        )}
        {tab === 'story' && <StoryStudio snapshot={snapshot} />}
        {tab === 'teamstory' && (
          <TeamStoryStudio
            key={snapshot ? 'ready' : 'loading'}
            snapshot={snapshot}
            initialConfig={snapshot?.team_story_config as TeamStoryConfig | undefined}
            onSaveConfig={(config) =>
              api(`/e/${slot}/api/admin/settings`, {
                body: { team_story_config: config }, safeword: true,
              })
            }
          />
        )}
      </main>
    </Page>
  )
}
