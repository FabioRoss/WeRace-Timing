// Remembers the last staff slot the operator was on, so the shared PageNav on
// slot-less admin pages (Snapshots) links back to that slot instead of always 1.
const KEY = 'wrb_last_slot'

export function rememberSlot(slot: string | number): void {
  const s = String(slot)
  if (s && s !== 'undefined' && s !== 'null') localStorage.setItem(KEY, s)
}

export function rememberedSlot(): string {
  return localStorage.getItem(KEY) || '1'
}
