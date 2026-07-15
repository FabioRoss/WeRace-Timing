import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Snapshot } from '../lib/types'
import {
  STORY_W, STORY_H, buildStoryModel, storyPageCount, drawStory, pickVideoMime,
  mimeExtension, downloadBlob, DEFAULT_BG_TRANSFORM,
  type StoryModel, type StoryStat, type BgTransform,
} from '../lib/story'
import { AccentPicker, DEFAULT_ACCENT } from './AccentPicker'

type Mode = 'image' | 'video'
type VideoScope = 'page' | 'all'

const REVEAL_MS = 320   // per standings row
const HOLD_MS = 1600    // pause on a full page before the clip/page ends

/** Animate one page's rows revealing in, then hold. Resolves when done. */
function animatePage(
  ctx: CanvasRenderingContext2D, model: StoryModel, bg: CanvasImageSource | null,
  accent: string, bgTransform: BgTransform,
): Promise<void> {
  return new Promise((resolve) => {
    const total = model.rows.length * REVEAL_MS + HOLD_MS
    const start = performance.now()
    const tick = () => {
      const t = performance.now() - start
      drawStory(ctx, model, Math.min(model.rows.length, t / REVEAL_MS), bg, accent, bgTransform)
      if (t >= total) resolve()
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

export function StoryStudio({ snapshot }: { snapshot: Snapshot | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [perPage, setPerPage] = useState(10)
  const [pageIndex, setPageIndex] = useState(0)
  const [title, setTitle] = useState('')
  const [stat, setStat] = useState<StoryStat>('best')
  const [accent, setAccent] = useState(DEFAULT_ACCENT)
  const [mode, setMode] = useState<Mode>('image')
  const [videoScope, setVideoScope] = useState<VideoScope>('page')
  const [bg, setBg] = useState<CanvasImageSource | null>(null)
  const [bgName, setBgName] = useState('')
  const [bgTransform, setBgTransform] = useState<BgTransform>(DEFAULT_BG_TRANSFORM)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')

  // Seed the title once from the live event name, then let the user own it.
  const titleSeeded = useRef(false)
  useEffect(() => {
    if (titleSeeded.current) return
    const name = snapshot?.race.event_name
    if (name) {
      setTitle(name)
      titleSeeded.current = true
    }
  }, [snapshot])

  const pageCount = useMemo(() => storyPageCount(snapshot, perPage), [snapshot, perPage])
  const model = useMemo(
    () => buildStoryModel(snapshot, { perPage, pageIndex, title, stat }),
    [snapshot, perPage, pageIndex, title, stat],
  )
  const videoMime = useMemo(() => pickVideoMime(), [])
  const hasData = model.rows.length > 0

  // Keep the current page in range when the field or page size changes.
  useEffect(() => {
    if (pageIndex > pageCount - 1) setPageIndex(pageCount - 1)
  }, [pageCount, pageIndex])

  // Live preview: fully-revealed still of the current page.
  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d')
    if (ctx) drawStory(ctx, model, model.rows.length, bg, accent, bgTransform)
  }, [model, bg, accent, bgTransform])

  const onPickBackground = useCallback(async (file: File | undefined) => {
    setError('')
    if (!file) return
    try {
      const bitmap = await createImageBitmap(file)
      setBg(bitmap)
      setBgName(file.name)
      setBgTransform(DEFAULT_BG_TRANSFORM) // fresh frame starts cover-fit
    } catch {
      setError('Could not read that image.')
    }
  }, [])

  const clearBackground = useCallback(() => {
    setBg(null)
    setBgName('')
    setBgTransform(DEFAULT_BG_TRANSFORM)
  }, [])

  const restorePreview = useCallback(() => {
    const ctx = canvasRef.current?.getContext('2d')
    if (ctx) drawStory(ctx, model, model.rows.length, bg, accent, bgTransform)
  }, [model, bg, accent, bgTransform])

  const downloadPng = useCallback(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    drawStory(ctx, model, model.rows.length, bg, accent, bgTransform)
    canvas.toBlob((blob) => {
      if (blob) downloadBlob(blob, `story-p${pageIndex + 1}-${stamp()}.png`)
    }, 'image/png')
  }, [model, bg, accent, bgTransform, pageIndex])

  const downloadAllPages = useCallback(async () => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    setBusy(true)
    setError('')
    try {
      for (let p = 0; p < pageCount; p++) {
        setProgress(`Page ${p + 1} / ${pageCount}`)
        const m = buildStoryModel(snapshot, { perPage, pageIndex: p, title, stat })
        drawStory(ctx, m, m.rows.length, bg, accent, bgTransform)
        const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
        if (blob) downloadBlob(blob, `story-p${p + 1}-${stamp()}.png`)
        await new Promise((r) => setTimeout(r, 200))
      }
    } finally {
      setProgress('')
      setBusy(false)
      restorePreview()
    }
  }, [snapshot, perPage, title, stat, bg, accent, bgTransform, pageCount, restorePreview])

  const recordVideo = useCallback(async () => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx || !videoMime) return
    setError('')
    setBusy(true)
    try {
      const stream = canvas.captureStream(30)
      const recorder = new MediaRecorder(stream, {
        mimeType: videoMime,
        videoBitsPerSecond: 8_000_000,
      })
      const chunks: BlobPart[] = []
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
      const done = new Promise<void>((resolve) => { recorder.onstop = () => resolve() })
      recorder.start()

      const pages = videoScope === 'all'
        ? Array.from({ length: pageCount }, (_, p) => p)
        : [pageIndex]
      for (const p of pages) {
        setProgress(pages.length > 1 ? `Recording page ${p + 1} / ${pageCount}` : 'Recording…')
        const m = buildStoryModel(snapshot, { perPage, pageIndex: p, title, stat })
        await animatePage(ctx, m, bg, accent, bgTransform)
      }
      recorder.stop()
      await done
      const blob = new Blob(chunks, { type: videoMime })
      const suffix = videoScope === 'all' ? 'all' : `p${pageIndex + 1}`
      downloadBlob(blob, `story-${suffix}-${stamp()}.${mimeExtension(videoMime)}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Recording failed.')
    } finally {
      setProgress('')
      setBusy(false)
      restorePreview()
    }
  }, [snapshot, perPage, pageIndex, title, stat, bg, accent, bgTransform, videoMime, videoScope, pageCount, restorePreview])

  // Drag the preview to pan the background. Pointer deltas are in on-screen px;
  // scale them to canvas px so a drag tracks the cursor 1:1.
  const drag = useRef<{ x: number; y: number } | null>(null)
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!bg) return
    drag.current = { x: e.clientX, y: e.clientY }
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [bg])
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag.current) return
    const k = STORY_W / e.currentTarget.clientWidth
    const dx = (e.clientX - drag.current.x) * k
    const dy = (e.clientY - drag.current.y) * k
    drag.current = { x: e.clientX, y: e.clientY }
    setBgTransform((t) => ({ ...t, x: t.x + dx, y: t.y + dy }))
  }, [])
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    drag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }, [])
  const onWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!bg) return
    const factor = Math.exp(-e.deltaY * 0.0015)
    setBgTransform((t) => ({ ...t, scale: clampScale(t.scale * factor) }))
  }, [bg])

  return (
    <div className="grid gap-6 md:grid-cols-[300px_1fr]">
      {/* Preview */}
      <div>
        <canvas
          ref={canvasRef}
          width={STORY_W}
          height={STORY_H}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
          className={`w-full max-w-[280px] rounded-xl ring-1 ring-pit-700 ${bg ? 'cursor-move touch-none' : ''}`}
          style={{ aspectRatio: `${STORY_W} / ${STORY_H}` }}
        />
        {pageCount > 1 && (
          <div className="mt-2 flex items-center justify-center gap-3 text-sm">
            <button
              type="button"
              onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
              disabled={pageIndex === 0 || busy}
              className="rounded bg-pit-800 px-2 py-1 text-xs font-bold hover:bg-pit-700 disabled:opacity-40"
            >
              ◀
            </button>
            <span className="timing text-xs text-ink-300">
              Page {pageIndex + 1} / {pageCount}
            </span>
            <button
              type="button"
              onClick={() => setPageIndex((p) => Math.min(pageCount - 1, p + 1))}
              disabled={pageIndex >= pageCount - 1 || busy}
              className="rounded bg-pit-800 px-2 py-1 text-xs font-bold hover:bg-pit-700 disabled:opacity-40"
            >
              ▶
            </button>
          </div>
        )}
        <p className="mt-2 text-center text-[0.65rem] text-ink-500">
          1080 × 1920 · content kept inside Instagram's safe area
        </p>
      </div>

      {/* Controls */}
      <div className="max-w-lg space-y-5">
        <div className="rounded-xl bg-pit-900 p-4 ring-1 ring-pit-800">
          <h2 className="text-sm font-bold uppercase tracking-wider text-ink-300">
            Instagram story
          </h2>
          <p className="mt-1 text-sm text-ink-500">
            Black / white standings card sized for Stories with your accent colour. Post the
            whole grid across pages, as a still image or an animated clip where positions
            build up one by one.
          </p>
        </div>

        <Field label="Title">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Race Result"
            className="w-full rounded bg-pit-950 px-3 py-2 text-sm ring-1 ring-pit-600 focus:ring-race-red"
          />
        </Field>

        <Field label="Accent colour">
          <AccentPicker value={accent} onChange={setAccent} />
        </Field>

        <Field label="Right column">
          <select
            value={stat}
            onChange={(e) => setStat(e.target.value as StoryStat)}
            className="rounded bg-pit-950 px-3 py-2 text-sm ring-1 ring-pit-600 focus:ring-race-red"
          >
            <option value="best">Best lap</option>
            <option value="gap">Gap to leader</option>
            <option value="interval">Interval (to kart ahead)</option>
          </select>
        </Field>

        <Field label="Rows per page">
          <select
            value={perPage}
            onChange={(e) => setPerPage(Number(e.target.value))}
            className="rounded bg-pit-950 px-3 py-2 text-sm ring-1 ring-pit-600 focus:ring-race-red"
          >
            {[5, 8, 10, 12].map((n) => (
              <option key={n} value={n}>{n} per page</option>
            ))}
          </select>
          {pageCount > 1 && (
            <p className="mt-1 text-[0.65rem] text-ink-500">
              {snapshot?.drivers.length ?? 0} karts across {pageCount} pages.
            </p>
          )}
        </Field>

        <Field label="Background (optional)">
          <div className="space-y-1">
            <input
              type="file"
              accept="image/*"
              onChange={(e) => void onPickBackground(e.target.files?.[0])}
              className="block w-full text-sm text-ink-300 file:mr-3 file:rounded file:border-0 file:bg-pit-700 file:px-3 file:py-1.5 file:text-xs file:font-bold file:uppercase file:tracking-wider file:text-ink-100"
            />
            {bgName && (
              <div className="flex items-center gap-2 text-xs text-ink-500">
                <span className="truncate">{bgName}</span>
                <button type="button" onClick={clearBackground} className="text-race-red">
                  remove
                </button>
              </div>
            )}
            {bg && (
              <div className="space-y-2 rounded-lg bg-pit-950 p-3 ring-1 ring-pit-800">
                <div className="flex items-center justify-between">
                  <span className="label-race">Frame the photo</span>
                  <button
                    type="button"
                    onClick={() => setBgTransform(DEFAULT_BG_TRANSFORM)}
                    className="text-[0.7rem] font-bold uppercase tracking-wider text-ink-300 hover:text-ink-100"
                  >
                    Reset
                  </button>
                </div>
                <label className="block text-xs text-ink-400">
                  <span className="flex justify-between">
                    <span>Zoom</span>
                    <span className="timing">{bgTransform.scale.toFixed(2)}×</span>
                  </span>
                  <input
                    type="range" min={0.2} max={5} step={0.01}
                    value={bgTransform.scale}
                    onChange={(e) => setBgTransform((t) => ({ ...t, scale: Number(e.target.value) }))}
                    className="mt-1 w-full"
                  />
                </label>
                <label className="block text-xs text-ink-400">
                  <span className="flex justify-between">
                    <span>Rotate</span>
                    <span className="timing">{Math.round(bgTransform.rot)}°</span>
                  </span>
                  <input
                    type="range" min={-180} max={180} step={1}
                    value={bgTransform.rot}
                    onChange={(e) => setBgTransform((t) => ({ ...t, rot: Number(e.target.value) }))}
                    className="mt-1 w-full"
                  />
                </label>
                <p className="text-[0.65rem] text-ink-500">
                  Drag the preview to move · scroll to zoom.
                </p>
              </div>
            )}
            <p className="text-[0.65rem] text-ink-500">
              Stays in your browser — the image is never uploaded or stored on the server.
            </p>
          </div>
        </Field>

        <Field label="Format">
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="story-mode"
                checked={mode === 'image'}
                onChange={() => setMode('image')}
              />
              Static image (PNG)
            </label>
            <label className={`flex items-center gap-2 ${videoMime ? '' : 'opacity-40'}`}>
              <input
                type="radio"
                name="story-mode"
                checked={mode === 'video'}
                disabled={!videoMime}
                onChange={() => setMode('video')}
              />
              Animated video
            </label>
          </div>
          {!videoMime && (
            <p className="mt-1 text-[0.65rem] text-ink-500">
              This browser can't record video — PNG export is still available.
            </p>
          )}
          {videoMime && mode === 'video' && pageCount > 1 && (
            <div className="mt-2 flex gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="video-scope"
                  checked={videoScope === 'page'}
                  onChange={() => setVideoScope('page')}
                />
                This page
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="video-scope"
                  checked={videoScope === 'all'}
                  onChange={() => setVideoScope('all')}
                />
                All pages (one clip)
              </label>
            </div>
          )}
          {videoMime && mode === 'video' && (
            <p className="mt-1 text-[0.65rem] text-ink-500">
              Recording as {mimeExtension(videoMime).toUpperCase()}.
            </p>
          )}
        </Field>

        <div className="flex flex-wrap items-center gap-3">
          {mode === 'image' ? (
            <>
              <button
                type="button"
                onClick={downloadPng}
                disabled={!hasData || busy}
                className="rounded bg-race-red px-4 py-2 text-sm font-bold uppercase tracking-wider text-white hover:brightness-110 disabled:opacity-40"
              >
                Download PNG{pageCount > 1 ? ' (this page)' : ''}
              </button>
              {pageCount > 1 && (
                <button
                  type="button"
                  onClick={() => void downloadAllPages()}
                  disabled={!hasData || busy}
                  className="rounded bg-pit-700 px-4 py-2 text-sm font-bold uppercase tracking-wider text-ink-100 hover:bg-pit-600 disabled:opacity-40"
                >
                  Download all pages
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              onClick={() => void recordVideo()}
              disabled={!hasData || busy || !videoMime}
              className="rounded bg-race-red px-4 py-2 text-sm font-bold uppercase tracking-wider text-white hover:brightness-110 disabled:opacity-40"
            >
              {busy ? 'Recording…' : 'Record & download'}
            </button>
          )}
          {progress && <span className="text-xs text-ink-300">{progress}</span>}
          {!hasData && <span className="text-xs text-ink-500">No standings yet.</span>}
          {error && <span className="text-xs text-race-red">{error}</span>}
        </div>
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

function clampScale(s: number): number {
  return Math.min(5, Math.max(0.2, s))
}
