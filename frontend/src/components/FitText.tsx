import { useLayoutEffect, useRef, useState } from 'react'

let canvas: HTMLCanvasElement | null = null

/**
 * One line of text sized to fill its box: as large as `maxPx` allows, never
 * clipped and never "…". If the full text would drop below `minPx`, `short`
 * (e.g. a lap time cut to hundredths) is shown instead.
 */
export function FitText({ full, short, maxPx, minPx = 0, className = '' }: {
  full: string
  short?: string
  maxPx: number
  minPx?: number
  className?: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const span = useRef<HTMLSpanElement>(null)
  const [fit, setFit] = useState<{ size: number; text: string }>({ size: maxPx, text: full })

  useLayoutEffect(() => {
    const b = box.current
    const s = span.current
    if (!b || !s) return
    canvas ??= document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    const measure = () => {
      if (!ctx) return
      const cs = getComputedStyle(s)
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} 100px ${cs.fontFamily}`
      // Width of the text at 1px, with a little slack for rounding/kerning.
      const em = (txt: string) => (ctx.measureText(txt).width / 100) * 1.04 || 1
      const avail = b.clientWidth
      const size = Math.min(maxPx, avail / em(full))
      if (size >= minPx || !short) setFit({ size, text: full })
      else setFit({ size: Math.min(maxPx, avail / em(short)), text: short })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(b)
    return () => ro.disconnect()
  }, [full, short, maxPx, minPx])

  return (
    <div ref={box} className="min-w-0">
      <span ref={span} className={`block whitespace-nowrap ${className}`}
        style={{ fontSize: `${Math.max(fit.size, 1)}px` }}>
        {fit.text}
      </span>
    </div>
  )
}

/** "1:09.829" -> "1:09.82": cut (not rounded) to hundredths. */
export function toHundredths(lap: string): string | undefined {
  return /\.\d{3}$/.test(lap) ? lap.slice(0, -1) : undefined
}
