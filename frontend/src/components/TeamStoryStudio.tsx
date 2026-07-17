import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Snapshot } from '../lib/types'
import { STORY_W, STORY_H, downloadBlob } from '../lib/story'
import { TEAM_STAT_LABELS, type TeamStatKey, type TeamStoryLogos } from '../lib/teamStory'
import {
  DEFAULT_TEAM_STORY_CONFIG, teamBgUrl, teamLogos, loadBackground, paintTeamStory,
  type TeamStoryConfig,
} from '../lib/teamStoryRender'
import { AccentPicker } from './AccentPicker'
import { getSafeword } from '../lib/api'
import { useT } from '../lib/i18n'

interface SavedBg { name: string; size_bytes: number; modified: number }

const BG_API = '/api/admin/backgrounds'
const bgThumb = (name: string) => `${BG_API}/${name}?safeword=${encodeURIComponent(getSafeword())}`

const STAT_ORDER: TeamStatKey[] = ['best', 'laps', 'time', 'pits', 'gap', 'last']

/**
 * Staff-facing configurator for the team Instagram-story graphic. It previews a
 * chosen kart, lets staff set the title/track/session label, accent, which stats
 * (up to 4), a saved background, and the footer link, then downloads a PNG or
 * saves the look as this slot's / snapshot's default (`onSaveConfig`). Teams see
 * only a read-only preview + download on their dashboard.
 */
