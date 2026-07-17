import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { QRCodeSVG } from 'qrcode.react'
import { api } from '../lib/api'
import { SafewordGate } from '../components/SafewordGate'
import { PageHeader } from '../components/StatusBar'
import { PageNav } from '../components/PageNav'
import type { KartLinks } from '../lib/types'
import { useT } from '../lib/i18n'

export function StaffDashboard() {
  return (
    <SafewordGate>
      <StaffInner />
    </SafewordGate>
  )
}

function StaffInner() {
  const t = useT()
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
    const timer = setInterval(() => void load(extraApplied), 15000)
    return () => clearInterval(timer)
  }, [load, extraApplied])

  // Sort by kart number, not the feed's standings order, so the QR sheet is
  // easy to scan (mirrors the RaceControl message-kart ordering).
  const sortedKarts = useMemo(
    () =>
      [...karts].sort(
        (a, b) =>
          (parseInt(a.kart_no, 10) || 0) - (parseInt(b.kart_no, 10) || 0) ||
          a.kart_no.localeCompare(b.kart_no),
      ),
    [karts],
  )

  return (
    <div className="mx-auto flex min-h-full max-w-7xl flex-col">
      <PageHeader
        title={t('Staff — Event {slot} QR sheet', { slot })}
        subtitle={t("Let each team scan their own kart's QR codes")}
        nav={<PageNav slot={slot} />}
        right={
          <button
            type="button"
            onClick={() => window.print()}
            className="rounded bg-pit-700 px-3 py-1.5 text-xs font-bold uppercase tracking-wider hover:bg-pit-600 print:hidden"
          >
            {t('Print')}
          </button>
        }
      />

      <div className="flex flex-wrap items-center gap-2 px-4 pt-4 print:hidden">
        <input
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          placeholder={t('Pre-generate karts (e.g. 2,3,4,5) before the feed is live')}
          className="w-96 max-w-full rounded bg-pit-950 px-3 py-2 text-sm ring-1 ring-pit-600 focus:ring-race-blue"
        />
        <button
          type="button"
          onClick={() => setExtraApplied(extra)}
          className="rounded bg-race-blue px-3 py-2 text-xs font-bold uppercase tracking-wider"
        >
          {t('Generate')}
        </button>
        {error && <span className="text-sm text-race-red">{error}</span>}
      </div>

      <main className="grid flex-1 grid-cols-1 gap-4 p-4 sm:grid-cols-2 xl:grid-cols-3 print:grid-cols-2 print:text-black">
        {karts.length === 0 && (
          <p className="text-ink-500">
            {t('No karts yet — connect a timing source or pre-generate kart numbers above.')}
          </p>
        )}
        {sortedKarts.map((k) => (
          <div
            key={k.kart_no}
            className="break-inside-avoid rounded-xl bg-pit-900 p-4 ring-1 ring-pit-800 print:bg-white print:ring-black"
          >
            <div className="mb-3 flex items-baseline justify-between">
              <span className="timing text-2xl font-extrabold">{t('KART #{kart}', { kart: k.kart_no })}</span>
              <span className="max-w-40 truncate text-sm text-ink-500 print:text-black">{k.name}</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <QrBlock label={t('Driver')} url={k.driver_url} />
              <QrBlock label={t('Team Manager')} url={k.team_url} />
            </div>
          </div>
        ))}
      </main>
    </div>
  )
}

function QrBlock({ label, url }: { label: string; url: string }) {
  const t = useT()
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
        {t('copy link')}
      </button>
    </div>
  )
}
