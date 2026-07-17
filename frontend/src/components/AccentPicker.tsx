import { useT } from '../lib/i18n'

export const DEFAULT_ACCENT = '#e10600'

const PRESETS = [
  { name: 'Red', hex: '#e10600' },
  { name: 'Neon green', hex: '#39ff14' },
  { name: 'Yellow', hex: '#ffd21f' },
  { name: 'Purple', hex: '#b569f0' },
  { name: 'Blue', hex: '#3987e5' },
  { name: 'Orange', hex: '#ff7a1a' },
] as const

/** Accent colour chooser: six brand presets + a free colour picker. */
export function AccentPicker({
  value,
  onChange,
}: {
  value: string
  onChange: (hex: string) => void
}) {
  const t = useT()
  const current = value.toLowerCase()
  return (
    <div className="flex flex-wrap items-center gap-2">
      {PRESETS.map((p) => (
        <button
          key={p.hex}
          type="button"
          title={t(p.name)}
          onClick={() => onChange(p.hex)}
          className={`h-7 w-7 rounded-full ring-2 ring-offset-2 ring-offset-pit-900 ${
            current === p.hex ? 'ring-ink-100' : 'ring-transparent hover:ring-pit-600'
          }`}
          style={{ backgroundColor: p.hex }}
        />
      ))}
      <label
        title={t('Custom colour')}
        className="relative inline-flex h-7 w-7 items-center justify-center overflow-hidden rounded-full text-sm font-bold text-ink-100 ring-1 ring-pit-600"
        style={{ backgroundColor: PRESETS.some((p) => p.hex === current) ? undefined : value }}
      >
        {PRESETS.some((p) => p.hex === current) ? '+' : ''}
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </label>
    </div>
  )
}
