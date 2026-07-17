import { useParams } from 'react-router-dom'
import { useLive } from '../lib/useLive'
import { FlagBanner } from '../components/FlagBanner'
import { OrderToggle, useOrderMode } from '../components/OrderToggle'
import { TimingTable } from '../components/TimingTable'
import { ConnectionDot, PageHeader } from '../components/StatusBar'
import { PenaltyLog } from '../components/PenaltyLog'
import { fmtLap } from '../lib/format'
import { fmtRemaining, useServerNow } from '../lib/lapProgress'
import { useT } from '../lib/i18n'

export function GeneralDashboard() {
  const t = useT()
  const { slot = '1' } = useParams()
  const { snapshot, status } = useLive(slot)
  const [orderMode, setOrderMode] = useOrderMode()
  const serverNow = useServerNow(snapshot?.updated_at ?? 0, 1000)

  const race = snapshot?.race
  return (
    <div className="mx-auto flex min-h-full max-w-5xl flex-col">
      <PageHeader
        title={race?.event_name || t('Event {slot} — Live Timing', { slot })}
        subtitle={[race?.track_name, race?.run_type].filter(Boolean).join(' · ')}
        right={<ConnectionDot status={status} />}
      />
      <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4">
        <div className="rounded-lg bg-pit-850 p-3">
          <div className="label-race">{t('Time remaining')}</div>
          <div className="timing text-2xl font-bold">
            {race ? fmtRemaining(race, serverNow) : '--:--'}
          </div>
        </div>
        <div className="rounded-lg bg-pit-850 p-3">
          <div className="label-race">{t('Race time')}</div>
          <div className="timing text-2xl font-bold">{race?.race_time || '--:--'}</div>
        </div>
        <div className="rounded-lg bg-pit-850 p-3">
          <div className="label-race">{t('Session best')}</div>
          <div className="timing text-2xl font-bold text-race-purple">
            {fmtLap(snapshot?.session_best_ms)}
            {snapshot?.session_best_kart && (
              <span className="ml-2 text-sm text-ink-500">#{snapshot.session_best_kart}</span>
            )}
          </div>
        </div>
        <div className="flex items-center">
          <div className="w-full">
            <FlagBanner flag={race?.flag ?? 'none'} />
          </div>
        </div>
      </div>
      <main className="flex-1 px-4 pb-8">
        {race?.session_kind === 'race' && (
          <div className="mb-2 flex justify-end">
            <OrderToggle mode={orderMode} onChange={setOrderMode} />
          </div>
        )}
        <div className="rounded-xl bg-pit-900 ring-1 ring-pit-800">
          {snapshot ? (
            <TimingTable
              snapshot={snapshot}
              orderMode={race?.session_kind === 'race' ? orderMode : 'race'}
            />
          ) : (
            <div className="p-10 text-center text-ink-500">{t('Connecting…')}</div>
          )}
        </div>
        {snapshot && snapshot.penalties.length > 0 && (
          <div className="mt-4 rounded-xl bg-pit-900 p-4 ring-1 ring-pit-800">
            <h3 className="label-race mb-3">{t('Penalties & warnings')}</h3>
            <PenaltyLog penalties={snapshot.penalties} />
          </div>
        )}
      </main>
    </div>
  )
}
