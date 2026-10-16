/*
 * The Eyedropper: the colour under the pointer becomes the foreground colour (the background with
 * Alt), taken from everything visible or from the active layer alone. The Brush borrows it for
 * Alt-clicks.
 */

import type { CanvasDocument } from '../engine/document.ts'
import { apply, invert, pixelToDocument } from '../engine/geometry.ts'
import { compositeAt } from './screen.ts'
import { $background, $eyedropper, $foreground, type RGB } from './state.ts'
import type { PointerInfo, ToolHandler } from './types.ts'

/** The colour at a document point; null where there is nothing to see. */
export function colourAt(doc: CanvasDocument, x: number, y: number, allLayers: boolean): RGB | null {
  if (allLayers) {
    const colour = compositeAt(doc, x, y)

    return colour && colour[3] > 0 ? [colour[0], colour[1], colour[2]] : null
  }

  const layer = doc.active
  const pixels = layer?.pixels

  if (!layer || !pixels) {
    return null
  }

  const [u, v] = apply(invert(pixelToDocument(layer.transform, pixels.width, pixels.height)), [x, y])
  const px = Math.floor(u)
  const py = Math.floor(v)

  if (px < 0 || py < 0 || px >= pixels.width || py >= pixels.height) {
    return null
  }

  const i = (py * pixels.width + px) * 4

  return pixels.data[i + 3] > 0 ? [pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]] : null
}

/** Take the colour under the pointer: into the foreground, or the background with Alt. */
export function pickColour(doc: CanvasDocument, at: PointerInfo, toBackground = at.alt): void {
  const colour = colourAt(doc, at.x, at.y, $eyedropper.get().allLayers)

  if (colour) {
    ;(toBackground ? $background : $foreground).set(colour)
  }
}

export const eyedropperTool: ToolHandler = {
  cursor: () => 'crosshair',

  down(doc, at) {
    pickColour(doc, at)

    return { move: (now) => pickColour(doc, now, at.alt), up: () => {} }
  }
}
