// Client-side renderer for the team-oriented Instagram-story export. Where the
// standings story (lib/story.ts) shows the whole field, this one is built around
// a single team: its name is the hero, with the position and a configurable set
// of stats (best lap, laps, race time, …). Same feel as the standings card —
// 1080x1920 Canvas 2D, dark scrim over an optional background, accent colour —
// plus a footer with the WeRace wordmark and the timing.we-race.it link. The
// wordmark auto-tints to whatever reads best over the footer (black on light,
// white on dark).
import type { Snapshot } from './types'
import { fmtLap, fmtGap } from './format'
import type { BgTransform } from './story'
import { STORY_W, STORY_H, SAFE_TOP, SAFE_BOTTOM, DEFAULT_BG_TRANSFORM } from './story'
import { WERACE_LOGO_VIEWBOX } from './weraceLogo'

const BLACK = '#0b0d14'
const WHITE = '#f4f6fb'
const GREY = '#b9c0d4'
const FONT = "'Segoe UI', Inter, system-ui, sans-serif"
const MONO = "ui-monospace, 'SF Mono', 'Roboto Mono', monospace"

const M = 70 // side margin
const FOOTER_TEXT = 'timing.we-race.it'

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const n = parseInt(h, 16)
  return Number.isNaN(n) ? [225, 6, 0] : [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function accentTextOn([r, g, b]: [number, number, number]): string {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.6 ? WHITE : BLACK
}

/** The stats a team card can display. The staff pick which (and their order). */
export type TeamStatKey = 'best' | 'laps' | 'time' | 'pits' | 'gap' | 'last'

export const TEAM_STAT_LABELS: Record<TeamStatKey, string> = {
  best: 'Best lap',
  laps: 'Laps',
  time: 'Race time',
  pits: 'Pit stops',
  gap: 'Gap to leader',
  last: 'Last lap',
}

export const DEFAULT_TEAM_STATS: TeamStatKey[] = ['best', 'laps', 'time']

export interface TeamStat {
  caption: string
  value: string
}

export interface TeamStoryModel {
  label: string       // kicker (session type), e.g. "RACE"
  title: string       // event name
  subtitle: string    // track
  teamName: string
  position: number
  totalKarts: number
  kart: string
  stats: TeamStat[]
  footerText: string
  found: boolean       // false when the chosen kart isn't in the feed
}

export interface TeamStoryOptions {
  kart: string          // which kart/team the card is about
  teamName?: string     // overrides the feed name
  title?: string        // overrides the event name
  subtitle?: string     // overrides the track name
  label?: string        // session kicker; blank falls back to 'Race'
  stats?: TeamStatKey[] // which stats to show (default best/laps/time)
  footerText?: string   // overrides the timing.we-race.it link line
}

/** M:SS or H:MM:SS from a cumulative-time value in ms. */
function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return '—'
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}

function statFor(key: TeamStatKey, d: Snapshot['drivers'][number], race: Snapshot['race']): TeamStat {
  const leader = (d.position || 0) === 1
  switch (key) {
    case 'best':
      return { caption: 'BEST LAP', value: fmtLap(d.best_lap_ms) }
    case 'laps':
      return { caption: 'LAPS', value: String(d.laps ?? 0) }
    case 'time':
      // The team's own running/finish time; fall back to the session clock.
      return { caption: 'RACE TIME', value: d.total_time_ms ? fmtDuration(d.total_time_ms) : (race.race_time || '—') }
    case 'pits':
      return { caption: 'PIT STOPS', value: String(d.pits ?? 0) }
    case 'gap':
      return { caption: 'TO LEADER', value: leader ? 'LEADER' : fmtGap(d.gap_leader) }
    case 'last':
      return { caption: 'LAST LAP', value: fmtLap(d.last_lap_ms) }
  }
}

