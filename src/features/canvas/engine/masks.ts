/*
 * What can be done to a layer's mask: show or hide everything, show or hide the selection, invert
 * it, bake it into the pixels, switch it off, and link or unlink it. A linked mask spans the layer's
 * own box and moves with it; an unlinked one keeps the place it had when it was unlinked. Each
 * operation makes new rasters rather than changing the old ones, which history still holds.
 */

import { LIMITS, type LayerTransform } from '../../../../shared/canvas/comp-format.ts'
import type { MaskAction } from '../mask-actions.ts'
import { type CanvasLayer, type DocState, findLayer, withLayer } from './document.ts'
import { apply, invert, type Mat, pixelOffset, pixelToDocument } from './geometry.ts'
import { Raster } from './raster.ts'
import { sampleBilinear } from './sampling.ts'

export { MASK_ACTIONS, MASK_LABELS, type MaskAction } from '../mask-actions.ts'

/** Where a layer's mask lies: its own placement when unlinked, the layer's box otherwise. */
export const maskPlacement = (layer: CanvasLayer): LayerTransform => (layer.maskLinked === false && layer.maskPlacement ? layer.maskPlacement : layer.transform)

const side = (value: number): number => Math.max(1, Math.min(LIMITS.side, Math.round(Math.abs(value))))

const sameBox = (a: LayerTransform, b: LayerTransform): boolean =>
  a.origin[0] === b.origin[0] && a.origin[1] === b.origin[1] && a.size[0] === b.size[0] && a.size[1] === b.size[1] && a.rotation === b.rotation && a.flipX === b.flipX && a.flipY === b.flipY

/** The pixel size a full mask on this layer has: its pixels' size when it has pixels, its box's otherwise. */
export function maskSize(layer: CanvasLayer, placement: LayerTransform = layer.transform): [number, number] {
  return layer.pixels && placement === layer.transform ? [layer.pixels.width, layer.pixels.height] : [side(placement.size[0]), side(placement.size[1])]
}

/** A one-channel raster `width`×`height` placed by `toDocument`, read from `source` (placed by `sourceToDocument`); outside it, `outside`. */
function resampled(source: Raster, sourceToDocument: Mat, width: number, height: number, toDocument: Mat, outside = 0): Raster {
  const out = new Raster(width, height, 1)
  const mapping = invertedThrough(sourceToDocument, toDocument)
  const offset = pixelOffset(mapping)

  if (source.width === 1 && source.height === 1) {
    const value = source.data[0]

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [u, v] = apply(mapping, [x + 0.5, y + 0.5])
        out.data[y * width + x] = u >= 0 && v >= 0 && u <= 1 && v <= 1 ? value : outside
      }
    }

    return out
  }

  if (offset) {
    const [ox, oy] = offset

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const sx = x + ox
        const sy = y + oy
        out.data[y * width + x] = sx >= 0 && sy >= 0 && sx < source.width && sy < source.height ? source.data[sy * source.width + sx] : outside
      }
    }

    return out
  }

  const sample = new Uint8ClampedArray(1)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [u, v] = apply(mapping, [x + 0.5, y + 0.5])

      if (u < 0 || v < 0 || u > source.width || v > source.height) {
        out.data[y * width + x] = outside
        continue
      }

      // Pixel-centre units, with the edge pixels carried to the very edge.
      sampleBilinear(source, Math.min(source.width - 1, Math.max(0, u - 0.5)), Math.min(source.height - 1, Math.max(0, v - 0.5)), sample)
      out.data[y * width + x] = sample[0]
    }
  }

  return out
}

/** Pixels of the target grid to pixels of the source grid. */
const invertedThrough = (sourceToDocument: Mat, toDocument: Mat): Mat => {
  const back = invert(sourceToDocument)

  return {
    a: back.a * toDocument.a + back.c * toDocument.b,
    b: back.b * toDocument.a + back.d * toDocument.b,
    c: back.a * toDocument.c + back.c * toDocument.d,
    d: back.b * toDocument.c + back.d * toDocument.d,
    e: back.a * toDocument.e + back.c * toDocument.f + back.e,
    f: back.b * toDocument.e + back.d * toDocument.f + back.f
  }
}

