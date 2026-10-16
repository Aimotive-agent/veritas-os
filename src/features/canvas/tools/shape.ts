/*
 * The Shape tool: drag out a rectangle, a rounded rectangle, an ellipse or a line in the
 * foreground colour (Shift for a square, a circle or a 45° line; Alt from the centre). Each shape
 * is a new layer that keeps its shape in the manifest.
 */

import type { ShapeStyle, Vec2 } from '../../../../shared/canvas/comp-format.ts'
import { insertLayer, nextName, placementFor } from '../engine/document.ts'
import type { View } from '../engine/gpu/view.ts'
import { constrainShape, shapeBox, shapeName, shapePath } from '../engine/shapes.ts'
import { makeShapeLayer } from '../text-layers.ts'
import { $foreground, $shape } from './state.ts'
import { redraw, type ToolHandler } from './types.ts'

/** The shape the options bar describes, in the foreground colour. */
export function shapeStyle(): ShapeStyle {
  const { kind, radius, lineWidth } = $shape.get()
  const [r, g, b] = $foreground.get()
  const base = { red: r / 255, green: g / 255, blue: b / 255 }

  if (kind === 'line') {
    return { ...base, kind: 'Line', cornerRadius: 0, lineWidth }
  }

  return { ...base, kind: kind === 'ellipse' ? 'Ellipse' : 'Rectangle', cornerRadius: kind === 'rounded' ? radius : 0 }
}

/** Where a drag puts a shape: Shift squares it (or snaps a line), Alt grows it from the centre; boxes sit on whole pixels. */
function dragged(style: ShapeStyle, from: Vec2, to: Vec2, square: boolean, fromCentre: boolean): { from: Vec2; to: Vec2 } {
  let end = square ? constrainShape(style.kind, from, to) : to
  let start = from

  if (fromCentre) {
    start = [2 * from[0] - end[0], 2 * from[1] - end[1]]
  }

  if (style.kind !== 'Line') {
    start = [Math.round(start[0]), Math.round(start[1])]
    end = [Math.round(end[0]), Math.round(end[1])]
  }

  return { from: start, to: end }
}

let drawing: { docKey: string; style: ShapeStyle; from: Vec2; to: Vec2 } | null = null

export const shapeTool: ToolHandler = {
  cursor: () => 'crosshair',

  down(doc, at) {
    const style = shapeStyle()
    const origin: Vec2 = [at.x, at.y]

    return {
      move: (now) => {
        drawing = { docKey: doc.key, style, ...dragged(style, origin, [now.x, now.y], now.shift, now.alt) }
        redraw()
      },
      up: () => {
        const drawn = drawing
        drawing = null
        redraw()

        if (!drawn || Math.hypot(drawn.to[0] - drawn.from[0], drawn.to[1] - drawn.from[1]) < 2) {
          return
        }

        const { box, start, end } = shapeBox(style.kind, drawn.from, drawn.to, style.lineWidth)
        const final: ShapeStyle = style.kind === 'Line' ? { ...style, start, end } : style
        const layer = makeShapeLayer(final, box, nextName(doc.state, shapeName(final)))
        doc.commit(shapeName(final), insertLayer(doc.state, layer, placementFor(doc.state)))
      },
      cancel: () => {
        drawing = null
        redraw()
      }
    }
  },

  overlay(context, doc, view: View) {
    if (drawing?.docKey !== doc.key) {
      return
    }

    const { style, from, to } = drawing
    const { box, start, end } = shapeBox(style.kind, from, to, style.lineWidth)
    context.save()
    context.translate(view.panX + box.x * view.zoom, view.panY + box.y * view.zoom)
    context.scale(view.zoom, view.zoom)
    const colour = `rgb(${Math.round(style.red * 255)} ${Math.round(style.green * 255)} ${Math.round(style.blue * 255)})`
    shapePath(context, style.kind === 'Line' ? { ...style, start, end } : style, box.width, box.height)

    if (style.kind === 'Line') {
      context.lineWidth = style.lineWidth ?? 1
      context.strokeStyle = colour
      context.stroke()
    } else {
      context.fillStyle = colour
      context.fill()
      context.lineWidth = 1 / view.zoom
      context.strokeStyle = '#4da3ff'
      context.stroke()
    }

    context.restore()
  }
}
