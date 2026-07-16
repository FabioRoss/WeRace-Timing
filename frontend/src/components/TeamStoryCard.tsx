import { useEffect, useMemo, useRef, useState } from 'react'
import type { Snapshot } from '../lib/types'
import { STORY_W, STORY_H, downloadBlob } from '../lib/story'
import type { TeamStoryLogos } from '../lib/teamStory'
import {
  teamBgUrl, teamLogos, loadBackground, paintTeamStory, type TeamStoryConfig,
} from '../lib/teamStoryRender'

/**
 * Read-only team-story preview + download for the pit-wall dashboard. Teams
 * can't configure the look (staff own that via the Export page) — they just get
 * their own auto-generated card to share. `config` is the slot's staff-chosen
 * `team_story_config` (from the live snapshot).
 */
export function TeamStoryCard({
  snapshot, kart, config,
}: {
  snapshot: Snapshot | null
  kart: string
  config: TeamStoryConfig
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [logos, setLogos] = useState<TeamStoryLogos | null>(null)
  const [bgImg, setBgImg] = useState<CanvasImageSource | null>(null)

  // Stringify so the effect only re-runs on a real config change.
  const cfgKey = useMemo(() => JSON.stringify(config), [config])

  useEffect(() => { void teamLogos().then(setLogos) }, [])
  useEffect(() => { void loadBackground(teamBgUrl(config.background)).then(setBgImg) }, [config.background])

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d')
    if (ctx && logos) paintTeamStory(ctx, snapshot, config, kart, bgImg, logos)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, cfgKey, kart, bgImg, logos])

  const download = () => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx || !logos) return
    paintTeamStory(ctx, snapshot, config, kart, bgImg, logos)
    canvas.toBlob((blob) => {
      if (blob) downloadBlob(blob, `team-story-${kart || 'kart'}-${stamp()}.png`)
    }, 'image/png')
  }

  return (
    <div className="rounded-xl bg-pit-900 p-4 ring-1 ring-pit-800">
      <h3 className="label-race mb-3">Shareable story graphic</h3>
      <div className="flex flex-col items-start gap-4 sm:flex-row">
        <canvas
          ref={canvasRef}
          width={STORY_W}
          height={STORY_H}
          className="w-full max-w-[180px] rounded-lg ring-1 ring-pit-700"
          style={{ aspectRatio: `${STORY_W} / ${STORY_H}` }}
        />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm text-ink-400">
            An auto-generated 1080×1920 card for your Instagram story — tag us and share your result!
          </p>
          <button
            type="button"
            onClick={download}
            disabled={!logos}
            className="rounded bg-race-blue px-4 py-2 text-sm font-bold uppercase tracking-wider text-white hover:brightness-110 disabled:opacity-40"
          >
            Download story
          </button>
        </div>
      </div>
    </div>
  )
}

function stamp(): string {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
}
