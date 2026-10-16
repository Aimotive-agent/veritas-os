import { useEffect } from 'react'
import type { WallpaperTint } from '../../../shared/theme.ts'
import { drawWallpaperFrame, tintFor } from '../Wallpaper.tsx'

/** A fixed phase that places the ribbons pleasantly: no crossings through the centre, highlights spread out. */
const FRAME_PHASE = 137.5
/** Matches the soft blur the animated wallpaper applies through CSS. */
const FRAME_BLUR_PX = 1.5

/**
 * Panels mode: this window is offscreen and screen-sized. It renders one full-resolution frame of
 * the procedural wallpaper, hands the PNG to main (which feeds swaybg), and main closes the window.
 */
export function WallpaperSurface() {
  useEffect(() => {
    let cancelled = false
    let raf = 0

    const render = (tint: WallpaperTint | null) => {
      const width = Math.max(1, window.innerWidth)
      const height = Math.max(1, window.innerHeight)

      try {
        const scene = document.createElement('canvas')
        scene.width = width
        scene.height = height
        const sceneCtx = scene.getContext('2d', { alpha: false })

        if (!sceneCtx) {
          return
        }

        drawWallpaperFrame(sceneCtx, width, height, FRAME_PHASE, 1, tint)

        // Second pass through a blur filter so the export looks like the on-screen wallpaper.
        const output = document.createElement('canvas')
        output.width = width
        output.height = height
        const outputCtx = output.getContext('2d', { alpha: false })
        let source = scene

        if (outputCtx && 'filter' in outputCtx) {
          outputCtx.fillStyle = tint?.stops[2] ?? '#04113f'
          outputCtx.fillRect(0, 0, width, height)
          outputCtx.filter = `blur(${FRAME_BLUR_PX}px)`
          outputCtx.drawImage(scene, 0, 0)
          outputCtx.filter = 'none'
          source = output
        }

        const dataUrl = source.toDataURL('image/png')

        if (!cancelled) {
          window.heraldOS.shell.wallpaperFrame(dataUrl).catch(() => undefined)
        }
      } catch {
        // Nothing to fall back to here; main keeps the previous render on disk.
      }
    }

    // The theme decides the colours; then one rAF so the window has its final size before we read it.
    void window.heraldOS.prefs
      .get()
      .then(prefs => tintFor(prefs))
      .catch(() => null)
      .then(tint => {
        if (!cancelled) {
          raf = requestAnimationFrame(() => render(tint))
        }
      })

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
  }, [])

  return <div className="h-full w-full bg-bg" aria-hidden="true" />
}
