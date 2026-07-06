import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'

interface SlotInfo {
  slot: number
  connected: boolean
  label: string
  event_name: string
  track_name: string
}

export function Landing() {
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
      <div>
        <div className="checker mb-4 h-3 w-full rounded-sm" />
        <h1 className="text-3xl font-extrabold uppercase tracking-widest">WeRace Bridge</h1>
        <p className="mt-1 text-sm text-ink-500">Live timing relay &amp; team dashboards</p>
      </div>
      <div className="space-y-3">
        {slots.map((s) => (
          <Link
            key={s.slot}
            to={`/e/${s.slot}`}
            className="flex items-center justify-between rounded-xl bg-pit-850 px-5 py-4 ring-1 ring-pit-700 hover:ring-race-blue"
          >
            <div>
              <div className="font-bold uppercase tracking-wider">Event {s.slot}</div>
              <div className="text-xs text-ink-500">
                {s.connected
                  ? s.event_name || s.track_name || s.label || 'Live'
                  : 'No session'}
              </div>
            </div>
            <span
              className={`h-2.5 w-2.5 rounded-full ${s.connected ? 'bg-race-green' : 'bg-pit-600'}`}
            />
          </Link>
        ))}
      </div>
      <p className="text-center text-xs text-ink-500">
        Drivers and team managers: use the link or QR code handed out by the staff.
      </p>
    </div>
  )
}
