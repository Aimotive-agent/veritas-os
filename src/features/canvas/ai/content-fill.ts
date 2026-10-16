/*
 * Content-aware fill on a Veritas Canvas layer: a hole on the layer's own pixel grid (from the
 * selection, a box or a healing stroke) is filled from the pixels around it, in a worker. The fill
 * goes into the layer as one undoable step, or into a new layer above it.
 */

import { defaultTransform } from '../../../../shared/canvas/comp-format.ts'
import { type CanvasLayer, type DocState, findLayer, insertLayer, nextName, pixelLayer, withLayer } from '../engine/document.ts'
import { IDENTITY, type Mat, partPlacement, pixelToDocument } from '../engine/geometry.ts'
import type { PixelEdit } from '../engine/history.ts'
import { clipRect, Raster, type Rect } from '../engine/raster.ts'
import { coverageReader, rasterArea } from '../engine/sampling.ts'
import type { InpaintReply, InpaintRequest } from './inpaint-worker.ts'
import { extentOf } from './patchmatch.ts'

/** How much of each pixel of a raster to fill (0 to 255), with the box around it. */
export interface Hole {
  values: Uint8Array
  bounds: Rect
}

/** The filled pixels of a raster's rectangle, and how much of each was filled. */
export interface Filled {
  rect: Rect
  rgba: Uint8ClampedArray
  hole: Uint8Array
}

export interface FillTask {
  done: Promise<Filled>
  cancel(): void
}

export type FillSampling = 'around' | 'all'

/** A document-sized mask (a selection) as a hole on a raster placed by `toDocument`; null when it misses the raster. */
export function holeFromMask(mask: Raster, toDocument: Mat, width: number, height: number): Hole | null {
  const reach = mask.opaqueBounds()
  const area = reach && rasterArea(reach, toDocument, width, height)

  if (!area) {
    return null
  }

  const read = coverageReader(mask, toDocument)
  const values = new Uint8Array(width * height)

  for (let y = area.y; y < area.y + area.height; y++) {
    for (let x = area.x; x < area.x + area.width; x++) {
      values[y * width + x] = read(x, y)
    }
  }

  const bounds = extentOf(values, width, height)

  return bounds.width ? { values, bounds } : null
}

/** A document box as a mask the size of the document. */
export function boxMask(width: number, height: number, box: Rect): Raster {
  const mask = new Raster(width, height, 1)
  const inside = clipRect(box, width, height)

  if (inside) {
    for (let y = inside.y; y < inside.y + inside.height; y++) {
      mask.data.fill(255, y * width + inside.x, y * width + inside.x + inside.width)
    }
  }

  return mask
}

/** The part of a raster a fill works in: the hole and, around it, `margin` pixels to copy from (or all of it). */
export function fillArea(hole: Hole, width: number, height: number, sampling: FillSampling, margin = Math.max(48, Math.max(hole.bounds.width, hole.bounds.height))): Rect {
  if (sampling === 'all') {
    return { x: 0, y: 0, width, height }
  }

  const { x, y, width: w, height: h } = hole.bounds

  return clipRect({ x: x - margin, y: y - margin, width: w + margin * 2, height: h + margin * 2 }, width, height)!
}

/** Fill a hole in a raster's pixels, in a worker; `cancel` ends it at once. */
export function fillRaster(pixels: Raster, hole: Hole, options: { sampling?: FillSampling; margin?: number; seed?: number; onProgress?: (fraction: number) => void } = {}): FillTask {
  const rect = fillArea(hole, pixels.width, pixels.height, options.sampling ?? 'around', options.margin)
  const rgba = pixels.read(rect)
  const values = new Uint8Array(rect.width * rect.height)

  for (let y = 0; y < rect.height; y++) {
    values.set(hole.values.subarray((rect.y + y) * pixels.width + rect.x, (rect.y + y) * pixels.width + rect.x + rect.width), y * rect.width)
  }

  const kept = values.slice()
  const worker = new Worker(new URL('./inpaint-worker.ts', import.meta.url), { type: 'module', name: 'herald-canvas-fill' })
  let fail: (error: Error) => void = () => {}
  const done = new Promise<Filled>((resolve, reject) => {
    fail = reject
    worker.onmessage = (event: MessageEvent<InpaintReply>) => {
      const reply = event.data

      if ('progress' in reply) {
        options.onProgress?.(reply.progress)

        return
      }

      worker.terminate()

      if (reply.ok) {
        resolve({ rect, rgba: reply.rgba, hole: kept })
      } else {
        reject(new Error(reply.error))
      }
    }
    worker.onerror = (event) => {
      event.preventDefault()
      worker.terminate()
      reject(new Error(event.message || 'The fill stopped'))
    }
  })
  const request: InpaintRequest = { rgba, width: rect.width, height: rect.height, hole: values, seed: options.seed }
  worker.postMessage(request, [rgba.buffer, values.buffer])

  return {
    done,
    cancel: () => {
      worker.terminate()
      fail(new Error('The fill was cancelled'))
    }
  }
}

/** Put a fill's pixels into a raster (the filled ones only), with history kept by `edit`. */
export function writeFill(pixels: Raster, filled: Filled, edit?: PixelEdit): void {
  const { rect, rgba, hole } = filled
  edit?.prepare(rect)

  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      const i = y * rect.width + x

      if (hole[i]) {
        pixels.data.set(rgba.subarray(i * 4, i * 4 + 4), ((rect.y + y) * pixels.width + rect.x + x) * 4)
      }
    }
  }

  pixels.touch(rect)
}

/** A fill as pixels of their own: what was filled, see-through elsewhere (soft edges as alpha). */
export function fillPiece(filled: Filled): Raster {
  const { rect, rgba, hole } = filled
  const out = new Raster(rect.width, rect.height)

  for (let i = 0; i < hole.length; i++) {
    if (hole[i]) {
      out.data.set([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], (rgba[i * 4 + 3] * hole[i]) / 255], i * 4)
    }
  }

  return out
}

/** The document with a fill in a new layer above `above` (placed as the pixels it came from were, by `toDocument`). */
export function withFillLayer(state: DocState, filled: Filled, source: { transform: CanvasLayer['transform']; width: number; height: number } | null, above: string | undefined, name = 'Content-Aware Fill'): DocState {
  const piece = fillPiece(filled)
  const { rect } = filled
  const transform = source ? partPlacement(source.transform, source.width, source.height, rect) : defaultTransform(rect.width, rect.height, rect.x, rect.y)
  const layer = pixelLayer(nextName(state, name), piece, transform)

  return insertLayer(state, layer, above ? { above } : {})
}

/** The document with a fill put into a layer's pixels as new pixels (for commands, which record whole states). */
export function withFillInLayer(state: DocState, layerId: string, filled: Filled): DocState {
  const layer = findLayer(state, layerId)

  if (!layer?.pixels) {
    throw new Error('That layer has no pixels to fill')
  }

  const pixels = layer.pixels.clone()
  writeFill(pixels, filled)

  return withLayer(state, layerId, { pixels, text: undefined, shape: undefined })
}

/** Raster pixels to document pixels for a layer, or the identity for a document-sized composite. */
export const placementOf = (layer: CanvasLayer | null): Mat => (layer?.pixels ? pixelToDocument(layer.transform, layer.pixels.width, layer.pixels.height) : IDENTITY)
