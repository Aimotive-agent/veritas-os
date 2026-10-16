/*
 * The canvas itself: Canvas Size and Crop change its bounds and leave every layer's pixels as they
 * are (layers and guides shift with the new top-left corner); Image Size scales everything, layer
 * pixels and masks resampled only when asked; Rotate and Flip Canvas turn the whole document; Trim
 * finds the box worth keeping. The selection follows each change, as it would on screen.
 */

import type { Guide, LayerTransform, Vec2 } from '../../../../shared/canvas/comp-format.ts'
import type { CanvasLayer, DocState } from './document.ts'
import { decompose, type Mat, multiply, rotate, scale, tidy, translate, unitToDocument } from './geometry.ts'
import { Raster, type Rect, resample } from './raster.ts'

export const ANCHORS = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'] as const
export type Anchor = (typeof ANCHORS)[number]

/** Where an anchor sits across and down: 0, a half or 1. */
export function anchorFactors(anchor: Anchor): Vec2 {
  const index = ANCHORS.indexOf(anchor)

  return [(index % 3) / 2, Math.floor(index / 3) / 2]
}

/** How far the old canvas's top-left moves when the canvas grows or shrinks around an anchor (whole pixels). */
export function anchorOffset(from: { width: number; height: number }, to: { width: number; height: number }, anchor: Anchor): Vec2 {
  const [ax, ay] = anchorFactors(anchor)

  return [Math.round((to.width - from.width) * ax), Math.round((to.height - from.height) * ay)]
}

const shifted = (t: LayerTransform, dx: number, dy: number): LayerTransform => ({ ...t, origin: [t.origin[0] + dx, t.origin[1] + dy] })

/** The selection on a canvas of a new size, moved by the offset; null when none of it is left. */
function placedSelection(selection: Raster | null, width: number, height: number, dx: number, dy: number): Raster | null {
  if (!selection) {
    return null
  }

  const out = selection.crop({ x: -dx, y: -dy, width, height })

  return out.data.some((value) => value > 0) ? out : null
}

/** The document on a canvas of a new size, everything moved by `offset`: layers keep their pixels, guides move with them. */
export function resizeCanvas(state: DocState, width: number, height: number, offset: Vec2): DocState {
  const [dx, dy] = offset

  return {
    ...state,
    width,
    height,
    layers: state.layers.map((layer) => ({
      ...layer,
      transform: shifted(layer.transform, dx, dy),
      ...(layer.maskPlacement ? { maskPlacement: shifted(layer.maskPlacement, dx, dy) } : {})
    })),
    guides: state.guides.map((guide) => ({ ...guide, position: guide.position + (guide.axis === 'vertical' ? dx : dy) })),
    selection: placedSelection(state.selection, width, height, dx, dy)
  }
}

/** Crop: the canvas becomes `rect` (document pixels, whole), nothing else changes. */
export function cropCanvas(state: DocState, rect: Rect): DocState {
  const x = Math.round(rect.x)
  const y = Math.round(rect.y)

  return resizeCanvas(state, Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height)), [-x, -y])
}

/** A placement after the whole document went through `m`, flips read as `hint` has them. */
const carried = (t: LayerTransform, m: Mat, hint: LayerTransform = t): LayerTransform => ({ ...decompose(multiply(m, unitToDocument(t)), hint), sampling: t.sampling })

/** A mask resampled for a layer whose pixels grew or shrank (a uniform 1×1 mask stays as it is). */
function resampledMask(mask: Raster | null, sx: number, sy: number): Raster | null {
  if (!mask || (mask.width === 1 && mask.height === 1)) {
    return mask
  }

  return resample(mask, Math.max(1, Math.round(mask.width * sx)), Math.max(1, Math.round(mask.height * sy)))
}

/**
 * Image Size: the document scaled to `width`×`height`. Every placement and guide scales; with
 * `resamplePixels`, each layer's pixels (and mask) are resampled to keep their density, otherwise
 * they stay as they are and are drawn larger or smaller.
 */
export function scaleImage(state: DocState, width: number, height: number, resamplePixels: boolean): DocState {
  const sx = width / state.width
  const sy = height / state.height
  const m = scale(sx, sy)
  const layers = state.layers.map((layer): CanvasLayer => {
    const transform = carried(layer.transform, m)
    const next: CanvasLayer = { ...layer, transform, ...(layer.maskPlacement ? { maskPlacement: carried(layer.maskPlacement, m) } : {}) }

    if (!resamplePixels || !layer.pixels) {
      return next
    }

    const fx = transform.size[0] / Math.max(1e-9, layer.transform.size[0])
    const fy = transform.size[1] / Math.max(1e-9, layer.transform.size[1])
    const pixels = resample(layer.pixels, Math.max(1, Math.round(layer.pixels.width * fx)), Math.max(1, Math.round(layer.pixels.height * fy)))

    return { ...next, pixels, mask: layer.maskLinked === false ? layer.mask : resampledMask(layer.mask, fx, fy) }
  })

  return {
    ...state,
    width,
    height,
    layers,
    guides: state.guides.map((guide) => ({ ...guide, position: tidy(guide.position * (guide.axis === 'vertical' ? sx : sy)) })),
    selection: state.selection ? resample(state.selection, width, height) : null
  }
}

