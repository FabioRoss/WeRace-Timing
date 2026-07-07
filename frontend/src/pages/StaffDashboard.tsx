import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { QRCodeSVG } from 'qrcode.react'
import { api } from '../lib/api'
import { SafewordGate } from '../components/SafewordGate'
import { PageHeader } from '../components/StatusBar'
import type { KartLinks } from '../lib/types'

export function StaffDashboard() {
  return (
    <SafewordGate>
      <StaffInner />
    </SafewordGate>
  )
}

function StaffInner() {
  const { slot = '1' } = useParams()
  const [karts, setKarts] = useState<KartLinks[]>([])
  const [extra, setExtra] = useState('')
  const [extraApplied, setExtraApplied] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async (extraKarts: string) => {
    try {
      const r = await api<{ karts: KartLinks[] }>(
        `/e/${slot}/api/admin/links?extra=${encodeURIComponent(extraKarts)}`,
        { safeword: true },
      )
      setKarts(r.karts)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [slot])

  useEffect(() => {
    void load(extraApplied)
    const t = setInterval(() => void load(extraApplied), 15000)
    return () => clearInterval(t)
  }, [load, extraApplied])

  return (
    <div className="mx-auto flex min-h-full max-w-7xl flex-col">
      <PageHeader
        title={`Staff — Event ${slot} QR sheet`}
        subtitle="Let each team scan their own kart's QR codes"
        right={
          <button
            type="button"
            onClick={() => window.print()}
            className="rounded bg-pit-700 px-3 py-1.5 text-xs font-bold uppercase tracking-wider hover:bg-pit-600 print:hidden"
          >
            Print
          </button>
        }
      />

      <div className="flex flex-wrap items-center gap-2 px-4 pt-4 print:hidden">
        <input
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          placeholder="Pre-generate karts (e.g. 2,3,4,5) before the feed is live"
          className="w-96 max-w-full rounded bg-pit-950 px-3 py-2 text-sm ring-1 ring-pit-600 focus:ring-race-blue"
        />
        <button
          type="button"
          onClick={() => setExtraApplied(extra)}
          className="rounded bg-race-blue px-3 py-2 text-xs font-bold uppercase tracking-wider"
        >
          Generate
        </button>
        {error && <span className="text-sm text-race-red">{error}</span>}
      </div>

      <main className="grid flex-1 grid-cols-1 gap-4 p-4 sm:grid-cols-2 xl:grid-cols-3 print:grid-cols-2 print:text-black">
        {karts.length === 0 && (
          <p className="text-ink-500">
            No karts yet — connect a timing source or pre-generate kart numbers above.
          </p>
        )}
        {karts.map((k) => (
          <div
            key={k.kart_no}
            className="break-inside-avoid rounded-xl bg-pit-900 p-4 ring-1 ring-pit-800 print:bg-white print:ring-black"
          >
            <div className="mb-3 flex items-baseline justify-between">
              <span className="timing text-2xl font-extrabold">KART #{k.kart_no}</span>
              <span className="max-w-40 truncate text-sm text-ink-500 print:text-black">{k.name}</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <QrBlock label="Driver" url={k.driver_url} />
              <QrBlock label="Team Manager" url={k.team_url} />
            </div>
          </div>
        ))}
      </main>
    </div>
  )
}

function QrBlock({ label, url }: { label: string; url: string }) {
  return (
    <div className="min-w-0 text-center">
      <div className="label-race mb-2 print:text-black">{label}</div>
      <div className="inline-block max-w-full rounded bg-white p-2">
        <QRCodeSVG value={url} size={120} className="h-auto w-full max-w-[120px]" />
      </div>
      <button
        type="button"
        onClick={() => navigator.clipboard?.writeText(url)}
        className="mt-2 block w-full truncate text-[0.6rem] text-ink-500 hover:text-ink-300 print:hidden"
        title={url}
      >
        copy link
      </button>
    </div>
  )
}
