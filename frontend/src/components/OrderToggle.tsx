import { useState } from 'react'

export type OrderMode = 'race' | 'laptime'

const KEY = 'wrb_order_mode'

/** Per-viewer standings ordering, persisted in the browser. */
export function useOrderMode(): [OrderMode, (m: OrderMode) => void] {
  const [mode, setMode] = useState<OrderMode>(() =>
    localStorage.getItem(KEY) === 'laptime' ? 'laptime' : 'race',
  )
  const update = (m: OrderMode) => {
    localStorage.setItem(KEY, m)
    setMode(m)
  }
  return [mode, update]
}

export function OrderToggle({ mode, onChange }: {
  mode: OrderMode
  onChange: (m: OrderMode) => void
}) {
  const seg = (value: OrderMode, label: string) => (
    <button
      type="button"
      onClick={() => onChange(value)}
      className={`rounded-full px-3 py-1 text-xs font-bold uppercase ${
        mode === value ? 'bg-race-blue' : 'bg-pit-700 hover:bg-pit-600'
      }`}
    >
      {label}
    </button>
  )
  return (
    <div className="flex items-center gap-1.5">
      <span className="label-race mr-1">Order</span>
      {seg('race', 'Race')}
      {seg('laptime', 'Lap times')}
    </div>
  )
}
