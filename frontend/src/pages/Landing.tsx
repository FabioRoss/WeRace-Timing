import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { LangSwitch, useT } from '../lib/i18n'

interface SlotInfo {
  slot: number
  connected: boolean
  label: string
  event_name: string
  track_name: string
}

export function Landing() {
  const t = useT()
  const [slots, setSlots] = useState<SlotInfo[]>([])

  useEffect(() => {
    api<{ slots: SlotInfo[] }>('/api/slots')
      .then((r) => setSlots(r.slots))
      .catch(() => setSlots([1, 2, 3].map((slot) => ({
        slot, connected: false, label: '', event_name: '', track_name: '',
      }))))
  }, [])

  return (
    <div className="mx-auto flex h-full max-w-lg flex-col justify-center gap-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-extrabold uppercase tracking-widest">WeRace Bridge</h1>
          <p className="mt-1 text-sm text-ink-500">{t('Live timing relay & team dashboards')}</p>
        </div>
        <LangSwitch />
      </div>
      <div className="space-y-3">
        {slots.map((s) => (
          <Link
            key={s.slot}
            to={`/e/${s.slot}`}
            className="flex items-center justify-between rounded-xl bg-pit-850 px-5 py-4 ring-1 ring-pit-700 hover:ring-race-blue"
          >
            <div>
              <div className="font-bold uppercase tracking-wider">{t('Event {slot}', { slot: s.slot })}</div>
              <div className="text-xs text-ink-500">
                {s.connected
                  ? s.event_name || s.track_name || s.label || t('Live')
                  : t('No session')}
              </div>
            </div>
            <span
              className={`h-2.5 w-2.5 rounded-full ${s.connected ? 'bg-race-green' : 'bg-pit-600'}`}
            />
          </Link>
        ))}
      </div>
      <Link
        to="/results"
        className="flex items-center justify-between rounded-xl bg-pit-900 px-5 py-3 ring-1 ring-pit-700 hover:ring-race-red"
      >
        <div className="font-bold uppercase tracking-wider">{t('Past results')}</div>
        <span className="text-xs text-ink-500">{t('Published sessions →')}</span>
      </Link>
      <p className="text-center text-xs text-ink-500">
        {t('Drivers and team managers: use the link or QR code handed out by the staff.')}
      </p>
    </div>
  )
}
