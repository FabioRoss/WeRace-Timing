import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Snapshot } from '../lib/types'
import { STORY_W, STORY_H, downloadBlob } from '../lib/story'
import type { TeamStoryLogos } from '../lib/teamStory'
import {
  teamBgUrl, teamLogos, loadBackground, paintTeamStory, type TeamStoryConfig,
} from '../lib/teamStoryRender'
import { useT } from '../lib/i18n'

/**
 * Read-only team-story preview + download for the pit-wall dashboard. Teams
 * can't configure the look (staff own that via the Export page) — they just get
 * their own auto-generated card to share. `config` is the slot's staff-chosen
 * `team_story_config` (from the live snapshot).
 *
 * The one thing a team may change is the background: an optional own photo,
 * cover-fit, kept only in the browser for this session (no upload, no editor).
 * When set it replaces the staff default; "Use default" clears it.
 */
export function TeamStoryCard({
  snapshot, kart, config,
}: {
  snapshot: Snapshot | null
  kart: string
  config: TeamStoryConfig
}) {
  const t = useT()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [logos, setLogos] = useState<TeamStoryLogos | null>(null)
  const [bgImg, setBgImg] = useState<CanvasImageSource | null>(null)
  // A team's own background: session-only, never uploaded. Overrides the default.
  const [ownBg, setOwnBg] = useState<CanvasImageSource | null>(null)
  const [ownName, setOwnName] = useState('')
  const [bgError, setBgError] = useState('')

  // Stringify so the effect only re-runs on a real config change.
  const cfgKey = useMemo(() => JSON.stringify(config), [config])
  const effectiveBg = ownBg ?? bgImg

  useEffect(() => { void teamLogos().then(setLogos) }, [])
  useEffect(() => { void loadBackground(teamBgUrl(config.background)).then(setBgImg) }, [config.background])

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d')
    if (ctx && logos) paintTeamStory(ctx, snapshot, config, kart, effectiveBg, logos)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, cfgKey, kart, effectiveBg, logos])

  const pickOwn = useCallback(async (file: File | undefined) => {
    setBgError('')
    if (!file) return
    try {
      setOwnBg(await createImageBitmap(file))   // cover-fit is applied by the renderer
      setOwnName(file.name)
    } catch {
      setBgError(t('Could not read that image.'))
    }
  }, [])

  const clearOwn = () => { setOwnBg(null); setOwnName(''); setBgError('') }

  const download = () => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx || !logos) return
    paintTeamStory(ctx, snapshot, config, kart, effectiveBg, logos)
    canvas.toBlob((blob) => {
      if (blob) downloadBlob(blob, `team-story-${kart || 'kart'}-${stamp()}.png`)
    }, 'image/png')
  }

  return (
    <div className="rounded-xl bg-pit-900 p-4 ring-1 ring-pit-800">
      <h3 className="label-race mb-3">{t('Shareable story graphic')}</h3>
      <div className="flex flex-col items-start gap-4 sm:flex-row">
        <canvas
          ref={canvasRef}
          width={STORY_W}
          height={STORY_H}
          className="w-full max-w-[180px] rounded-lg ring-1 ring-pit-700"
          style={{ aspectRatio: `${STORY_W} / ${STORY_H}` }}
        />
        <div className="min-w-0 flex-1 space-y-3">
          <p className="text-sm text-ink-400">
            {t('An auto-generated 1080×1920 card for your Instagram story — tag us and share your result!')}
          </p>
          <button
            type="button"
            onClick={download}
            disabled={!logos}
            className="rounded bg-race-blue px-4 py-2 text-sm font-bold uppercase tracking-wider text-white hover:brightness-110 disabled:opacity-40"
          >
            {t('Download story')}
          </button>
          <div className="space-y-1">
            <label className="label-race block">{t('Your own background (optional)')}</label>
            <input
              type="file"
              accept="image/*"
              onChange={(e) => { void pickOwn(e.target.files?.[0]); e.target.value = '' }}
              className="block w-full text-sm text-ink-300 file:mr-3 file:rounded file:border-0 file:bg-pit-700 file:px-3 file:py-1.5 file:text-xs file:font-bold file:uppercase file:tracking-wider file:text-ink-100"
            />
            {ownName && (
              <div className="flex items-center gap-2 text-xs text-ink-500">
                <span className="truncate">{ownName}</span>
                <button type="button" onClick={clearOwn} className="text-race-red">
                  {t('use default')}
                </button>
              </div>
            )}
            {bgError && <p className="text-xs text-race-red">{bgError}</p>}
            <p className="text-[0.65rem] text-ink-500">
              {t('Stays in your browser — it\'s never uploaded, and only changes your own download.')}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

function stamp(): string {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
}
