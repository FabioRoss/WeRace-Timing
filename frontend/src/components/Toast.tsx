import { useCallback, useEffect, useState } from 'react'
import { useT } from '../lib/i18n'

export interface ToastItem {
  id: string
  kind: 'message' | 'warning' | 'penalty'
  title: string
  text: string
  urgent?: boolean          // persists until dismissed instead of auto-hiding
}

const KIND_STYLES: Record<ToastItem['kind'], string> = {
  message: 'bg-race-blue text-white',
  warning: 'bg-race-yellow text-pit-950',
  penalty: 'bg-race-red text-white',
}

/** Transient toast queue. `push` adds one; the stack caps + auto-dismisses. */
export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const dismiss = useCallback((id: string) => {
    setToasts((cur) => cur.filter((t) => t.id !== id))
  }, [])
  const push = useCallback((t: Omit<ToastItem, 'id'>) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    setToasts((cur) => [...cur.slice(-3), { ...t, id }])   // keep at most 4
  }, [])
  return { toasts, push, dismiss }
}

/** Stacked pop-up notifications. Phones: above the bottom edge (thumb reach,
 *  and the title bar stays readable). Desktop: top-right corner. */
export function ToastStack({ toasts, onDismiss }: {
  toasts: ToastItem[]
  onDismiss: (id: string) => void
}) {
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col-reverse items-center gap-2 px-3 lg:bottom-auto lg:left-auto lg:top-3 lg:w-[26rem] lg:flex-col lg:items-end"
      style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
      aria-live="polite"
    >
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  )
}

function Toast({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
  const t = useT()
  useEffect(() => {
    if (toast.urgent) return
    const t = setTimeout(onDismiss, 7000)
    return () => clearTimeout(t)
  }, [toast.urgent, onDismiss])

  return (
    <div
      className={`rise-in pointer-events-auto w-full max-w-md rounded-xl px-4 py-3 shadow-2xl ring-1 ring-black/25 ${
        KIND_STYLES[toast.kind]
      } ${toast.urgent ? 'msg-flash' : ''}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[0.6rem] font-bold uppercase tracking-[0.2em] opacity-80">
            {toast.title}
          </div>
          <p className="text-sm font-semibold leading-snug">{toast.text}</p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="-my-1 -mr-1 shrink-0 rounded-lg px-2 text-xl leading-none opacity-70 hover:opacity-100"
          aria-label={t('Dismiss')}
        >
          ×
        </button>
      </div>
    </div>
  )
}
