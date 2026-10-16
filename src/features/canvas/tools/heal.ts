/*
 * The Spot Healing Brush: paint over a blemish, a wire or a small object, and when the stroke
 * ends what it covered is filled from the pixels around it (content-aware fill), as one undoable
 * step. Works on the active layer's pixels, through the selection; Escape stops a fill under way.
 */

import { type FillTask, fillRaster, writeFill } from '../ai/content-fill.ts'
import { extentOf } from '../ai/patchmatch.ts'
import type { CanvasDocument } from '../engine/document.ts'
import { invert } from '../engine/geometry.ts'
import { PixelEdit } from '../engine/history.ts'
import { dabAlpha } from '../engine/paint.ts'
import { coverageReader } from '../engine/sampling.ts'
import { notify } from '../store.ts'
import { $heal } from './state.ts'
import { commitPixels, paintTarget } from './target.ts'
import { type PointerInfo, redraw, type ToolHandler } from './types.ts'

/** The stroke being painted or healed, in document points. */
let stroke: { docKey: string; points: [number, number][]; size: number } | null = null
let hovering: { docKey: string; at: PointerInfo } | null = null
let running: FillTask | null = null

/** The hole a stroke covers on a raster: soft-edged discs along its path, cut by the selection. */
function strokeHole(points: [number, number][], size: number, toDocument: Parameters<typeof coverageReader>[1], width: number, height: number, selected: (x: number, y: number) => number): Uint8Array {
  const back = invert(toDocument)
  const density = Math.sqrt(Math.abs(back.a * back.d - back.b * back.c)) || 1
  const radius = Math.max(1, (size / 2) * density)
  const values = new Uint8Array(width * height)
  const dabs: [number, number][] = []

  // Dabs a quarter of the radius apart along the path.
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i]
    const px = back.a * x + back.c * y + back.e
    const py = back.b * x + back.d * y + back.f
    const last = dabs.at(-1)

    if (last) {
      const steps = Math.floor(Math.hypot(px - last[0], py - last[1]) / Math.max(1, radius / 4))

      for (let s = 1; s < steps; s++) {
        dabs.push([last[0] + ((px - last[0]) * s) / steps, last[1] + ((py - last[1]) * s) / steps])
      }
    }

    dabs.push([px, py])
  }

  for (const [cx, cy] of dabs) {
    for (let y = Math.max(0, Math.floor(cy - radius - 1)); y < Math.min(height, Math.ceil(cy + radius + 1)); y++) {
      for (let x = Math.max(0, Math.floor(cx - radius - 1)); x < Math.min(width, Math.ceil(cx + radius + 1)); x++) {
        const value = Math.round(dabAlpha(Math.hypot(x + 0.5 - cx, y + 0.5 - cy), radius, 0.75) * 255)
        const i = y * width + x

        if (value > values[i]) {
          values[i] = value
        }
      }
    }
  }

  for (let i = 0; i < values.length; i++) {
    if (values[i]) {
      const x = i % width
      values[i] = Math.round((values[i] * selected(x, (i - x) / width)) / 255)
    }
  }

  return values
}

export const healTool: ToolHandler = {
  cursor: (_doc, at) => (running ? 'progress' : at && $heal.get().size * at.view.zoom >= 6 ? 'none' : 'crosshair'),

  hover(doc, at) {
    hovering = at ? { docKey: doc.key, at } : null
    redraw()
  },

  down(doc, at) {
    if (running) {
      notify('Still healing the last stroke')

      return null
    }

    if (doc.editingMask) {
      notify('The Spot Healing Brush works on pixels: pick the layer, not its mask', 'error')

      return null
    }

    const layer = doc.active

    if (!layer?.pixels || layer.isGroup || layer.adjustment) {
      notify(layer ? `${layer.name} has no pixels to heal` : 'Pick a layer to heal', 'error')

      return null
    }

    const size = $heal.get().size
    stroke = { docKey: doc.key, points: [[at.x, at.y]], size }
    redraw()

    return {
      move: (now, trail) => {
        for (const point of trail) {
          stroke?.points.push([point.x, point.y])
        }

        hovering = { docKey: doc.key, at: now }
        redraw()
      },
      up: () => void heal(doc),
      cancel: () => {
        stroke = null
        redraw()
      }
    }
  },

  key(doc, event) {
    if (event.key === 'Escape' && running && stroke?.docKey === doc.key) {
      running.cancel()

      return true
    }

    return false
  },

  overlay(context, doc, view) {
    if (stroke?.docKey === doc.key) {
      context.save()
      context.lineCap = 'round'
      context.lineJoin = 'round'
      context.lineWidth = Math.max(1, stroke.size * view.zoom)
      context.strokeStyle = running ? 'rgba(77, 163, 255, 0.45)' : 'rgba(255, 255, 255, 0.4)'
      context.beginPath()
      stroke.points.forEach(([x, y], i) => (i ? context.lineTo(view.panX + x * view.zoom, view.panY + y * view.zoom) : context.moveTo(view.panX + x * view.zoom, view.panY + y * view.zoom)))

      if (stroke.points.length === 1) {
        context.lineTo(view.panX + stroke.points[0][0] * view.zoom + 0.01, view.panY + stroke.points[0][1] * view.zoom)
      }

      context.stroke()
      context.restore()
    }

    if (hovering?.docKey === doc.key && !running) {
      const radius = ($heal.get().size * view.zoom) / 2

      if (radius >= 3) {
        context.save()
        context.beginPath()
        context.arc(hovering.at.sx, hovering.at.sy, radius, 0, Math.PI * 2)
        context.lineWidth = 2.5
        context.strokeStyle = 'rgba(0, 0, 0, 0.55)'
        context.stroke()
        context.lineWidth = 1
        context.strokeStyle = 'rgba(255, 255, 255, 0.95)'
        context.stroke()
        context.restore()
      }
    }
  },

  release() {
    hovering = null
  }
}

async function heal(doc: CanvasDocument): Promise<void> {
  const painted = stroke

  if (!painted || painted.docKey !== doc.key) {
    return
  }

  const target = paintTarget(doc)

  if (!target || target.mask) {
    stroke = null
    redraw()

    return
  }

  const before = doc.state
  const values = strokeHole(painted.points, painted.size, target.toDocument, target.raster.width, target.raster.height, coverageReader(doc.state.selection, target.toDocument))
  const bounds = extentOf(values, target.raster.width, target.raster.height)

  if (!bounds.width) {
    stroke = null
    redraw()

    return
  }

  running = fillRaster(target.raster, { values, bounds }, { margin: Math.max(24, Math.round(Math.max(bounds.width, bounds.height) * 1.5)) })
  redraw()

  try {
    const filled = await running.done
    const edit = new PixelEdit(target.raster)
    writeFill(target.raster, filled, edit)
    commitPixels(doc, before, target, edit, 'Spot Healing Brush')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    notify(message.includes('cancelled') ? 'Healing stopped' : `Could not heal there: ${message}`, message.includes('cancelled') ? 'info' : 'error')

    if (doc.state !== before) {
      doc.preview(before)
    }
  } finally {
    running = null
    stroke = null
    redraw()
  }
}