export function TeamStoryStudio({
  snapshot, initialConfig, onSaveConfig,
}: {
  snapshot: Snapshot | null
  initialConfig?: TeamStoryConfig
  onSaveConfig?: (config: TeamStoryConfig) => Promise<void> | void
}) {
  const t = useT()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const seed = { ...DEFAULT_TEAM_STORY_CONFIG, ...initialConfig }
  const [title, setTitle] = useState(seed.title)
  const [subtitle, setSubtitle] = useState(seed.subtitle)
  const [label, setLabel] = useState(seed.label || 'Race')
  const [accent, setAccent] = useState(seed.accent || '#e10600')
  const [stats, setStats] = useState<TeamStatKey[]>(
    seed.stats?.length ? seed.stats : DEFAULT_TEAM_STORY_CONFIG.stats,
  )
  const [background, setBackground] = useState(seed.background)
  const [footerText, setFooterText] = useState(seed.footer_text)
  const [previewKart, setPreviewKart] = useState('')
  const [saved, setSaved] = useState<SavedBg[]>([])
  const [logos, setLogos] = useState<TeamStoryLogos | null>(null)
  const [bgImg, setBgImg] = useState<CanvasImageSource | null>(null)
  const [saveMsg, setSaveMsg] = useState('')
  const [bgMsg, setBgMsg] = useState('')

  // Seed the editable name fields once from the session (unless the saved config
  // already supplied them), then the user owns them.
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current || !snapshot) return
    if (!initialConfig?.title && snapshot.race.event_name) setTitle(snapshot.race.event_name)
    if (!initialConfig?.subtitle && snapshot.race.track_name) setSubtitle(snapshot.race.track_name)
    seeded.current = true
  }, [snapshot, initialConfig])

  // Default the preview to the leader once the field arrives.
  const drivers = useMemo(
    () => [...(snapshot?.drivers ?? [])].sort((a, b) => (a.position || 99) - (b.position || 99)),
    [snapshot],
  )
  useEffect(() => {
    if (!previewKart && drivers.length) setPreviewKart(drivers[0].kart_no)
  }, [drivers, previewKart])

  const config: TeamStoryConfig = useMemo(
    () => ({ title, subtitle, label, accent, stats, background, footer_text: footerText }),
    [title, subtitle, label, accent, stats, background, footerText],
  )

  useEffect(() => { void teamLogos().then(setLogos) }, [])
  useEffect(() => { void loadBackground(teamBgUrl(background)).then(setBgImg) }, [background])

  const refreshSaved = useCallback(async () => {
    try {
      const res = await fetch(BG_API, { headers: { 'X-Safeword': getSafeword() } })
      if (res.ok) setSaved((await res.json()).backgrounds ?? [])
    } catch { /* offline — strip stays empty */ }
  }, [])
  useEffect(() => { void refreshSaved() }, [refreshSaved])

  // Live preview (fully revealed still of the chosen team).
  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d')
    if (ctx && logos) paintTeamStory(ctx, snapshot, config, previewKart, bgImg, logos)
  }, [snapshot, config, previewKart, bgImg, logos])

  const toggleStat = (key: TeamStatKey) => {
    setStats((cur) =>
      cur.includes(key) ? cur.filter((k) => k !== key) : cur.length >= 4 ? cur : [...cur, key],
    )
  }

  const uploadBackground = useCallback(async (file: File | undefined) => {
    if (!file) return
    setBgMsg('')
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch(BG_API, {
        method: 'POST', headers: { 'X-Safeword': getSafeword() }, body: form,
      })
      if (res.status === 409) { setBgMsg(t('Store is full (5) — delete one first.')); return }
      if (!res.ok) { setBgMsg(t('Could not save that image.')); return }
      const list: SavedBg[] = (await res.json()).backgrounds ?? []
      setSaved(list)
      if (list[0]) setBackground(list[0].name)   // newest first — auto-select it
    } catch {
      setBgMsg(t('Could not save that image.'))
    }
  }, [t])

  const deleteSaved = useCallback(async (name: string) => {
    if (!window.confirm(t("Delete this saved background? This can't be undone."))) return
    try {
      await fetch(`${BG_API}/${name}`, { method: 'DELETE', headers: { 'X-Safeword': getSafeword() } })
    } catch { /* ignore */ }
    if (background === name) setBackground('')
    void refreshSaved()
  }, [background, refreshSaved, t])

  const downloadPng = useCallback(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx || !logos) return
    paintTeamStory(ctx, snapshot, config, previewKart, bgImg, logos)
    canvas.toBlob((blob) => {
      if (blob) downloadBlob(blob, `team-story-${previewKart || 'kart'}-${stamp()}.png`)
    }, 'image/png')
  }, [snapshot, config, previewKart, bgImg, logos])

  const saveConfig = useCallback(() => {
    if (!onSaveConfig) return
    void Promise.resolve(onSaveConfig(config)).then(() => {
      setSaveMsg(t('Saved as default ✓'))
      setTimeout(() => setSaveMsg(''), 2500)
    })
  }, [onSaveConfig, config, t])

  const hasData = drivers.length > 0

  return (
    <div className="grid gap-6 md:grid-cols-[300px_1fr]">
      {/* Preview */}
      <div>
        <canvas
          ref={canvasRef}
          width={STORY_W}
          height={STORY_H}
          className="w-full max-w-[280px] rounded-xl ring-1 ring-pit-700"
          style={{ aspectRatio: `${STORY_W} / ${STORY_H}` }}
        />
        <p className="mt-2 text-center text-[0.65rem] text-ink-500">
          {previewKart
            ? t('1080 × 1920 · previewing #{kart}', { kart: previewKart })
            : t('1080 × 1920 · previewing a team')}
        </p>
      </div>

      {/* Controls */}
      <div className="max-w-lg space-y-5">
        <div className="rounded-xl bg-pit-900 p-4 ring-1 ring-pit-800">
          <h2 className="text-sm font-bold uppercase tracking-wider text-ink-300">
            {t('Team story graphic')}
          </h2>
          <p className="mt-1 text-sm text-ink-500">
            {t('A per-team card teams can share to their followers. Configure it here; each team gets a preview + download button on their pit-wall dashboard (and on saved results).')}
          </p>
        </div>

        <Field label={t('Preview team')}>
          <select
            value={previewKart}
            onChange={(e) => setPreviewKart(e.target.value)}
            className="w-full rounded bg-pit-950 px-3 py-2 text-sm ring-1 ring-pit-600 focus:ring-race-red"
          >
            {!hasData && <option value="">{t('No teams yet')}</option>}
            {drivers.map((d) => (
              <option key={d.kart_no} value={d.kart_no}>
                P{d.position} · #{d.kart_no} {d.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[0.65rem] text-ink-500">
            {t('Only for the preview — every team downloads their own card.')}
          </p>
        </Field>

        <Field label={t('Event title')}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('Event Name')}
            className="w-full rounded bg-pit-950 px-3 py-2 text-sm ring-1 ring-pit-600 focus:ring-race-red"
          />
        </Field>

        <Field label={t('Track / subtitle')}>
          <input
            value={subtitle}
            onChange={(e) => setSubtitle(e.target.value)}
            placeholder={t('Track')}
            className="w-full rounded bg-pit-950 px-3 py-2 text-sm ring-1 ring-pit-600 focus:ring-race-red"
          />
        </Field>

        <Field label={t('Session label')}>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('Race')}
            className="w-full rounded bg-pit-950 px-3 py-2 text-sm ring-1 ring-pit-600 focus:ring-race-red"
          />
        </Field>

        <Field label={t('Accent colour')}>
          <AccentPicker value={accent} onChange={setAccent} />
        </Field>

        <Field label={t('Stats (pick up to 4)')}>
          <div className="flex flex-wrap gap-2">
            {STAT_ORDER.map((key) => {
              const on = stats.includes(key)
              const order = stats.indexOf(key)
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggleStat(key)}
                  className={`rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wider ${
                    on ? 'bg-race-red text-white' : 'bg-pit-700 text-ink-200 hover:bg-pit-600'
                  }`}
                >
                  {on && <span className="mr-1 opacity-70">{order + 1}.</span>}
                  {t(TEAM_STAT_LABELS[key])}
                </button>
              )
            })}
          </div>
          <p className="mt-1 text-[0.65rem] text-ink-500">
            {t('Tap to add/remove; the number shows the card order.')}
          </p>
        </Field>

        <Field label={t('Background (saved on server)')}>
          <div className="space-y-2">
            <input
              type="file"
              accept="image/*"
              onChange={(e) => { void uploadBackground(e.target.files?.[0]); e.target.value = '' }}
              className="block w-full text-sm text-ink-300 file:mr-3 file:rounded file:border-0 file:bg-pit-700 file:px-3 file:py-1.5 file:text-xs file:font-bold file:uppercase file:tracking-wider file:text-ink-100"
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setBackground('')}
                title={t('No background')}
                className={`flex h-14 w-9 items-center justify-center rounded text-[0.6rem] font-bold ring-1 ${
                  !background ? 'ring-race-red bg-pit-800' : 'ring-pit-700 bg-pit-900 hover:ring-pit-500'
                }`}
              >
                {t('None')}
              </button>
              {saved.map((s) => (
                <div key={s.name} className="group relative">
                  <button
                    type="button"
                    onClick={() => setBackground(s.name)}
                    title={t('Use this background')}
                    className={`block h-14 w-9 overflow-hidden rounded ring-1 ${
                      background === s.name ? 'ring-race-red' : 'ring-pit-700 hover:ring-pit-500'
                    }`}
                  >
                    <img src={bgThumb(s.name)} alt="" className="h-full w-full object-cover" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteSaved(s.name)}
                    title={t('Delete')}
                    className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-race-red text-[0.6rem] font-bold text-white opacity-0 group-hover:opacity-100"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            {bgMsg && <p className="text-[0.7rem] text-race-red">{bgMsg}</p>}
            <p className="text-[0.65rem] text-ink-500">
              {t("Team backgrounds are stored on the server (max 5) so every team's card can load them. Uploading saves + selects the image.")}
            </p>
          </div>
        </Field>

        <Field label={t('Footer link')}>
          <input
            value={footerText}
            onChange={(e) => setFooterText(e.target.value)}
            placeholder="timing.we-race.it"
            className="w-full rounded bg-pit-950 px-3 py-2 text-sm ring-1 ring-pit-600 focus:ring-race-red"
          />
        </Field>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={downloadPng}
            disabled={!hasData || !logos}
            className="rounded bg-race-red px-4 py-2 text-sm font-bold uppercase tracking-wider text-white hover:brightness-110 disabled:opacity-40"
          >
            {t('Download PNG')}
          </button>
          {onSaveConfig && (
            <button
              type="button"
              onClick={saveConfig}
              className="rounded bg-pit-700 px-4 py-2 text-sm font-bold uppercase tracking-wider text-ink-100 hover:bg-pit-600"
            >
              {t('Save as default')}
            </button>
          )}
          {saveMsg && <span className="text-xs text-race-green">{saveMsg}</span>}
          {!hasData && <span className="text-xs text-ink-500">{t('No standings yet.')}</span>}
        </div>
        {onSaveConfig && (
          <p className="text-[0.65rem] text-ink-500">
            {t('Teams download their card with this look (on the dashboard and saved results).')}
          </p>
        )}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="label-race mb-1.5">{label}</div>
      {children}
    </div>
  )
}

function stamp(): string {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
}
