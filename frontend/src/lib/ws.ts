import { useEffect, useRef, useState } from 'react'

export type WsStatus = 'connecting' | 'open' | 'closed'

/**
 * Auto-reconnecting JSON websocket. `path` is relative ("/e/1/ws/live");
 * the handler receives every parsed message.
 */
export function useJsonSocket<T>(path: string, onMessage: (msg: T) => void) {
  const [status, setStatus] = useState<WsStatus>('connecting')
  const [lastSeen, setLastSeen] = useState<number>(0)
  const handlerRef = useRef(onMessage)
  handlerRef.current = onMessage

  useEffect(() => {
    let ws: WebSocket | null = null
    let retry = 0
    let closed = false
    let reconnectTimer: ReturnType<typeof setTimeout>
    let pingTimer: ReturnType<typeof setInterval>

    const connect = () => {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${window.location.host}${path}`)
      setStatus('connecting')

      ws.onopen = () => {
        retry = 0
        setStatus('open')
      }
      ws.onmessage = (ev) => {
        setLastSeen(Date.now())
        try {
          handlerRef.current(JSON.parse(ev.data) as T)
        } catch {
          /* non-JSON frame — ignore */
        }
      }
      ws.onclose = () => {
        setStatus('closed')
        if (!closed) {
          const delay = Math.min(1000 * 2 ** retry, 15000)
          retry += 1
          reconnectTimer = setTimeout(connect, delay)
        }
      }
      ws.onerror = () => ws?.close()
    }

    connect()
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send('ping')
    }, 25000)

    return () => {
      closed = true
      clearTimeout(reconnectTimer)
      clearInterval(pingTimer)
      ws?.close()
    }
  }, [path])

  return { status, lastSeen }
}
