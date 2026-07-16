import { useCallback, useEffect, useState } from 'react'

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

/** Stacked pop-up notifications, centred at the top over the dashboard. */
export function ToastStack({ toasts, onDismiss }: {
  toasts: ToastItem[]
  onDismiss: (id: string) => void
}) {
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-50 flex flex-col items-center gap-2 px-3">
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  )
}

function Toast({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
  useEffect(() => {
    if (toast.urgent) return
    const t = setTimeout(onDismiss, 7000)
    return () => clearTimeout(t)
  }, [toast.urgent, onDismiss])

  return (
    <div
      className={`pointer-events-auto w-full max-w-md rounded-lg px-4 py-3 shadow-2xl ring-1 ring-black/25 ${
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
          className="shrink-0 text-xl leading-none opacity-70 hover:opacity-100"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  )
}
