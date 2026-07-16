import { useEffect, useState } from 'react'
import type { RaceMessage } from '../lib/types'

const PRIORITY_STYLES: Record<RaceMessage['priority'], string> = {
  info: 'bg-race-blue text-white',
  warning: 'bg-race-yellow text-pit-950',
  urgent: 'bg-race-red text-white msg-flash',
}

const SENDER_LABEL: Record<RaceMessage['sender'], string> = {
  race_control: 'RACE CONTROL',
  team_manager: 'PIT WALL',
}

/**
 * Fullscreen message banner for the driver dashboard. Shows the newest
 * message; auto-dismisses info messages, urgent ones require a tap.
 */
export function MessageOverlay({ message, onDismiss }: {
  message: RaceMessage | null
  onDismiss: () => void
}) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    setVisible(message != null)
    if (message && message.priority === 'info') {
      const t = setTimeout(onDismiss, 12000)
      return () => clearTimeout(t)
    }
  }, [message, onDismiss])

  if (!message || !visible) return null
  return (
    <button
      type="button"
      onClick={onDismiss}
      className={`fixed inset-x-0 top-0 z-50 w-full px-6 py-5 text-left shadow-2xl ${PRIORITY_STYLES[message.priority]}`}
      // Clear the notch / rounded corners in landscape.
      style={{
        paddingTop: 'max(1.25rem, env(safe-area-inset-top))',
        paddingLeft: 'max(1.5rem, env(safe-area-inset-left))',
        paddingRight: 'max(1.5rem, env(safe-area-inset-right))',
      }}
    >
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-xs font-bold tracking-[0.25em] opacity-80">
          {SENDER_LABEL[message.sender]}
        </span>
        <span className="text-xs opacity-70">tap to dismiss</span>
      </div>
      <p className="mt-1 text-2xl font-extrabold leading-snug">{message.text}</p>
    </button>
  )
}
