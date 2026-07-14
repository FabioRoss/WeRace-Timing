import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Snapshot } from '../lib/types'
import {
  STORY_W, STORY_H, buildStoryModel, drawStory, pickVideoMime, mimeExtension, downloadBlob,
} from '../lib/story'

type Mode = 'image' | 'video'

const REVEAL_MS = 320   // per standings row
const HOLD_MS = 1600    // pause on the full board at the end

export function StoryStudio({ snapshot }: { snapshot: Snapshot | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [topN, setTopN] = useState(10)
  const [mode, setMode] = useState<Mode>('image')
  const [bg, setBg] = useState<CanvasImageSource | null>(null)
  const [bgName, setBgName] = useState('')
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const model = useMemo(() => buildStoryModel(snapshot, topN), [snapshot, topN])
  const videoMime = useMemo(() => pickVideoMime(), [])
  const hasData = model.rows.length > 0

  // Live preview: fully-revealed still.
  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d')
    if (ctx) drawStory(ctx, model, model.rows.length, bg)
  }, [model, bg])

  const onPickBackground = useCallback(async (file: File | undefined) => {
    setError('')
    if (!file) return
    try {
      const bitmap = await createImageBitmap(file)
      setBg(bitmap)
      setBgName(file.name)
    } catch {
      setError('Could not read that image.')
    }
  }, [])

  const clearBackground = useCallback(() => {
    setBg(null)
    setBgName('')
  }, [])

  const downloadPng = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    drawStory(ctx, model, model.rows.length, bg)
    canvas.toBlob((blob) => {
      if (blob) downloadBlob(blob, `story-${stamp()}.png`)
    }, 'image/png')
  }, [model, bg])

  const recordVideo = useCallback(async () => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx || !videoMime) return
    setError('')
    setRecording(true)
    setBusy(true)
    try {
      const stream = canvas.captureStream(30)
      const recorder = new MediaRecorder(stream, {
        mimeType: videoMime,
        videoBitsPerSecond: 8_000_000,
      })
      const chunks: BlobPart[] = []
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
      const done = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve()
      })
      recorder.start()

      const total = model.rows.length * REVEAL_MS + HOLD_MS
      const start = performance.now()
      await new Promise<void>((resolve) => {
        const tick = () => {
          const t = performance.now() - start
          const reveal = Math.min(model.rows.length, t / REVEAL_MS)
          drawStory(ctx, model, reveal, bg)
          if (t >= total) resolve()
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      recorder.stop()
      await done
      const blob = new Blob(chunks, { type: videoMime })
      downloadBlob(blob, `story-${stamp()}.${mimeExtension(videoMime)}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Recording failed.')
    } finally {
      // Restore the static preview.
      drawStory(ctx, model, model.rows.length, bg)
      setRecording(false)
      setBusy(false)
    }
  }, [model, bg, videoMime])

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
            Red / black / white standings card sized for Stories. Download a still image or
            an animated clip where the positions build up one by one.
          </p>
        </div>

        <Field label="Positions to show">
          <select
            value={topN}
            onChange={(e) => setTopN(Number(e.target.value))}
            className="rounded bg-pit-950 px-3 py-2 text-sm ring-1 ring-pit-600 focus:ring-race-red"
          >
            {[3, 5, 8, 10, 12].map((n) => (
              <option key={n} value={n}>Top {n}</option>
            ))}
          </select>
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
          {videoMime && mode === 'video' && (
            <p className="mt-1 text-[0.65rem] text-ink-500">
              Recording as {mimeExtension(videoMime).toUpperCase()}.
            </p>
          )}
        </Field>

        <div className="flex items-center gap-3">
          {mode === 'image' ? (
            <button
              type="button"
              onClick={downloadPng}
              disabled={!hasData || busy}
              className="rounded bg-race-red px-4 py-2 text-sm font-bold uppercase tracking-wider text-white hover:brightness-110 disabled:opacity-40"
            >
              Download PNG
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void recordVideo()}
              disabled={!hasData || busy || !videoMime}
              className="rounded bg-race-red px-4 py-2 text-sm font-bold uppercase tracking-wider text-white hover:brightness-110 disabled:opacity-40"
            >
              {recording ? 'Recording…' : 'Record & download'}
            </button>
          )}
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
