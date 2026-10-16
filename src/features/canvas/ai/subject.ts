/*
 * What Remove Background makes of a subject's mask, apart from the model: the layer's own mask, or
 * a cut-out layer that keeps exactly the place the subject had.
 */

import { type CanvasLayer, type DocState, insertLayer, pixelLayer, withLayer } from '../engine/document.ts'
import { partPlacement } from '../engine/geometry.ts'
import type { Raster } from '../engine/raster.ts'

export type BackgroundOutput = 'mask' | 'cutout'

/** Why a layer's background cannot be removed, or null when it can. */
export function cannotSegment(layer: CanvasLayer | undefined): string | null {
  if (!layer) {
    return 'Pick a layer first'
  }

  if (layer.isGroup || layer.adjustment) {
    return `${layer.name} is ${layer.isGroup ? 'a folder' : 'an adjustment layer'}: pick a layer with a picture`
  }

  return layer.pixels ? null : `${layer.name} is empty`
}

/** A layer's pixels with a mask baked into their alpha, cut to what is left. */
export function cutOut(pixels: Raster, mask: Raster): { pixels: Raster; bounds: { x: number; y: number; width: number; height: number } } | null {
  const out = pixels.clone()

  for (let i = 0; i < mask.data.length; i++) {
    out.data[i * 4 + 3] = (out.data[i * 4 + 3] * mask.data[i] + 127) / 255
  }

  const bounds = out.opaqueBounds()

  return bounds ? { pixels: bounds.width === out.width && bounds.height === out.height ? out : out.crop(bounds), bounds } : null
}

/**
 * The document with a layer's subject kept: as the layer's mask (a mask it had is replaced), or as
 * a new cut-out layer above it with the original hidden. The mask is on the layer's pixel grid.
 */
export function withSubject(state: DocState, layer: CanvasLayer, mask: Raster, output: BackgroundOutput): DocState {
  if (output === 'mask' || !layer.pixels) {
    return withLayer(state, layer.id, { mask, maskEnabled: true, maskLinked: true, maskPlacement: undefined })
  }

  const cut = cutOut(layer.pixels, mask)

  if (!cut) {
    throw new Error(`Nothing of ${layer.name} would be left`)
  }

  const transform = partPlacement(layer.transform, layer.pixels.width, layer.pixels.height, cut.bounds)
  const piece: CanvasLayer = { ...pixelLayer(`${layer.name} cut-out`, cut.pixels, transform), opacity: layer.opacity, blendMode: layer.blendMode, effects: layer.effects }

  return insertLayer(withLayer(state, layer.id, { isVisible: false }), piece, { above: layer.id })
}