/** A raster turned a quarter turn clockwise (1), a half turn (2) or a quarter turn back (3). */
export function rotateRaster(raster: Raster, turns: 1 | 2 | 3): Raster {
  const { width, height, channels, data } = raster
  const out = turns === 2 ? new Raster(width, height, channels) : new Raster(height, width, channels)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [nx, ny] = turns === 1 ? [height - 1 - y, x] : turns === 2 ? [width - 1 - x, height - 1 - y] : [y, width - 1 - x]
      const s = (y * width + x) * channels
      const o = (ny * out.width + nx) * channels

      for (let c = 0; c < channels; c++) {
        out.data[o + c] = data[s + c]
      }
    }
  }

  return out
}

/** Rotate Canvas: the whole document a quarter turn clockwise (1), a half turn (2) or a quarter turn back (3). */
export function rotateCanvas(state: DocState, turns: 1 | 2 | 3): DocState {
  const { width: w, height: h } = state
  const m: Mat = turns === 1 ? { a: 0, b: 1, c: -1, d: 0, e: h, f: 0 } : turns === 2 ? { a: -1, b: 0, c: 0, d: -1, e: w, f: h } : { a: 0, b: -1, c: 1, d: 0, e: 0, f: w }
  const guide = (g: Guide): Guide => {
    if (turns === 2) {
      return { ...g, position: g.axis === 'vertical' ? w - g.position : h - g.position }
    }

    if (turns === 1) {
      return g.axis === 'vertical' ? { ...g, axis: 'horizontal' } : { ...g, axis: 'vertical', position: h - g.position }
    }

    return g.axis === 'vertical' ? { ...g, axis: 'horizontal', position: w - g.position } : { ...g, axis: 'vertical' }
  }

  return {
    ...state,
    width: turns === 2 ? w : h,
    height: turns === 2 ? h : w,
    layers: state.layers.map((layer) => ({ ...layer, transform: carried(layer.transform, m), ...(layer.maskPlacement ? { maskPlacement: carried(layer.maskPlacement, m) } : {}) })),
    guides: state.guides.map(guide),
    selection: state.selection ? rotateRaster(state.selection, turns) : null
  }
}

/**
 * Every layer turned `degrees` clockwise around the canvas's centre (for straightening): placements
 * turn, pixels stay as they are. The canvas keeps its size, so a crop usually follows; the
 * selection goes, as it no longer fits the picture.
 */
export function rotateLayers(state: DocState, degrees: number): DocState {
  if (!degrees) {
    return state
  }

  const m = multiply(translate(state.width / 2, state.height / 2), multiply(rotate(degrees), translate(-state.width / 2, -state.height / 2)))

  return {
    ...state,
    layers: state.layers.map((layer) => ({ ...layer, transform: carried(layer.transform, m), ...(layer.maskPlacement ? { maskPlacement: carried(layer.maskPlacement, m) } : {}) })),
    selection: null
  }
}

/** Flip Canvas: the whole document mirrored left to right, or top to bottom. */
export function flipCanvas(state: DocState, horizontal: boolean): DocState {
  const m: Mat = horizontal ? { a: -1, b: 0, c: 0, d: 1, e: state.width, f: 0 } : { a: 1, b: 0, c: 0, d: -1, e: 0, f: state.height }
  const hint = (t: LayerTransform): LayerTransform => (horizontal ? { ...t, flipX: !t.flipX } : { ...t, flipY: !t.flipY })
  let selection: Raster | null = null

  if (state.selection) {
    selection = state.selection.clone()
    selection.flip(horizontal)
  }

  return {
    ...state,
    layers: state.layers.map((layer) => ({
      ...layer,
      transform: carried(layer.transform, m, hint(layer.transform)),
      ...(layer.maskPlacement ? { maskPlacement: carried(layer.maskPlacement, m, hint(layer.maskPlacement)) } : {})
    })),
    guides: state.guides.map((g) => (horizontal === (g.axis === 'vertical') ? { ...g, position: (horizontal ? state.width : state.height) - g.position } : g)),
    selection
  }
}

export type TrimBy = 'transparent' | 'top-left'

/** Trim: the box left after cutting away transparent edges (or edges the exact colour of the top-left pixel); null when nothing is left. */
export function trimRect(raster: Raster, by: TrimBy): Rect | null {
  const { width, height, data } = raster

  if (by === 'transparent') {
    return raster.opaqueBounds()
  }

  const [r, g, b, a] = data.subarray(0, 4)
  const differs = (i: number) => data[i] !== r || data[i + 1] !== g || data[i + 2] !== b || data[i + 3] !== a
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (differs((y * width + x) * 4)) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }

  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}