export function buildTeamStoryModel(snapshot: Snapshot | null, opts: TeamStoryOptions): TeamStoryModel {
  const drivers = snapshot?.drivers ?? []
  const own = drivers.find((d) => d.kart_no === opts.kart)
  const race = snapshot?.race
  const keys = (opts.stats && opts.stats.length ? opts.stats : DEFAULT_TEAM_STATS).slice(0, 4)
  const stats: TeamStat[] = own && race
    ? keys.map((k) => statFor(k, own, race))
    : keys.map((k) => ({ caption: TEAM_STAT_LABELS[k].toUpperCase(), value: '—' }))
  return {
    label: opts.label?.trim() || 'Race',
    title: opts.title?.trim() || race?.event_name || 'Race Result',
    subtitle: opts.subtitle?.trim() || race?.track_name || '',
    teamName: opts.teamName?.trim() || own?.name || (own ? `Kart ${own.kart_no}` : (opts.kart ? `Kart ${opts.kart}` : 'Your Team')),
    position: own?.position || 0,
    totalKarts: drivers.length,
    kart: opts.kart || own?.kart_no || '',
    stats,
    footerText: opts.footerText?.trim() || FOOTER_TEXT,
    found: !!own,
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function drawChecker(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, cell: number) {
  const cols = Math.ceil(w / cell)
  const rows = Math.ceil(h / cell)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      ctx.fillStyle = (r + c) % 2 === 0 ? WHITE : BLACK
      ctx.fillRect(x + c * cell, y + r * cell, cell, cell)
    }
  }
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text
  let t = text
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1)
  return `${t}…`
}

/** Auto-shrink `text` (starting at `start`px) until it fits `maxW` on one line. */
function fitFont(
  ctx: CanvasRenderingContext2D, text: string, maxW: number, start: number, min: number, weight = 800,
): number {
  for (let size = start; size > min; size -= 3) {
    ctx.font = `${weight} ${size}px ${FONT}`
    if (ctx.measureText(text).width <= maxW) return size
  }
  ctx.font = `${weight} ${min}px ${FONT}`
  return min
}

function wrapWords(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(' ')
  const out: string[] = []
  let line = ''
  for (const w of words) {
    const test = line ? `${line} ${w}` : w
    if (ctx.measureText(test).width > maxW && line) {
      out.push(line)
      line = w
    } else {
      line = test
    }
  }
  if (line) out.push(line)
  return out
}

/** Fit the team name into at most two lines: shrink the font until the wrap is
 * ≤ 2 lines, then hard-truncate the second line if a single word is still too
 * wide. */
function layoutName(
  ctx: CanvasRenderingContext2D, text: string, maxW: number, start: number, min: number,
): { lines: string[]; size: number; lineH: number } {
  for (let size = start; size >= min; size -= 3) {
    ctx.font = `800 ${size}px ${FONT}`
    const lines = wrapWords(ctx, text, maxW)
    if (lines.length <= 2 || size === min) {
      const two = lines.slice(0, 2)
      if (lines.length > 2) two[1] = fitText(ctx, `${two[1]} ${lines[2]}`, maxW)
      else two[two.length - 1] = fitText(ctx, two[two.length - 1], maxW)
      return { lines: two, size, lineH: Math.round(size * 1.05) }
    }
  }
  ctx.font = `800 ${min}px ${FONT}`
  return { lines: [fitText(ctx, text, maxW)], size: min, lineH: Math.round(min * 1.05) }
}

/** Logos, pre-tinted so the renderer can pick the one that reads on the footer.
 * Both are optional (a missing decode just drops the wordmark). */
export interface TeamStoryLogos {
  black: CanvasImageSource | null
  white: CanvasImageSource | null
}

/** Average luminance (0..1) of a canvas region; null if it can't be sampled
 * (e.g. a cross-origin-tainted canvas). Used to pick the footer wordmark tint. */