/** The selection (document-sized) as a mask on a layer's grid; `hide` takes its inverse. */
export function maskFromSelection(layer: CanvasLayer, selection: Raster, hide: boolean): Raster {
  const placement = layer.mask ? maskPlacement(layer) : layer.transform
  const [width, height] = maskSize(layer, placement)
  const docToSelf: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  const mask = resampled(selection, docToSelf, width, height, pixelToDocument(placement, width, height))

  if (hide) {
    for (let i = 0; i < mask.data.length; i++) {
      mask.data[i] = 255 - mask.data[i]
    }
  }

  return mask
}

/** How much of each of a layer's pixels its mask shows (0 to 255), mask placement and size whatever they are. */
export function maskOverPixels(layer: CanvasLayer): Raster | null {
  const { pixels, mask } = layer

  if (!pixels || !mask) {
    return null
  }

  const placement = maskPlacement(layer)

  if (placement === layer.transform && mask.width === pixels.width && mask.height === pixels.height) {
    return mask
  }

  return resampled(mask, pixelToDocument(placement, mask.width, mask.height), pixels.width, pixels.height, pixelToDocument(layer.transform, pixels.width, pixels.height))
}

/** The patch an action makes to a layer, or an error saying why it cannot be done. */
export function maskPatch(state: DocState, layer: CanvasLayer, action: MaskAction): Partial<CanvasLayer> {
  const needsMask = () => {
    if (!layer.mask) {
      throw new Error(`${layer.name} has no mask`)
    }

    return layer.mask
  }

  switch (action) {
    case 'reveal':
    case 'hide':
      return { mask: Raster.filled(1, 1, action === 'reveal' ? 255 : 0, 1), maskEnabled: true, maskLinked: true, maskPlacement: undefined }
    case 'revealSelection':
    case 'hideSelection': {
      if (!state.selection) {
        throw new Error('Nothing is selected')
      }

      return { mask: maskFromSelection(layer, state.selection, action === 'hideSelection'), maskEnabled: true }
    }
    case 'invert': {
      const mask = needsMask()
      const out = new Raster(mask.width, mask.height, 1)

      for (let i = 0; i < out.data.length; i++) {
        out.data[i] = 255 - mask.data[i]
      }

      return { mask: out }
    }
    case 'apply': {
      needsMask()

      if (layer.isGroup || layer.adjustment) {
        throw new Error(`${layer.name} has no pixels to apply its mask to; a folder's or an adjustment's mask stays a mask`)
      }

      if (!layer.pixels) {
        return { mask: null, maskEnabled: undefined, maskLinked: undefined, maskPlacement: undefined }
      }

      const coverage = maskOverPixels(layer)!
      const pixels = layer.pixels.clone()

      for (let i = 0; i < coverage.data.length; i++) {
        pixels.data[i * 4 + 3] = (pixels.data[i * 4 + 3] * coverage.data[i] + 127) / 255
      }

      // The pixels no longer match a text or shape record.
      return { pixels, mask: null, maskEnabled: undefined, maskLinked: undefined, maskPlacement: undefined, text: undefined, shape: undefined }
    }
    case 'enable':
    case 'disable':
      needsMask()

      return { maskEnabled: action === 'enable' }
    case 'remove':
      needsMask()

      return { mask: null, maskEnabled: undefined, maskLinked: undefined, maskPlacement: undefined }
    case 'unlink':
      needsMask()

      return layer.maskLinked === false ? {} : { maskLinked: false, maskPlacement: { ...layer.transform } }
    case 'link': {
      const mask = needsMask()

      if (layer.maskLinked !== false) {
        return {}
      }

      const placement = layer.maskPlacement

      // Never moved since it was unlinked: the same pixels fit.
      if (!placement || sameBox(placement, layer.transform)) {
        return { maskLinked: true, maskPlacement: undefined }
      }

      const [width, height] = maskSize(layer)

      return { mask: resampled(mask, pixelToDocument(placement, mask.width, mask.height), width, height, pixelToDocument(layer.transform, width, height)), maskLinked: true, maskPlacement: undefined }
    }
  }
}

/** A document with a mask action done to a layer. */
export function withMaskAction(state: DocState, id: string, action: MaskAction): DocState {
  const layer = findLayer(state, id)

  if (!layer) {
    throw new Error('That layer is not in the document')
  }

  const patch = maskPatch(state, layer, action)

  return Object.keys(patch).length ? withLayer(state, id, patch) : state
}
