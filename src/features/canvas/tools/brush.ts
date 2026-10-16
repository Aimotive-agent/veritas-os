/*
 * The Brush and the Eraser: strokes on the active layer (or its mask) through the selection, one
 * undo step each. Alt-click with the Brush picks up a colour; Shift-click draws a straight line
 * from where the last stroke ended. On a mask the Brush paints the foreground's gray and the
 * Eraser the background's.
 */

import type { Vec2 } from '../../../../shared/canvas/comp-format.ts'
import { Stroke } from '../engine/paint.ts'
import { pickColour } from './eyedropper.ts'
import { $background, $brush, $eraser, $foreground, type RGB } from './state.ts'
import { commitPixels, paintTarget } from './target.ts'
import { type PointerInfo, redraw, type ToolHandler } from './types.ts'

/** Where the last stroke ended, for Shift-click lines. */
let last: { docKey: string; layerId: string; point: Vec2 } | null = null

/** The pointer over the document, for the brush outline. */
let hovering: { docKey: string; at: PointerInfo } | null = null

function strokeTool(kind: 'brush' | 'eraser'): ToolHandler {
  const options = kind === 'brush' ? $brush : $eraser
  const label = kind === 'brush' ? 'Brush' : 'Eraser'

  return {
    cursor: (_doc, at) => (at && options.get().size * at.view.zoom >= 6 ? 'none' : 'crosshair'),

    hover(doc, at) {
      hovering = at ? { docKey: doc.key, at } : null
      redraw()
    },

    down(doc, at) {
      if (kind === 'brush' && at.alt) {
        pickColour(doc, at, false)

        return { move: (now) => pickColour(doc, now, false), up: () => {} }
      }

      const target = paintTarget(doc)

      if (!target) {
        return null
      }

      const before = doc.state
      const colour: RGB = target.mask ? (kind === 'brush' ? $foreground.get() : $background.get()) : $foreground.get()
      const stroke = new Stroke(target.raster, target.toDocument, options.get(), { colour, erase: kind === 'eraser' && !target.mask }, doc.state.selection)
      doc.interacting = true

      if (target.state !== before) {
        doc.preview(target.state)
      }

      if (at.shift && last && last.docKey === doc.key && last.layerId === target.layer.id) {
        stroke.to(last.point[0], last.point[1], at.pressure)
      }

      stroke.to(at.x, at.y, at.pressure)
      doc.changed()
      let end: Vec2 = [at.x, at.y]

      return {
        move: (now, trail) => {
          for (const point of trail) {
            stroke.to(point.x, point.y, point.pressure)
          }

          end = [now.x, now.y]
          hovering = { docKey: doc.key, at: now }
          doc.changed()
        },
        up: () => {
          stroke.end()
          doc.interacting = false
          last = { docKey: doc.key, layerId: target.layer.id, point: end }
          commitPixels(doc, before, target, stroke.edit, label)
        },
        cancel: () => {
          stroke.end()
          doc.interacting = false
          stroke.finish(label)?.undo()
          doc.preview(before)
        }
      }
    },

    overlay(context, doc, view) {
      if (hovering?.docKey !== doc.key) {
        return
      }

      const radius = (options.get().size * view.zoom) / 2

      if (radius < 3) {
        return
      }

      const { sx, sy } = hovering.at
      context.save()
      context.beginPath()
      context.arc(sx, sy, radius, 0, Math.PI * 2)
      context.lineWidth = 2.5
      context.strokeStyle = 'rgba(0, 0, 0, 0.55)'
      context.stroke()
      context.lineWidth = 1
      context.strokeStyle = 'rgba(255, 255, 255, 0.95)'
      context.stroke()
      context.restore()
    },

    release() {
      hovering = null
    }
  }
}

export const brushTool = strokeTool('brush')
export const eraserTool = strokeTool('eraser')
