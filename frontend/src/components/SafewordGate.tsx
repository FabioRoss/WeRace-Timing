import { useEffect, useState } from 'react'
import { api, clearSafeword, getSafeword, setSafeword } from '../lib/api'

/** Wraps Race Control / Staff pages: asks for the safeword, verifies server-side. */
export function SafewordGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<'checking' | 'locked' | 'open'>('checking')
  const [input, setInput] = useState('')
  const [error, setError] = useState('')

  const verify = async () => {
    try {
      await api('/api/admin/validate', { method: 'POST', safeword: true })
      setState('open')
    } catch {
      clearSafeword()
      setState('locked')
    }
  }

  useEffect(() => {
    if (getSafeword()) void verify()
    else setState('locked')
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSafeword(input.trim())
    setError('')
    try {
      await api('/api/admin/validate', { method: 'POST', safeword: true })
      setState('open')
    } catch {
      clearSafeword()
      setError('Wrong safeword')
    }
  }

  if (state === 'open') return <>{children}</>
  if (state === 'checking') {
    return <div className="grid h-full place-items-center text-ink-500">Checking access…</div>
  }
  return (
    <div className="grid h-full place-items-center p-6">
      <form onSubmit={submit} className="w-full max-w-xs space-y-4 rounded-xl bg-pit-850 p-6">
        <div className="checker h-4 w-full rounded-sm" />
        <h1 className="text-lg font-bold uppercase tracking-widest text-center">Restricted</h1>
        <input
          type="password"
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Safeword"
          className="w-full rounded bg-pit-950 px-3 py-2 outline-none ring-1 ring-pit-600 focus:ring-race-blue"
        />
        {error && <p className="text-sm text-race-red">{error}</p>}
        <button
          type="submit"
          className="w-full rounded bg-race-blue py-2 font-bold uppercase tracking-wider hover:brightness-110"
        >
          Enter
        </button>
      </form>
    </div>
  )
}
