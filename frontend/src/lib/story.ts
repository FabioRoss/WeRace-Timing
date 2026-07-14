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

const RED = '#e10600'
const BLACK = '#0b0d14'
const WHITE = '#f4f6fb'
const GREY = '#b9c0d4'
const FONT = "'Segoe UI', Inter, system-ui, sans-serif"
const MONO = "ui-monospace, 'SF Mono', 'Roboto Mono', monospace"

export interface StoryRow {
  pos: number
  kart: string
  name: string
  best: string
  gap: string
}

export interface StoryModel {
  title: string
  subtitle: string
  rows: StoryRow[]
  fastestKart: string
  fastestLap: string
}

export interface StoryOptions {
  topN: number
  title?: string   // overrides the event name; blank falls back to it
}

export function buildStoryModel(snapshot: Snapshot | null, opts: StoryOptions): StoryModel {
  const drivers = snapshot?.drivers ?? []
  const rows: StoryRow[] = drivers.slice(0, opts.topN).map((d, i) => ({
    pos: d.position || i + 1,
    kart: d.kart_no,
    name: d.name || `Kart ${d.kart_no}`,
    best: fmtLap(d.best_lap_ms),
    gap: (d.position || i + 1) === 1 ? 'LEADER' : fmtGap(d.gap_leader),
  }))
  const title = opts.title?.trim() || snapshot?.race.event_name || 'Race Result'
  return {
    title,
    subtitle: snapshot?.race.track_name || '',
    rows,
    fastestKart: snapshot?.session_best_kart ?? '',
    fastestLap: snapshot?.session_best_ms ? fmtLap(snapshot.session_best_ms) : '',
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
) {
  ctx.clearRect(0, 0, STORY_W, STORY_H)

  // Base + optional background (cover-fit) + legibility scrim.
  ctx.fillStyle = BLACK
  ctx.fillRect(0, 0, STORY_W, STORY_H)
  if (background) {
    const bw = (background as { width?: number }).width ?? STORY_W
    const bh = (background as { height?: number }).height ?? STORY_H
    const scale = Math.max(STORY_W / bw, STORY_H / bh)
    const dw = bw * scale
    const dh = bh * scale
    ctx.drawImage(background, (STORY_W - dw) / 2, (STORY_H - dh) / 2, dw, dh)
    ctx.fillStyle = 'rgba(7, 8, 12, 0.74)'
    ctx.fillRect(0, 0, STORY_W, STORY_H)
  } else {
    // Subtle red glow top-left when there's no photo behind.
    const grad = ctx.createRadialGradient(180, 340, 60, 180, 340, 900)
    grad.addColorStop(0, 'rgba(225, 6, 0, 0.22)')
    grad.addColorStop(1, 'rgba(225, 6, 0, 0)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, STORY_W, STORY_H)
  }

  const M = 70 // side margin
  const maxW = STORY_W - 2 * M

  // ---- Header (laid out dynamically so long titles never overlap) ----
  drawChecker(ctx, M, SAFE_TOP, 240, 26, 26)
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = RED
  ctx.font = `800 34px ${FONT}`
  ctx.fillText('RACE CLASSIFICATION', M, SAFE_TOP + 78)

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
    roundRect(ctx, M, y, STORY_W - 2 * M, barH, 16)
    ctx.fillStyle = leader ? 'rgba(225, 6, 0, 0.92)' : 'rgba(16, 19, 29, 0.86)'
    ctx.fill()
    // Left accent
    roundRect(ctx, M, y, 12, barH, 6)
    ctx.fillStyle = leader ? WHITE : RED
    ctx.fill()

    const cy = y + barH / 2
    ctx.textBaseline = 'middle'
    // Position
    ctx.fillStyle = WHITE
    ctx.font = `800 ${Math.round(barH * 0.5)}px ${MONO}`
    ctx.textAlign = 'center'
    ctx.fillText(String(row.pos), M + 70, cy)
    // Kart number chip
    ctx.textAlign = 'left'
    ctx.fillStyle = leader ? 'rgba(255,255,255,0.25)' : 'rgba(225,6,0,0.22)'
    roundRect(ctx, M + 120, cy - barH * 0.28, 96, barH * 0.56, 10)
    ctx.fill()
    ctx.fillStyle = WHITE
    ctx.font = `700 ${Math.round(barH * 0.3)}px ${MONO}`
    ctx.textAlign = 'center'
    ctx.fillText(row.kart, M + 168, cy)
    // Name
    ctx.textAlign = 'left'
    ctx.fillStyle = WHITE
    ctx.font = `700 ${Math.round(barH * 0.34)}px ${FONT}`
    const name = fitText(ctx, row.name.toUpperCase(), 430)
    ctx.fillText(name, M + 240, cy)
    // Best lap / gap (right)
    ctx.textAlign = 'right'
    ctx.fillStyle = leader ? WHITE : GREY
    ctx.font = `600 ${Math.round(barH * 0.3)}px ${MONO}`
    const right = STORY_W - M - 24
    ctx.fillText(row.best, right, cy - barH * 0.16)
    ctx.fillStyle = leader ? 'rgba(255,255,255,0.85)' : 'rgba(185,192,212,0.7)'
    ctx.font = `500 ${Math.round(barH * 0.22)}px ${FONT}`
    ctx.fillText(row.gap, right, cy + barH * 0.22)
    ctx.restore()
  })

  // ---- Fastest lap footer ----
  if (model.fastestLap) {
    const fy = SAFE_BOTTOM - 110
    roundRect(ctx, M, fy, STORY_W - 2 * M, 96, 16)
    ctx.fillStyle = RED
    ctx.fill()
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.font = `800 30px ${FONT}`
    ctx.fillText('FASTEST LAP', M + 34, fy + 48)
    ctx.textAlign = 'right'
    ctx.fillStyle = WHITE
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
