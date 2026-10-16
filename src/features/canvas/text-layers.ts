/*
 * Making and redrawing text and shape layers, for the Type and Shape tools, the options bar and
 * Hermes's commands. A text layer keeps its anchor (the point its text hangs from) and its scale,
 * turn and flips when its text or style changes, and draws its text at the size it is shown, so
 * it stays sharp.
 */

import { defaultTransform, type LayerTransform, RANGES, type ShapeStyle, type TextStyle, type Vec2 } from '../../../shared/canvas/comp-format.ts'
import { type CanvasLayer, pixelLayer } from './engine/document.ts'
import { apply, type Mat, multiply, scale, tidy, unitToDocument } from './engine/geometry.ts'
import type { Rect } from './engine/raster.ts'
import { renderShape, shapeName } from './engine/shapes.ts'
import { editedRuns, isParagraph, layoutText, loadFont, measureFor, originForAnchor, originForTop, renderText, type TextLayout } from './engine/text.ts'

/** The name a text layer gets from its text: the first line, shortened. */
export function textLayerName(content: string): string {
  const line = content.trim().split('\n')[0].trim()

  return line ? (line.length > 40 ? `${line.slice(0, 39)}…` : line) : 'Text'
}

/**
 * Text laid out, with paragraph text keeping the box it was laid out in: at least 16 pixels a
 * side, the smallest box Compositor reads. Point text has no box.
 */
function laidOut(style: TextStyle): { style: TextStyle; layout: TextLayout } {
  const layout = layoutText(style, measureFor(style))

  if (!isParagraph(style)) {
    return { style, layout }
  }

  const least = RANGES.textBox[0]
  const box: Vec2 = [Math.max(least, layout.width), Math.max(least, layout.height)]
  const sized = { ...style, boxSize: box }

  return { style: sized, layout: box[0] === layout.width && box[1] === layout.height ? layout : layoutText(sized, measureFor(sized)) }
}

/**
 * A new text layer. Point text hangs from `at` (its first baseline at the alignment edge, where a
 * click with the Type tool puts it) or, with `from: 'top'`, has its top edge there; paragraph
 * text fills its box from `at`.
 */
export async function makeTextLayer(text: TextStyle, at: Vec2, options: { from?: 'anchor' | 'top'; name?: string } = {}): Promise<CanvasLayer> {
  await loadFont(text)
  const { style, layout } = laidOut(text)
  const [x, y] = options.from === 'top' ? originForTop(layout, at[0], at[1]) : originForAnchor(layout, at[0], at[1])
  const pixels = renderText(style, layout)

  return { ...pixelLayer(options.name ?? textLayerName(style.content), pixels, defaultTransform(layout.width, layout.height, tidy(x), tidy(y))), text: style }
}

/** Layout pixels to document pixels for text laid out in a placement. */
export const layoutToDocument = (transform: LayerTransform, layout: TextLayout): Mat => multiply(unitToDocument(transform), scale(1 / layout.width, 1 / layout.height))

/**
 * Where text goes after it changed from `old` to `style` in a layer placed by `transform`: the
 * anchor stays on the same document point and the scale, turn and flips stay as they were.
 */
export function textPlacement(transform: LayerTransform, old: TextStyle, style: TextStyle): { transform: LayerTransform; layout: TextLayout; scale: Vec2 } {
  const before = layoutText(old, measureFor(old))
  const layout = layoutText(style, measureFor(style))
  const sx = transform.size[0] / before.width
  const sy = transform.size[1] / before.height
  const anchor = apply(layoutToDocument(transform, before), before.anchor)
  const sized: LayerTransform = { ...transform, size: [tidy(layout.width * sx), tidy(layout.height * sy)] }
  const moved = apply(layoutToDocument(sized, layout), layout.anchor)

  return { transform: { ...sized, origin: [tidy(sized.origin[0] + anchor[0] - moved[0]), tidy(sized.origin[1] + anchor[1] - moved[1])] }, layout, scale: [sx, sy] }
}

/**
 * A text layer after its text or style changed: new pixels and a placement that keeps its anchor,
 * scale, turn and flips. Its colour and font runs follow the edit where they can (`editedRuns`).
 */
export async function restyleText(layer: CanvasLayer, text: TextStyle): Promise<Partial<CanvasLayer>> {
  const old = layer.text ?? text
  await loadFont(old)
  await loadFont(text)
  const { style } = laidOut(editedRuns(old, text))
  const { transform, layout, scale: drawn } = textPlacement(layer.transform, old, style)
  const renamed = layer.name === textLayerName(old.content) ? { name: textLayerName(style.content) } : {}

  return { ...renamed, transform, pixels: renderText(style, layout, drawn), text: style }
}

/** A new shape layer filling a box (document pixels). */
export function makeShapeLayer(style: ShapeStyle, box: Rect, name: string): CanvasLayer {
  const pixels = renderShape(style, box.width, box.height)

  return { ...pixelLayer(name, pixels, defaultTransform(box.width, box.height, tidy(box.x), tidy(box.y))), shape: style }
}

/** A shape layer drawn again after its style changed, at the pixel size it has; a name it was given for its kind follows the kind. */
export function restyleShape(layer: CanvasLayer, style: ShapeStyle): Partial<CanvasLayer> {
  const width = layer.pixels?.width ?? layer.transform.size[0]
  const height = layer.pixels?.height ?? layer.transform.size[1]
  const before = layer.shape ? shapeName(layer.shape) : null
  const numbered = before ? new RegExp(`^${before}( \\d+)?$`).exec(layer.name) : null
  const renamed = numbered && shapeName(style) !== before ? { name: `${shapeName(style)}${numbered[1] ?? ''}` } : {}

  return { ...renamed, pixels: renderShape(style, width, height), shape: style }
}
