import { useState } from 'react'
import { Segmented } from './ui'
import { useT } from '../lib/i18n'

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
  const t = useT()
  return (
    <Segmented
      label={t('Order')}
      size="sm"
      value={mode}
      onChange={onChange}
      options={[{ value: 'race', label: t('Default') }, { value: 'laptime', label: t('Best lap') }]}
    />
  )
}
