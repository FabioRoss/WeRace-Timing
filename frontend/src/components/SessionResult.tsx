import { useMemo, useState } from 'react'
import { TimingTable } from './TimingTable'
import { PenaltyLog } from './PenaltyLog'
import { OrderToggle, useOrderMode } from './OrderToggle'
import { SnapshotLapCharts } from './SnapshotLapCharts'
import { penaltyAdjustedDrivers } from '../lib/penalties'
import type { SnapshotRecord } from '../lib/useSnapshot'
import { useT } from '../lib/i18n'
import { Panel } from './ui'

/**
 * The public read-only body for one saved session: public notes, the
 * classification (no track ring), penalties, lap-time charts, and the PDF
 * download. Shared by the single results page and each tab of an event, so both
 * surface the same full saved data.
 */
export function SessionResult({ record, baseUrl }: { record: SnapshotRecord; baseUrl: string }) {
  const t = useT()
  const snapshot = record.snapshot
  const race = snapshot.race
  const isRace = race?.session_kind === 'race'
  const [orderMode, setOrderMode] = useOrderMode()
  const pdfUrl = useMemo(() => `${baseUrl}/timesheet.pdf?t=${Date.now()}`, [baseUrl])
  const [downloading, setDownloading] = useState(false)

  // The public result is the FINAL classification: when there are outstanding
  // penalties/adjustments, show the standings recomputed with them applied
  // (same fold as the PDF). No applicable ones → the recorded order, untouched.
  const finalSnapshot = useMemo(() => {
    const applicable = (snapshot.penalties ?? []).some((p) => p.kind !== 'warning' && !p.served)
    return applicable ? { ...snapshot, drivers: penaltyAdjustedDrivers(snapshot) } : snapshot
  }, [snapshot])

  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:gap-4">
      {record.public_notes && (
        <div className="rounded-2xl bg-race-blue/10 px-4 py-3 text-sm text-ink-100 ring-1 ring-race-blue/30">
          {record.public_notes}
        </div>
      )}

      <Panel
        title={t('Classification')}
        actions={isRace ? <OrderToggle mode={orderMode} onChange={setOrderMode} /> : undefined}
        bodyClass=""
      >
        <TimingTable
          snapshot={finalSnapshot}
          orderMode={isRace ? orderMode : 'race'}
          ring={false}
          progress={false}
          lapsBase={baseUrl}
          teamStoryConfig={record.team_story_config}
        />
      </Panel>

      {snapshot.penalties.length > 0 && (
        <Panel title={t('Penalties & warnings')}>
          <PenaltyLog penalties={snapshot.penalties} />
        </Panel>
      )}

      <SnapshotLapCharts baseUrl={baseUrl} drivers={snapshot.drivers} />

      <div>
        <a
          href={pdfUrl}
          onClick={() => { setDownloading(true); setTimeout(() => setDownloading(false), 1500) }}
          className="btn btn-danger w-full sm:w-auto"
        >
          {downloading ? t('Preparing…') : t('Download PDF timesheet')}
        </a>
      </div>
    </div>
  )
}
