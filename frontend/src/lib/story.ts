// Client-side renderer for the Instagram-story export. Everything here draws
// onto a 1080x1920 canvas with pure Canvas 2D — no server round-trip, so an
// uploaded background never leaves the browser. The same draw function feeds
// the live preview, the PNG snapshot and the MediaRecorder video.
import type { Snapshot } from './types'
import { fmtLap, fmtGap } from './format'

export const STORY_W = 1080
export const STORY_H = 1920
// Instagram reserves the top (profile/close) and bottom (reply bar) of a story.
// Keep all content inside this central band.
export const SAFE_TOP = 250
export const SAFE_BOTTOM = 1660

const BLACK = '#0b0d14'
const WHITE = '#f4f6fb'
const GREY = '#b9c0d4'
const FONT = "'Segoe UI', Inter, system-ui, sans-serif"
const MONO = "ui-monospace, 'SF Mono', 'Roboto Mono', monospace"

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const n = parseInt(h, 16)
  return Number.isNaN(n) ? [225, 6, 0] : [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Text colour that reads on a given accent fill (white on dark, ink on light). */
function accentTextOn([r, g, b]: [number, number, number]): string {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.6 ? WHITE : BLACK
}

export type StoryStat = 'best' | 'gap' | 'interval' | 'pits'

export interface StoryRow {
  pos: number
  kart: string
  name: string
  statValue: string    // the chosen metric, shown large
  statCaption: string  // its label (BEST LAP / TO LEADER / INTERVAL), shown small
}

export interface StoryModel {
  label: string       // kicker above the title (session type), e.g. "RACE"
  title: string
  subtitle: string
  rows: StoryRow[]
  pageLabel: string   // "POS 11–20" for multi-page; "" when the whole field fits
  fastestKart: string
  fastestLap: string
}

/** How the background photo is framed behind the card. `scale` multiplies the
 * base cover-fit (1 == fills the frame like before); `x`/`y` pan in canvas px;
 * `rot` rotates in degrees. The default is exactly the old cover-fit. */
export interface BgTransform {
  scale: number
  x: number
  y: number
  rot: number
}

export const DEFAULT_BG_TRANSFORM: BgTransform = { scale: 1, x: 0, y: 0, rot: 0 }

/** Constrain a background transform so the image always fully covers the WxH
 * frame — no empty corners. Zoom is raised to the minimum the current rotation
 * needs (auto-zoom-to-fill), then panning is clamped so no edge enters the
 * frame. Pure + framework-free so it can be unit-tested directly. */
export function clampBgTransform(
  bw: number, bh: number, W: number, H: number, t: BgTransform,
): BgTransform {
  const cover = Math.max(W / bw, H / bh)
  const th = (t.rot * Math.PI) / 180
  const c = Math.abs(Math.cos(th))
  const s = Math.abs(Math.sin(th))
  // Canvas extent projected onto the image's rotated axes.
  const cwU = W * c + H * s
  const cwV = W * s + H * c
  // Smallest scale that still covers the frame at this rotation (== 1 at rot 0).
  const sMin = Math.max(cwU / (bw * cover), cwV / (bh * cover))
  const scale = Math.min(Math.max(t.scale, sMin), Math.max(5, sMin))
  const dw = bw * cover * scale
  const dh = bh * cover * scale
  // Pan offset in rotated coords, each bounded by the cover slack on that axis.
  const cos = Math.cos(th)
  const sin = Math.sin(th)
  const a = clamp(t.x * cos + t.y * sin, (dw - cwU) / 2)
  const b = clamp(-t.x * sin + t.y * cos, (dh - cwV) / 2)
  return { scale, x: a * cos - b * sin, y: a * sin + b * cos, rot: t.rot }
}

function clamp(v: number, lim: number): number {
  const m = Math.max(0, lim)
  return Math.min(m, Math.max(-m, v))
}

export interface StoryOptions {
  perPage: number       // standings rows per page
  pageIndex?: number    // 0-based page to render
  title?: string        // overrides the event name; blank falls back to it
  stat?: StoryStat      // which metric each kart shows (default 'best')
  label?: string        // kicker (session type); blank falls back to 'Race'
  showFastest?: boolean // draw the fastest-lap footer (default true)
}

/** How many pages the whole field spans at `perPage` rows each (min 1). */
export function storyPageCount(snapshot: Snapshot | null, perPage: number): number {
  const n = snapshot?.drivers.length ?? 0
  return Math.max(1, Math.ceil(n / Math.max(1, perPage)))
}

export function buildStoryModel(snapshot: Snapshot | null, opts: StoryOptions): StoryModel {
  const drivers = snapshot?.drivers ?? []
  const perPage = Math.max(1, opts.perPage)
  const pageCount = Math.max(1, Math.ceil(drivers.length / perPage))
  const page = Math.min(Math.max(0, opts.pageIndex ?? 0), pageCount - 1)
  const start = page * perPage
  const slice = drivers.slice(start, start + perPage)
  const stat = opts.stat ?? 'best'
  const rows: StoryRow[] = slice.map((d, i) => {
    const pos = d.position || start + i + 1
    const isLeader = pos === 1
    let statValue: string
    let statCaption: string
    if (stat === 'best') {
      statValue = fmtLap(d.best_lap_ms)
      statCaption = 'BEST LAP'
    } else if (stat === 'gap') {
      statValue = isLeader ? 'LEADER' : fmtGap(d.gap_leader)
      statCaption = isLeader ? '' : 'TO LEADER'
    } else if (stat === 'pits') {
      statValue = String(d.pits ?? 0)
      statCaption = 'PIT STOPS'
    } else {
      statValue = isLeader ? 'LEADER' : fmtGap(d.gap_ahead)
      statCaption = isLeader ? '' : 'INTERVAL'
    }
    return { pos, kart: d.kart_no, name: d.name || `Kart ${d.kart_no}`, statValue, statCaption }
  })
  const title = opts.title?.trim() || snapshot?.race.event_name || 'Race Result'
  const pageLabel =
    pageCount > 1 && rows.length ? `POS ${rows[0].pos}–${rows[rows.length - 1].pos}` : ''
  const showFastest = opts.showFastest ?? true
  return {
    label: opts.label?.trim() || 'Race',
    title,
    subtitle: snapshot?.race.track_name || '',
    rows,
    pageLabel,
    // Clearing these hides the footer AND reclaims its row space in drawStory.
    fastestKart: showFastest ? (snapshot?.session_best_kart ?? '') : '',
    fastestLap: showFastest && snapshot?.session_best_ms ? fmtLap(snapshot.session_best_ms) : '',
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

/** Draw the whole story. `reveal` is how many standings rows are shown
 * (fractional for the row currently sliding in); pass rows.length for a
 * fully-revealed still. `background` is optional and drawn cover-fit. */
export function drawStory(
  ctx: CanvasRenderingContext2D,
  model: StoryModel,
  reveal: number,
  background: CanvasImageSource | null,
  accent: string = '#e10600',
  bgTransform: BgTransform = DEFAULT_BG_TRANSFORM,
) {
  const [ar, ag, ab] = hexToRgb(accent)
  const ACCENT = `rgb(${ar}, ${ag}, ${ab})`
  const ACCENT_TEXT = accentTextOn([ar, ag, ab])
  // Kart chip on the (accent-filled) leader row: a subtle contrast overlay.
  const LEADER_CHIP = ACCENT_TEXT === WHITE ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.14)'
  ctx.clearRect(0, 0, STORY_W, STORY_H)

  // Base + optional background (cover-fit) + legibility scrim.
  ctx.fillStyle = BLACK
  ctx.fillRect(0, 0, STORY_W, STORY_H)
  if (background) {
    const bw = (background as { width?: number }).width ?? STORY_W
    const bh = (background as { height?: number }).height ?? STORY_H
    // Base cover-fit, then the user's zoom / pan / rotate on top of it.
    const cover = Math.max(STORY_W / bw, STORY_H / bh)
    const s = cover * Math.max(0.05, bgTransform.scale)
    ctx.save()
    ctx.translate(STORY_W / 2 + bgTransform.x, STORY_H / 2 + bgTransform.y)
    ctx.rotate((bgTransform.rot * Math.PI) / 180)
    ctx.scale(s, s)
    ctx.drawImage(background, -bw / 2, -bh / 2, bw, bh)
    ctx.restore()
    ctx.fillStyle = 'rgba(7, 8, 12, 0.74)'
    ctx.fillRect(0, 0, STORY_W, STORY_H)
  } else {
    // Subtle accent glow top-left when there's no photo behind.
    const grad = ctx.createRadialGradient(180, 340, 60, 180, 340, 900)
    grad.addColorStop(0, `rgba(${ar}, ${ag}, ${ab}, 0.22)`)
    grad.addColorStop(1, `rgba(${ar}, ${ag}, ${ab}, 0)`)
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, STORY_W, STORY_H)
  }

  const M = 70 // side margin
  const maxW = STORY_W - 2 * M

  // ---- Header (laid out dynamically so long titles never overlap) ----
  drawChecker(ctx, M, SAFE_TOP, 240, 26, 26)
  ctx.textBaseline = 'alphabetic'
  // Reserve room for the page chip (drawn below) so a long kicker never overlaps it.
  let kickerMaxW = maxW
  if (model.pageLabel) {
    ctx.font = `800 30px ${FONT}`
    kickerMaxW = maxW - (ctx.measureText(model.pageLabel).width + 44) - 24
  }
  ctx.fillStyle = ACCENT
  ctx.font = `800 34px ${FONT}`
  ctx.fillText(fitText(ctx, model.label.toUpperCase(), kickerMaxW), M, SAFE_TOP + 78)

  // Page range chip (multi-page grid), right-aligned on the label baseline.
  if (model.pageLabel) {
    ctx.font = `800 30px ${FONT}`
    const tw = ctx.measureText(model.pageLabel).width
    const chipW = tw + 44
    const chipX = STORY_W - M - chipW
    roundRect(ctx, chipX, SAFE_TOP + 50, chipW, 44, 10)
    ctx.fillStyle = ACCENT
    ctx.fill()
    ctx.fillStyle = ACCENT_TEXT
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(model.pageLabel, chipX + chipW / 2, SAFE_TOP + 73)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
  }

  // Title: auto-shrink until it fits in <= 2 lines, then wrap.
  const { lines, size, lineH } = layoutTitle(ctx, model.title.toUpperCase(), maxW)
  ctx.fillStyle = WHITE
  ctx.font = `800 ${size}px ${FONT}`
  let ty = SAFE_TOP + 96 + size
  for (const line of lines) {
    ctx.fillText(line, M, ty)
    ty += lineH
  }
  let headerBottom = ty - lineH + 12
  if (model.subtitle) {
    ctx.fillStyle = GREY
    ctx.font = `500 38px ${FONT}`
    headerBottom += 44
    ctx.fillText(model.subtitle, M, headerBottom)
  }

  // ---- Standings ----
  const listTop = headerBottom + 40
  const listBottom = model.fastestLap ? SAFE_BOTTOM - 150 : SAFE_BOTTOM - 20
  const n = Math.max(model.rows.length, 1)
  const rowH = Math.min(112, (listBottom - listTop) / n)
  const gap = Math.min(12, rowH * 0.14)
  const barH = rowH - gap

  model.rows.forEach((row, i) => {
    const appear = Math.max(0, Math.min(1, reveal - i))
    if (appear <= 0) return
    const eased = 1 - Math.pow(1 - appear, 3) // easeOutCubic
    const y = listTop + i * rowH
    const slide = (1 - eased) * 60
    ctx.save()
    ctx.globalAlpha = eased
    ctx.translate(slide, 0)

    const leader = row.pos === 1
    const nameText = leader ? ACCENT_TEXT : WHITE
    roundRect(ctx, M, y, STORY_W - 2 * M, barH, 16)
    ctx.fillStyle = leader ? `rgba(${ar}, ${ag}, ${ab}, 0.92)` : 'rgba(16, 19, 29, 0.86)'
    ctx.fill()
    // Left accent
    roundRect(ctx, M, y, 12, barH, 6)
    ctx.fillStyle = leader ? ACCENT_TEXT : ACCENT
    ctx.fill()

    const cy = y + barH / 2
    ctx.textBaseline = 'middle'
    // Position
    ctx.fillStyle = nameText
    ctx.font = `800 ${Math.round(barH * 0.5)}px ${MONO}`
    ctx.textAlign = 'center'
    ctx.fillText(String(row.pos), M + 70, cy)
    // Kart number chip
    ctx.textAlign = 'left'
    ctx.fillStyle = leader ? LEADER_CHIP : `rgba(${ar},${ag},${ab},0.22)`
    roundRect(ctx, M + 120, cy - barH * 0.28, 96, barH * 0.56, 10)
    ctx.fill()
    ctx.fillStyle = nameText
    ctx.font = `700 ${Math.round(barH * 0.3)}px ${MONO}`
    ctx.textAlign = 'center'
    ctx.fillText(row.kart, M + 168, cy)
    // Name
    ctx.textAlign = 'left'
    ctx.fillStyle = nameText
    ctx.font = `700 ${Math.round(barH * 0.34)}px ${FONT}`
    const name = fitText(ctx, row.name.toUpperCase(), 430)
    ctx.fillText(name, M + 240, cy)
    // Chosen stat (right): big value + small caption
    ctx.textAlign = 'right'
    const right = STORY_W - M - 24
    if (row.statCaption) {
      ctx.fillStyle = leader ? ACCENT_TEXT : GREY
      ctx.font = `600 ${Math.round(barH * 0.3)}px ${MONO}`
      ctx.fillText(row.statValue, right, cy - barH * 0.16)
      ctx.fillStyle = leader ? ACCENT_TEXT : 'rgba(185,192,212,0.7)'
      ctx.font = `500 ${Math.round(barH * 0.2)}px ${FONT}`
      ctx.fillText(row.statCaption, right, cy + barH * 0.24)
    } else {
      // No caption (e.g. LEADER in gap/interval mode): center the value.
      ctx.fillStyle = leader ? ACCENT_TEXT : GREY
      ctx.font = `700 ${Math.round(barH * 0.3)}px ${MONO}`
      ctx.fillText(row.statValue, right, cy)
    }
    ctx.restore()
  })

  // ---- Fastest lap footer ----
  if (model.fastestLap) {
    const fy = SAFE_BOTTOM - 110
    roundRect(ctx, M, fy, STORY_W - 2 * M, 96, 16)
    ctx.fillStyle = ACCENT
    ctx.fill()
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.fillStyle = ACCENT_TEXT
    ctx.font = `800 30px ${FONT}`
    ctx.fillText('FASTEST LAP', M + 34, fy + 48)
    ctx.textAlign = 'right'
    ctx.fillStyle = ACCENT_TEXT
    ctx.font = `800 44px ${MONO}`
    ctx.fillText(`#${model.fastestKart}  ${model.fastestLap}`, STORY_W - M - 34, fy + 48)
  }
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
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

/** Pick a title font size that fits the text in at most two lines. */
function layoutTitle(
  ctx: CanvasRenderingContext2D, text: string, maxW: number,
): { lines: string[]; size: number; lineH: number } {
  for (let size = 64; size >= 40; size -= 4) {
    ctx.font = `800 ${size}px ${FONT}`
    const lines = wrapLines(ctx, text, maxW)
    if (lines.length <= 2 || size === 40) {
      return { lines: lines.slice(0, 3), size, lineH: Math.round(size * 1.05) }
    }
  }
  ctx.font = `800 40px ${FONT}`
  return { lines: wrapLines(ctx, text, maxW).slice(0, 3), size: 40, lineH: 42 }
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text
  let t = text
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1)
  return `${t}…`
}

/** Best MediaRecorder mime for a video story, preferring MP4 (Instagram's
 * format, recordable natively on iOS Safari) then WebM. null = unsupported. */
export function pickVideoMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  const candidates = [
    'video/mp4;codecs=h264',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ]
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c
  }
  return null
}

export function mimeExtension(mime: string): string {
  return mime.startsWith('video/mp4') ? 'mp4' : 'webm'
}

/** Trigger a browser download for a Blob without any server involvement. */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}
