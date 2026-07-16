// Shared plumbing for the team Instagram-story graphic: the saved-config shape,
// a cached logo loader, background loading by name, and a one-shot
// render-to-PNG-blob used by the read-only surfaces (team dashboard preview /
// download, snapshot row-click download). The interactive staff studio draws to
// its own visible canvas but reuses the same config type + helpers.
import type { Snapshot } from './types'
import { STORY_W, STORY_H } from './story'
import { buildTeamStoryModel, drawTeamStory, type TeamStatKey, type TeamStoryLogos } from './teamStory'
import { loadWeraceLogo } from './weraceLogo'

/** The staff-chosen look, persisted per slot (live) and per snapshot. Mirrors
 * the backend `team_story_config` keys. */
export interface TeamStoryConfig {
  title?: string
  subtitle?: string
  label?: string
  accent?: string
  stats?: TeamStatKey[]
  background?: string      // saved-background filename ('' = none)
  footer_text?: string
}

export const DEFAULT_TEAM_STORY_CONFIG: Required<TeamStoryConfig> = {
  title: '', subtitle: '', label: 'Race', accent: '#e10600',
  stats: ['best', 'laps', 'time'], background: '', footer_text: 'timing.we-race.it',
}

/** Public serve for a saved background by name (works for token-gated dashboards
 * and the ungated results page). */
export function teamBgUrl(name: string | undefined | null): string | null {
  return name ? `/api/backgrounds/${encodeURIComponent(name)}` : null
}

// The wordmark is tinted once (black + white) and cached for the session.
let logoCache: Promise<TeamStoryLogos> | null = null
export function teamLogos(): Promise<TeamStoryLogos> {
  if (!logoCache) {
    logoCache = Promise.all([
      loadWeraceLogo('#0b0d14').catch(() => null),
      loadWeraceLogo('#f4f6fb').catch(() => null),
    ]).then(([black, white]) => ({ black, white }))
  }
  return logoCache
}

export async function loadBackground(url: string | null): Promise<CanvasImageSource | null> {
  if (!url) return null
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return await createImageBitmap(await res.blob())
  } catch {
    return null
  }
}

function toOptions(config: TeamStoryConfig, kart: string) {
  return {
    kart,
    title: config.title,
    subtitle: config.subtitle,
    label: config.label,
    stats: config.stats,
    footerText: config.footer_text,
  }
}

/** Draw a finished (fully-revealed) team card onto `ctx`. */
export function paintTeamStory(
  ctx: CanvasRenderingContext2D, snapshot: Snapshot | null, config: TeamStoryConfig,
  kart: string, background: CanvasImageSource | null, logos: TeamStoryLogos,
) {
  const model = buildTeamStoryModel(snapshot, toOptions(config, kart))
  drawTeamStory(ctx, model, 1, background, config.accent || '#e10600', undefined, logos)
}

/** Render the team card to a PNG blob (off-screen). Loads the logos + background
 * itself, so callers only need the snapshot + config + kart. */
export async function renderTeamStoryBlob(
  snapshot: Snapshot | null, config: TeamStoryConfig, kart: string,
): Promise<Blob | null> {
  const [logos, bg] = await Promise.all([teamLogos(), loadBackground(teamBgUrl(config.background))])
  const canvas = document.createElement('canvas')
  canvas.width = STORY_W
  canvas.height = STORY_H
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  paintTeamStory(ctx, snapshot, config, kart, bg, logos)
  return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
}
