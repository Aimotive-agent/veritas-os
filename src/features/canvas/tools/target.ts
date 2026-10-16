/*
 * Where painting lands: the active layer's pixels, or its mask when the mask is targeted. A blank
 * layer gets document-sized pixels first, a uniform 1×1 mask the layer's size, and a text or shape
 * layer turns into plain pixels (its text or shape details are dropped, as the format asks).
 */

import { defaultTransform } from '../../../../shared/canvas/comp-format.ts'
import { type CanvasDocument, type CanvasLayer, type DocState, findLayer, isShown, withLayer } from '../engine/document.ts'
import type { Strength } from '../engine/fill.ts'
import { type Mat, pixelToDocument } from '../engine/geometry.ts'
import type { PixelEdit } from '../engine/history.ts'
import { Raster, type Rect } from '../engine/raster.ts'
import { coverageReader, rasterArea } from '../engine/sampling.ts'
import { notify } from '../store.ts'

export interface PaintTarget {
  layer: CanvasLayer
  raster: Raster
  /** Raster pixels to document pixels. */
  toDocument: Mat
  mask: boolean
  /** The document with the target made ready: shown while painting, recorded with the pixels. */
  state: DocState
}

/** Painting goes into the active layer's mask when it is targeted on its thumbnail, or when the layer is a folder or an adjustment (which have no pixels). */
export const paintsMask = (doc: CanvasDocument): boolean => Boolean(doc.active?.mask) && (doc.editingMask || Boolean(doc.active?.adjustment) || Boolean(doc.active?.isGroup))

/** Why the active layer cannot be painted on, or null when it can. */
export function cannotPaint(doc: CanvasDocument): string | null {
  const layer = doc.active

  if (!layer) {
    return 'Pick a layer to paint on'
  }

  if (layer.isGroup && !paintsMask(doc)) {
    return `${layer.name} is a folder: pick a layer inside it, or add a mask to paint on`
  }

  if (layer.adjustment && !paintsMask(doc)) {
    return `${layer.name} is an adjustment layer: add a mask to paint on it`
  }

  return isShown(doc.state, layer) ? null : `${layer.name} is hidden: show it to paint on it`
}

/** The active layer made ready to paint on; null (with a notice) when it cannot be. */
export function paintTarget(doc: CanvasDocument): PaintTarget | null {
  const reason = cannotPaint(doc)
  const layer = doc.active

  if (reason || !layer) {
    notify(reason ?? 'Pick a layer to paint on', 'error')

    return null
  }

  let state = doc.state

  if (paintsMask(doc) && layer.mask) {
    let mask = layer.mask
    const placement = layer.maskLinked === false && layer.maskPlacement ? layer.maskPlacement : layer.transform

    if (mask.width === 1 && mask.height === 1) {
      const width = layer.pixels?.width ?? Math.max(1, Math.round(placement.size[0]))
      const height = layer.pixels?.height ?? Math.max(1, Math.round(placement.size[1]))
      mask = Raster.filled(width, height, mask.data[0], 1)
      state = withLayer(state, layer.id, { mask })
    }

    return { layer: findLayer(state, layer.id)!, raster: mask, toDocument: pixelToDocument(placement, mask.width, mask.height), mask: true, state }
  }

  let pixels = layer.pixels

  if (!pixels) {
    pixels = new Raster(state.width, state.height)
    state = withLayer(state, layer.id, { pixels, transform: defaultTransform(state.width, state.height) })
  }

  if (layer.text || layer.shape) {
    state = withLayer(state, layer.id, { text: undefined, shape: undefined })
  }

  const ready = findLayer(state, layer.id)!

  return { layer: ready, raster: pixels, toDocument: pixelToDocument(ready.transform, pixels.width, pixels.height), mask: false, state }
}

/** The selection's strength over a target's pixels, times an opacity; everything without a selection. */
export function selectionStrength(target: PaintTarget, selection: Raster | null, opacity = 1): Strength {
  const read = coverageReader(selection, target.toDocument)

  return (x, y) => (read(x, y) / 255) * opacity
}

/** The target's pixels under a document area (the selection's bounds, say); the whole raster without one. */
export function targetArea(target: PaintTarget, documentRect: Rect | null): Rect | null {
  return documentRect ? rasterArea(documentRect, target.toDocument, target.raster.width, target.raster.height) : target.raster.bounds
}

/** Record pixels changed on a target as one step, with the state the target needed; nothing at all when no pixel changed. */
export function commitPixels(doc: CanvasDocument, before: DocState, target: PaintTarget, edit: PixelEdit, label: string): boolean {
  const entry = edit.finish(label)

  if (!entry) {
    if (doc.state !== before) {
      doc.preview(before)
    }

    return false
  }

  doc.commitFrom(label, before, [entry], target.state)

  return true
}