function regionLuminance(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
): number | null {
  try {
    const data = ctx.getImageData(x, y, Math.max(1, w), Math.max(1, h)).data
    let sum = 0
    let count = 0
    // Sample sparsely — a footer strip is wide; every 40th pixel is plenty.
    for (let i = 0; i < data.length; i += 4 * 40) {
      sum += (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255
      count++
    }
    return count ? sum / count : null
  } catch {
    return null
  }
}

/** Draw the whole team card. `reveal` (0..1) drives a subtle intro of the hero
 * + stats; pass 1 for a finished still. */
export function drawTeamStory(
  ctx: CanvasRenderingContext2D,
  model: TeamStoryModel,
  reveal: number,
  background: CanvasImageSource | null,
  accent: string = '#e10600',
  bgTransform: BgTransform = DEFAULT_BG_TRANSFORM,
  logos: TeamStoryLogos = { black: null, white: null },
) {
  const [ar, ag, ab] = hexToRgb(accent)
  const ACCENT = `rgb(${ar}, ${ag}, ${ab})`
  const ACCENT_TEXT = accentTextOn([ar, ag, ab])
  ctx.clearRect(0, 0, STORY_W, STORY_H)

  // Base + optional background (cover-fit + transform) + legibility scrim.
  ctx.fillStyle = BLACK
  ctx.fillRect(0, 0, STORY_W, STORY_H)
  if (background) {
    const bw = (background as { width?: number }).width ?? STORY_W
    const bh = (background as { height?: number }).height ?? STORY_H
    const cover = Math.max(STORY_W / bw, STORY_H / bh)
    const s = cover * Math.max(0.05, bgTransform.scale)
    ctx.save()
    ctx.translate(STORY_W / 2 + bgTransform.x, STORY_H / 2 + bgTransform.y)
    ctx.rotate((bgTransform.rot * Math.PI) / 180)
    ctx.scale(s, s)
    ctx.drawImage(background, -bw / 2, -bh / 2, bw, bh)
    ctx.restore()
    ctx.fillStyle = 'rgba(7, 8, 12, 0.72)'
    ctx.fillRect(0, 0, STORY_W, STORY_H)
  } else {
    const grad = ctx.createRadialGradient(200, 380, 60, 200, 380, 1000)
    grad.addColorStop(0, `rgba(${ar}, ${ag}, ${ab}, 0.24)`)
    grad.addColorStop(1, `rgba(${ar}, ${ag}, ${ab}, 0)`)
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, STORY_W, STORY_H)
  }

  const maxW = STORY_W - 2 * M
  const eased = 1 - Math.pow(1 - Math.max(0, Math.min(1, reveal)), 3)

  // ---- Header ----
  drawChecker(ctx, M, SAFE_TOP, 240, 26, 26)
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  ctx.fillStyle = ACCENT
  ctx.font = `800 34px ${FONT}`
  ctx.fillText(fitText(ctx, model.label.toUpperCase(), maxW), M, SAFE_TOP + 78)

  const titleSize = fitFont(ctx, model.title.toUpperCase(), maxW, 60, 38)
  ctx.fillStyle = WHITE
  ctx.font = `800 ${titleSize}px ${FONT}`
  const titleY = SAFE_TOP + 96 + titleSize
  ctx.fillText(fitText(ctx, model.title.toUpperCase(), maxW), M, titleY)
  let headerBottom = titleY + 12
  if (model.subtitle) {
    ctx.fillStyle = GREY
    ctx.font = `500 38px ${FONT}`
    headerBottom += 44
    ctx.fillText(fitText(ctx, model.subtitle, maxW), M, headerBottom)
  }

  // ---- Layout: centre the hero + stats block between the header and footer ----
  const footerTop = SAFE_BOTTOM - 96
  const stats = model.stats.slice(0, 4)
  const badge = 320
  const heroStatsGap = 56
  const cardH = 224
  const blockH = badge + (stats.length ? heroStatsGap + cardH : 0)
  const regionTop = headerBottom + 44
  const regionBottom = footerTop - 30
  const heroTop = regionTop + Math.max(0, (regionBottom - regionTop - blockH) / 2)

  // ---- Hero: position badge + team name ----
  ctx.save()
  ctx.globalAlpha = eased
  ctx.translate((1 - eased) * 40, 0)

  // Position badge (accent square, giant number).
  roundRect(ctx, M, heroTop, badge, badge, 30)
  ctx.fillStyle = ACCENT
  ctx.fill()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = ACCENT_TEXT
  ctx.font = `800 46px ${FONT}`
  ctx.fillText('POS', M + badge / 2, heroTop + 80)
  const posText = model.position ? String(model.position) : '–'
  const posSize = fitFont(ctx, posText, badge - 64, 216, 96)
  ctx.font = `800 ${posSize}px ${MONO}`
  ctx.textBaseline = 'middle'
  ctx.fillText(posText, M + badge / 2, heroTop + badge / 2 + 34)
  ctx.textBaseline = 'alphabetic'
  if (model.totalKarts) {
    ctx.font = `600 32px ${FONT}`
    ctx.fillText(`of ${model.totalKarts}`, M + badge / 2, heroTop + badge - 36)
  }

  // Team name + kart chip to the right of the badge.
  const tx = M + badge + 44
  const tw = STORY_W - M - tx
  ctx.textAlign = 'left'
  ctx.fillStyle = ACCENT
  ctx.font = `800 30px ${FONT}`
  ctx.fillText('TEAM', tx, heroTop + 46)
  // Kart chip
  const chipY = heroTop + 64
  ctx.font = `700 30px ${MONO}`
  const chipLabel = `#${model.kart || '—'}`
  const chipW = ctx.measureText(chipLabel).width + 36
  roundRect(ctx, tx, chipY, chipW, 52, 12)
  ctx.fillStyle = `rgba(${ar},${ag},${ab},0.24)`
  ctx.fill()
  ctx.fillStyle = WHITE
  ctx.textBaseline = 'middle'
  ctx.fillText(chipLabel, tx + 18, chipY + 27)
  ctx.textBaseline = 'alphabetic'
  // Team name — up to two auto-shrunk lines, block-centred under the label.
  const nameUpper = model.teamName.toUpperCase()
  const { lines, size: nameSize, lineH } = layoutName(ctx, nameUpper, tw, 84, 44)
  ctx.fillStyle = WHITE
  ctx.font = `800 ${nameSize}px ${FONT}`
  const nameArea = heroTop + 150 // below the label + chip
  const nameBlockH = lines.length * lineH
  let ny = nameArea + (badge - 150 - nameBlockH) / 2 + nameSize
  for (const line of lines) {
    ctx.fillText(line, tx, ny)
    ny += lineH
  }
  ctx.restore()

  // ---- Stats cards ----
  if (stats.length) {
    const cols = stats.length
    const cardGap = 20
    const cardsTop = heroTop + badge + heroStatsGap
    const cardW = (maxW - (cols - 1) * cardGap) / cols
    stats.forEach((st, i) => {
      const appear = Math.max(0, Math.min(1, (reveal - 0.2) * 1.6 - i * 0.12))
      const ce = 1 - Math.pow(1 - appear, 3)
      if (ce <= 0) return
      ctx.save()
      ctx.globalAlpha = ce
      ctx.translate(0, (1 - ce) * 30)
      const x = M + i * (cardW + cardGap)
      roundRect(ctx, x, cardsTop, cardW, cardH, 20)
      ctx.fillStyle = 'rgba(16, 19, 29, 0.86)'
      ctx.fill()
      roundRect(ctx, x, cardsTop, cardW, 8, 4)
      ctx.fillStyle = ACCENT
      ctx.fill()
      ctx.textAlign = 'center'
      ctx.fillStyle = WHITE
      const vSize = fitFont(ctx, st.value, cardW - 32, 60, 30, 800)
      ctx.font = `800 ${vSize}px ${MONO}`
      ctx.fillText(st.value, x + cardW / 2, cardsTop + cardH / 2 + 12)
      ctx.fillStyle = GREY
      ctx.font = `600 26px ${FONT}`
      ctx.fillText(fitText(ctx, st.caption, cardW - 24), x + cardW / 2, cardsTop + cardH - 30)
      ctx.restore()
    })
  }

  // ---- Footer: WeRace wordmark + link, tinted for contrast ----
  const lum = regionLuminance(ctx, 0, footerTop, STORY_W, SAFE_BOTTOM - footerTop)
  const dark = lum == null ? true : lum < 0.55
  const footerColor = dark ? WHITE : BLACK
  const logo = dark ? logos.white : logos.black
  const logoH = 46
  const logoW = logoH * (WERACE_LOGO_VIEWBOX.w / WERACE_LOGO_VIEWBOX.h)
  const fy = footerTop + 24
  if (logo) {
    ctx.globalAlpha = 1
    ctx.drawImage(logo, M, fy, logoW, logoH)
  } else {
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = footerColor
    ctx.font = `800 40px ${FONT}`
    ctx.fillText('WeRace', M, fy + logoH / 2)
  }
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = footerColor
  ctx.font = `700 34px ${FONT}`
  ctx.fillText(model.footerText, STORY_W - M, fy + logoH / 2)

  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.globalAlpha = 1
}
