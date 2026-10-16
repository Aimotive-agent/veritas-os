/*
 * Shape layers for Veritas Canvas: a rectangle (corners rounded or not), an ellipse or a line, kept
 * as a pixel layer with its shape in the manifest. A line's ends are fractions of the layer's box,
 * which leaves room around them for the line's width.
 */

import type { ShapeKind, ShapeStyle, Vec2 } from '../../../../shared/canvas/comp-format.ts'
import { Raster, type Rect } from './raster.ts'
import { tint } from './text.ts'

/** The box a shape drawn from one document point to another fills, with a line's ends inside it. */
export function shapeBox(kind: ShapeKind, from: Vec2, to: Vec2, lineWidth = 1): { box: Rect; start?: Vec2; end?: Vec2 } {
  if (kind !== 'Line') {
    const x = Math.min(from[0], to[0])
    const y = Math.min(from[1], to[1])

    return { box: { x, y, width: Math.max(1, Math.abs(to[0] - from[0])), height: Math.max(1, Math.abs(to[1] - from[1])) } }
  }

  const reach = Math.max(0.5, lineWidth / 2) + 1
  const x = Math.floor(Math.min(from[0], to[0]) - reach)
  const y = Math.floor(Math.min(from[1], to[1]) - reach)
  const width = Math.ceil(Math.max(from[0], to[0]) + reach) - x
  const height = Math.ceil(Math.max(from[1], to[1]) + reach) - y
  const fraction = (point: Vec2): Vec2 => [(point[0] - x) / width, (point[1] - y) / height]

  return { box: { x, y, width, height }, start: fraction(from), end: fraction(to) }
}

/** The end of a drag with Shift: a square box, or a line at a multiple of 45°. */
export function constrainShape(kind: ShapeKind, from: Vec2, to: Vec2): Vec2 {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]

  if (kind === 'Line') {
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
    const length = Math.hypot(dx, dy)

    return [from[0] + Math.cos(angle) * length, from[1] + Math.sin(angle) * length]
  }

  const side = Math.max(Math.abs(dx), Math.abs(dy))

  return [from[0] + (Math.sign(dx) || 1) * side, from[1] + (Math.sign(dy) || 1) * side]
}

/** Trace a shape's path on a 2D context, in a box `width`×`height`. */
export function shapePath(context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, style: ShapeStyle, width: number, height: number): void {
  context.beginPath()

  if (style.kind === 'Ellipse') {
    context.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, Math.PI * 2)
  } else if (style.kind === 'Line') {
    const [sx, sy] = style.start ?? [0, 0]
    const [ex, ey] = style.end ?? [1, 1]
    context.moveTo(sx * width, sy * height)
    context.lineTo(ex * width, ey * height)
  } else if (style.cornerRadius > 0) {
    context.roundRect(0, 0, width, height, Math.min(style.cornerRadius, width / 2, height / 2))
  } else {
    context.rect(0, 0, width, height)
  }
}

/** A shape's pixels at a size (the layer's box, or larger for a scaled layer); its one colour stays exact at the antialiased edges. */
export function renderShape(style: ShapeStyle, width: number, height: number, lineScale = 1): Raster {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const canvas = new OffscreenCanvas(w, h)
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  context.fillStyle = '#fff'
  context.strokeStyle = '#fff'
  shapePath(context, style, w, h)

  if (style.kind === 'Line') {
    context.lineWidth = Math.max(1, (style.lineWidth ?? 1) * lineScale)
    context.lineCap = 'butt'
    context.stroke()
  } else {
    context.fill()
  }

  const raster = new Raster(w, h, 4, context.getImageData(0, 0, w, h).data)
  tint(raster, Math.round(style.red * 255), Math.round(style.green * 255), Math.round(style.blue * 255))

  return raster
}

/** The usual name for a new shape layer. */
export const shapeName = (style: Pick<ShapeStyle, 'kind' | 'cornerRadius'>): string => (style.kind === 'Line' ? 'Line' : style.kind === 'Ellipse' ? 'Ellipse' : style.cornerRadius > 0 ? 'Rounded Rectangle' : 'Rectangle')
