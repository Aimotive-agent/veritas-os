/*
 * The Paint Bucket (the foreground colour into the pixels like the clicked one, inside the
 * selection) and the Gradient (a drag from where the gradient starts to where it ends, in the
 * style and colours the options bar sets; Shift keeps the line to 45° steps). Both work on the
 * active layer or its mask, as one undo step.
 */

import type { Vec2 } from '../../../../shared/canvas/comp-format.ts'
import { fillRaster, paintGradient, similarPixels } from '../engine/fill.ts'
import { gradientTable } from '../engine/gradient.ts'
import { PixelEdit } from '../engine/history.ts'
import { Raster } from '../engine/raster.ts'
import { coverageReader } from '../engine/sampling.ts'
import { sampleSource } from './select.ts'
import { $background, $bucket, $foreground, $gradient } from './state.ts'
import { commitPixels, paintTarget, selectionStrength, targetArea } from './target.ts'
import { redraw, type ToolHandler } from './types.ts'

/** Two document-sized masks multiplied (the found pixels and the selection). */
function intersect(a: Raster, b: Raster | null): Raster {
  if (!b) {
    return a
  }

  const out = new Raster(a.width, a.height, 1)

  for (let i = 0; i < out.data.length; i++) {
    out.data[i] = (a.data[i] * b.data[i] + 127) / 255
  }

  return out
}

export const bucketTool: ToolHandler = {
  cursor: () => 'crosshair',

  down(doc, at) {
    const { tolerance, contiguous, allLayers, opacity } = $bucket.get()
    const target = paintTarget(doc)

    if (!target) {
      return null
    }

    const region = similarPixels(sampleSource(doc, allLayers, target.mask), at.x, at.y, tolerance, contiguous)

    if (!region) {
      return null
    }

    const before = doc.state
    const covered = intersect(region, doc.state.selection)
    const bounds = covered.opaqueBounds()
    const area = bounds && targetArea(target, bounds)

    if (!area) {
      return null
    }

    const read = coverageReader(covered, target.toDocument)
    const edit = new PixelEdit(target.raster)
    edit.prepare(area)
    fillRaster(target.raster, area, [...$foreground.get(), 255], (x, y) => (read(x, y) / 255) * opacity)
    commitPixels(doc, before, target, edit, 'Paint Bucket')

    return null
  }
}

/** The gradient line being dragged, for the overlay. */
let line: { docKey: string; from: Vec2; to: Vec2 } | null = null

/** A line's end kept to a multiple of 45°. */
function snapped(from: Vec2, to: Vec2): Vec2 {
  const angle = Math.round(Math.atan2(to[1] - from[1], to[0] - from[0]) / (Math.PI / 4)) * (Math.PI / 4)
  const length = Math.hypot(to[0] - from[0], to[1] - from[1])

  return [from[0] + Math.cos(angle) * length, from[1] + Math.sin(angle) * length]
}

export const gradientTool: ToolHandler = {
  cursor: () => 'crosshair',

  down(doc, at) {
    const from: Vec2 = [at.x, at.y]

    return {
      move: (now) => {
        line = { docKey: doc.key, from, to: now.shift ? snapped(from, [now.x, now.y]) : [now.x, now.y] }
        redraw()
      },
      up: () => {
        const drawn = line
        line = null
        redraw()

        if (!drawn || Math.hypot(drawn.to[0] - from[0], drawn.to[1] - from[1]) < 1) {
          return
        }

        const target = paintTarget(doc)

        if (!target) {
          return
        }

        const { style, gradient, reverse, opacity } = $gradient.get()
        const before = doc.state
        const selection = doc.state.selection
        const area = targetArea(target, selection?.opaqueBounds() ?? null)

        if (!area) {
          return
        }

        const edit = new PixelEdit(target.raster)
        edit.prepare(area)
        const table = gradientTable(gradient, $foreground.get(), $background.get(), reverse)
        paintGradient(target.raster, area, target.toDocument, { style, from: drawn.from, to: drawn.to, table }, selectionStrength(target, selection, opacity))
        commitPixels(doc, before, target, edit, 'Gradient')
      },
      cancel: () => {
        line = null
        redraw()
      }
    }
  },

  overlay(context, doc, view) {
    if (line?.docKey !== doc.key) {
      return
    }

    const [x0, y0] = [view.panX + line.from[0] * view.zoom, view.panY + line.from[1] * view.zoom]
    const [x1, y1] = [view.panX + line.to[0] * view.zoom, view.panY + line.to[1] * view.zoom]
    context.save()
    context.lineWidth = 3
    context.strokeStyle = 'rgba(0, 0, 0, 0.5)'
    context.beginPath()
    context.moveTo(x0, y0)
    context.lineTo(x1, y1)
    context.stroke()
    context.lineWidth = 1
    context.strokeStyle = '#fff'
    context.stroke()

    for (const [x, y] of [
      [x0, y0],
      [x1, y1]
    ]) {
      context.beginPath()
      context.arc(x, y, 3.5, 0, Math.PI * 2)
      context.fillStyle = '#fff'
      context.fill()
      context.stroke()
    }

    context.restore()
  }
}
