import { useCallback, useRef, useState } from 'react'

export type ToastKind = 'error' | 'warning' | 'success' | 'info'

export interface Toast {
  id: number
  kind: ToastKind
  text: string
}

const TOAST_TIMEOUT_MS = 6000
const MAX_TOASTS = 5

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const push = useCallback((kind: ToastKind, text: string) => {
    const id = nextId.current++
    setToasts((prev) => [...prev.slice(-(MAX_TOASTS - 1)), { id, kind, text }])
    setTimeout(() => dismiss(id), TOAST_TIMEOUT_MS)
  }, [dismiss])

  return { toasts, push, dismiss }
}

const KIND_STYLES: Record<ToastKind, string> = {
  error: 'ring-race-red text-race-red',
  warning: 'ring-race-yellow text-race-yellow',
  success: 'ring-race-green text-race-green',
  info: 'ring-race-blue text-ink-100',
}

export function ToastStack({ toasts, dismiss }: {
  toasts: Toast[]
  dismiss: (id: number) => void
}) {
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 max-w-[90vw] flex-col gap-2">
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => dismiss(t.id)}
          className={`pointer-events-auto rounded-lg bg-pit-900 px-4 py-3 text-left text-sm shadow-lg ring-1 ${KIND_STYLES[t.kind]}`}
        >
          {t.text}
        </button>
      ))}
    </div>
  )
}
