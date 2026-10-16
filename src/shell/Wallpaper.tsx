import { useStore } from '@nanostores/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { HeraldOSPrefs } from '../../shared/ipc.ts'
import { wallpaperTint, type WallpaperTint } from '../../shared/theme.ts'
import { $prefs, $windowState } from '../store/backend.ts'

/**
 * Procedural "flowing silk" wallpaper: layered, slowly drifting ribbons on a deep-blue field.
 * Canvas 2D at reduced resolution, ~30fps, paused when the window is blurred or motion is reduced.
 * A user image (prefs.wallpaper) replaces it.
 */
const FRAME_MS = 1000 / 30

// Animation phase lives outside the component so remounts, focus changes and HMR continue the
// same motion instead of snapping to a new random pattern.
let phase = Math.random() * 1000

const RIBBONS = Array.from({ length: 11 }, (_, i) => ({
  y: 0.12 + (i / 11) * 0.8,
  amp: 0.07 + (i % 3) * 0.04,
  freq: 0.9 + (i % 4) * 0.3,
  speed: 0.1 + (i % 5) * 0.03,
  width: 26 + (i % 3) * 30,
  hue: 214 + (i % 4) * 5,
  light: 52 + (i % 3) * 9,
  alpha: 0.3 + (i % 2) * 0.16,
  phase: i * 1.7
}))

const OCEAN_STOPS: WallpaperTint['stops'] = ['#1240c8', '#0a2a96', '#04113f']
const OCEAN_HUE = 214

/** The drawn wallpaper's tint for the current theme (null keeps the ocean blues). */
export function tintFor(prefs: Pick<HeraldOSPrefs, 'themeColors' | 'themeScheme'>): WallpaperTint | null {
  return wallpaperTint(prefs.themeColors, prefs.themeScheme)
}

/**
 * Draw one frame of the wallpaper at phase `t` onto `ctx`, covering `width` x `height` canvas pixels.
 * `scale` is canvas pixels per CSS pixel (the animated component renders at 0.5); ribbon widths are
 * expressed in CSS pixels so the picture looks the same at any resolution. `tint` recolours it for
 * the theme; light themes draw darker ribbons over the field instead of adding light. Pure: no DOM,
 * no state.
 */
export function drawWallpaperFrame(ctx: CanvasRenderingContext2D, width: number, height: number, t: number, scale = 1, tint: WallpaperTint | null = null): void {
  const w = width
  const h = height
  const stops = tint?.stops ?? OCEAN_STOPS
  const light = tint?.light ?? false
  const hueShift = tint ? tint.hue - OCEAN_HUE : 0
  const sat = tint ? Math.round(tint.saturation * 95) : 95
  const satHigh = Math.min(100, sat + 5)

  const base = ctx.createRadialGradient(w * 0.5, h * 0.5, h * 0.05, w * 0.5, h * 0.5, Math.max(w, h) * 0.8)
  base.addColorStop(0, stops[0])
  base.addColorStop(0.45, stops[1])
  base.addColorStop(1, stops[2])
  ctx.fillStyle = base
  ctx.fillRect(0, 0, w, h)

  ctx.lineCap = 'round'
  ctx.globalCompositeOperation = light ? 'source-over' : 'lighter'

  const tracePath = (r: (typeof RIBBONS)[number]) => {
    ctx.beginPath()
    const steps = 56

    for (let s = 0; s <= steps; s++) {
      const x = (s / steps) * w
      const nx = (s / steps) * r.freq * Math.PI * 2
      const y =
        h * r.y +
        Math.sin(nx + t * r.speed + r.phase) * h * r.amp +
        Math.sin(nx * 0.5 - t * r.speed * 0.7 + r.phase * 2) * h * r.amp * 0.6 +
        Math.cos(nx * 1.7 + t * r.speed * 0.4) * h * 0.012

      if (s === 0) {
        ctx.moveTo(x, y)
      } else {
        ctx.lineTo(x, y)
      }
    }
  }

  for (const r of RIBBONS) {
    const hue = r.hue + hueShift
    const l = light ? r.light - 22 : r.light
    const alpha = light ? r.alpha * 0.4 : r.alpha

    // Wide soft body.
    tracePath(r)
    const glow = ctx.createLinearGradient(0, 0, w, 0)
    glow.addColorStop(0, `hsla(${hue}, ${sat}%, ${l}%, 0)`)
    glow.addColorStop(0.3, `hsla(${hue}, ${sat}%, ${l + 10}%, ${alpha * 0.5})`)
    glow.addColorStop(0.7, `hsla(${hue + 6}, ${sat}%, ${l + 16}%, ${alpha * 0.45})`)
    glow.addColorStop(1, `hsla(${hue}, ${sat}%, ${l}%, 0)`)
    ctx.strokeStyle = glow
    ctx.lineWidth = r.width * scale * 2.2 * (1 + 0.15 * Math.sin(t * 0.3 + r.phase))
    ctx.stroke()

    // Bright silk highlight.
    tracePath(r)
    const grad = ctx.createLinearGradient(0, 0, w, 0)
    grad.addColorStop(0, `hsla(${hue}, ${satHigh}%, ${l + 10}%, 0)`)
    grad.addColorStop(0.35, `hsla(${hue}, ${satHigh}%, ${l + 26}%, ${alpha})`)
    grad.addColorStop(0.62, `hsla(${hue + 8}, ${satHigh}%, ${l + 34}%, ${alpha * 1.1})`)
    grad.addColorStop(1, `hsla(${hue}, ${satHigh}%, ${l + 10}%, 0)`)
    ctx.strokeStyle = grad
    ctx.lineWidth = r.width * scale * 0.55 * (1 + 0.2 * Math.sin(t * 0.3 + r.phase))
    ctx.stroke()
  }

  ctx.globalCompositeOperation = 'source-over'
  const vignette = ctx.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, Math.max(w, h) * 0.85)
  vignette.addColorStop(0, 'rgba(0,0,0,0)')
  vignette.addColorStop(1, tint?.vignette ?? 'rgba(0,4,30,0.4)')
  ctx.fillStyle = vignette
  ctx.fillRect(0, 0, w, h)
}

