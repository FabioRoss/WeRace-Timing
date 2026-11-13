import { useParams } from 'react-router-dom'
import { useLive } from '../lib/useLive'
import { OrderToggle, useOrderMode } from '../components/OrderToggle'
import { TimingTable } from '../components/TimingTable'
import { TrackRing } from '../components/TrackRing'
import { PageHeader, RaceStrip } from '../components/StatusBar'
import { PenaltyLog } from '../components/PenaltyLog'
import { Collapse, Page, Panel } from '../components/ui'
import { fmtLap } from '../lib/format'
import { fmtRemaining, useServerNow } from '../lib/lapProgress'
import { useT } from '../lib/i18n'

/**
 * Public live timing. Phones: standings first (that's what spectators came
 * for), the track map after. Desktop: standings beside the map. The penalties
 * panel eases in at the end of its column, so it never pushes anything around.
 */
export function GeneralDashboard() {
  const t = useT()
  const { slot = '1' } = useParams()
  const { snapshot, status } = useLive(slot)
  const [orderMode, setOrderMode] = useOrderMode()
  const serverNow = useServerNow(snapshot?.updated_at ?? 0, 1000)

  const race = snapshot?.race
  const isRace = race?.session_kind === 'race'
  const penalties = snapshot?.penalties ?? []

  return (
    <Page className="pb-8">
      <PageHeader
        title={race?.event_name || t('Event {slot} — Live Timing', { slot })}
        subtitle={[race?.track_name, race?.run_type].filter(Boolean).join(' · ')}
      />
      <RaceStrip
        flag={race?.flag ?? 'none'}
        remaining={race ? fmtRemaining(race, serverNow) : '--:--'}
        best={snapshot?.session_best_ms ? fmtLap(snapshot.session_best_ms) : undefined}
        bestKart={snapshot?.session_best_kart}
        status={status}
        extra={race?.race_time ? (
          <div className="hidden text-right sm:block">
            <div className="label-race leading-none">{t('Race time')}</div>
            <div className="timing font-bold leading-tight">{race.race_time}</div>
          </div>
        ) : undefined}
      />

      <div className="grid grid-cols-1 gap-3 px-3 pt-3 sm:gap-4 sm:px-4 sm:pt-4 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-8">
          <Panel
            title={t('Standings')}
            actions={isRace ? <OrderToggle mode={orderMode} onChange={setOrderMode} /> : undefined}
            bodyClass=""
          >
            {snapshot ? (
              <TimingTable snapshot={snapshot} ring={false} orderMode={isRace ? orderMode : 'race'} />
            ) : (
              <div className="p-10 text-center text-ink-500">{t('Connecting…')}</div>
            )}
          </Panel>
        </div>
        <div className="flex min-w-0 flex-col gap-3 sm:gap-4 lg:col-span-4">
          {snapshot && snapshot.drivers.length > 0 && (
            <Panel title={t('Track position')}>
              <TrackRing snapshot={snapshot} />
            </Panel>
          )}
          <Collapse open={penalties.length > 0}>
            <Panel title={t('Penalties & warnings')}>
              <PenaltyLog penalties={penalties} />
            </Panel>
          </Collapse>
        </div>
      </div>
    </Page>
  )
}