/**
 * A local wallpaper (a path or file:// URL) as a data: URL read through main. Pages served over
 * http (the dev server) cannot load local files, and a bare path would resolve against the page.
 */
function useWallpaperSource(custom: string | undefined): string | undefined {
  const [source, setSource] = useState<string | undefined>()

  useEffect(() => {
    if (!custom || /^(https?|data|blob):/i.test(custom)) {
      setSource(custom)

      return
    }

    let cancelled = false
    window.heraldOS.capture.readImage(custom).then(
      url => !cancelled && setSource(url),
      () => !cancelled && setSource(custom.startsWith('/') ? `file://${custom}` : custom)
    )

    return () => {
      cancelled = true
    }
  }, [custom])

  return source
}

export function Wallpaper() {
  const prefs = useStore($prefs)
  const win = useStore($windowState)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pausedRef = useRef(false)
  const custom = prefs.wallpaper
  const source = useWallpaperSource(custom)
  const tint = useMemo(() => tintFor(prefs), [prefs.themeColors, prefs.themeScheme])

  // Pausing must not restart the draw loop, otherwise a stale loop can survive cleanup and
  // alternate frames with the new one (visible as flicker).
  useEffect(() => {
    pausedRef.current = !win.focused
  }, [win.focused])

  useEffect(() => {
    if (custom) {
      return
    }

    const canvas = canvasRef.current

    if (!canvas) {
      return
    }

    const ctx = canvas.getContext('2d', { alpha: false })

    if (!ctx) {
      return
    }

    const reduce = prefs.reduceMotion || window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let raf = 0
    let last = 0
    let lastDraw = 0
    let disposed = false
    const scale = 0.5

    const resize = () => {
      canvas.width = Math.max(1, Math.floor(window.innerWidth * scale))
      canvas.height = Math.max(1, Math.floor(window.innerHeight * scale))
    }

    const draw = (now: number) => {
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0
      last = now
      phase += dt
      drawWallpaperFrame(ctx, canvas.width, canvas.height, phase, scale, tint)
    }

    const loop = (now: number) => {
      if (disposed) {
        return
      }

      // Single rAF chain throttled to ~30fps: even pacing, and always cancellable.
      if (!pausedRef.current && now - lastDraw >= FRAME_MS - 1) {
        lastDraw = now
        draw(now)
      } else if (pausedRef.current) {
        // Keep the clock from accumulating while paused so resume does not jump.
        last = now
      }

      raf = requestAnimationFrame(loop)
    }

    const onResize = () => {
      resize()
      draw(performance.now())
    }

    resize()
    draw(performance.now())
    window.addEventListener('resize', onResize)

    if (!reduce) {
      raf = requestAnimationFrame(loop)
    }

    return () => {
      disposed = true
      window.removeEventListener('resize', onResize)
      cancelAnimationFrame(raf)
    }
  }, [custom, prefs.reduceMotion, tint])

  if (custom) {
    return <div className="absolute inset-0 z-(--z-wallpaper) bg-cover bg-center" style={{ backgroundImage: source ? `url(${JSON.stringify(source)})` : undefined }} />
  }

  return <canvas ref={canvasRef} className="absolute inset-0 z-(--z-wallpaper) h-full w-full" style={{ filter: 'blur(1.5px)' }} aria-hidden="true" />
}
