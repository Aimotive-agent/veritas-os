/*
 * Between a layer's pixels and the document: which raster pixels a document area falls on, what a
 * raster shows over a document area, and how much of each raster pixel a selection covers. Tools
 * that paint, fill or copy go through these, so transformed layers behave like plain ones.
 */

import type { Vec2 } from '../../../../shared/canvas/comp-format.ts'
import { apply, invert, type Mat, pixelOffset } from './geometry.ts'
import { clipRect, Raster, type Rect } from './raster.ts'

/** The raster pixels a document rectangle falls on (rounded out by a pixel, cut to the raster); null when it misses. */
export function rasterArea(rect: Rect, toDocument: Mat, width: number, height: number): Rect | null {
  const back = invert(toDocument)
  const points: Vec2[] = [
    [rect.x, rect.y],
    [rect.x + rect.width, rect.y],
    [rect.x + rect.width, rect.y + rect.height],
    [rect.x, rect.y + rect.height]
  ].map((point) => apply(back, point as Vec2))
  const xs = points.map((point) => point[0])
  const ys = points.map((point) => point[1])
  const x = Math.min(...xs) - 1
  const y = Math.min(...ys) - 1

  return clipRect({ x, y, width: Math.max(...xs) + 1 - x, height: Math.max(...ys) + 1 - y }, width, height)
}

/**
 * How much a document-sized mask (a selection) covers each pixel of a raster placed by
 * `toDocument`, read at the pixel's centre: 0 to 255. Without a mask everything is covered.
 */
export function coverageReader(mask: Raster | null, toDocument: Mat): (px: number, py: number) => number {
  if (!mask) {
    return () => 255
  }

  const { width, height, data } = mask
  const offset = pixelOffset(toDocument)

  if (offset) {
    const [ox, oy] = offset

    return (px, py) => {
      const x = px + ox
      const y = py + oy

      return x >= 0 && y >= 0 && x < width && y < height ? data[y * width + x] : 0
    }
  }

  const { a, b, c, d, e, f } = toDocument

  return (px, py) => {
    const x = Math.floor(a * (px + 0.5) + c * (py + 0.5) + e)
    const y = Math.floor(b * (px + 0.5) + d * (py + 0.5) + f)

    return x >= 0 && y >= 0 && x < width && y < height ? data[y * width + x] : 0
  }
}

/**
 * Bilinear sample at a position in pixel-centre units (pixel i's centre is at i), with the world
 * outside the raster transparent. Colour is weighted by alpha, so edges never darken.
 */
export function sampleBilinear(raster: Raster, x: number, y: number, out: Uint8ClampedArray, at = 0): void {
  const { width, height, channels, data } = raster
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const tx = x - x0
  const ty = y - y0
  let r = 0
  let g = 0
  let b = 0
  let alpha = 0

  for (let k = 0; k < 4; k++) {
    const sx = x0 + (k & 1)
    const sy = y0 + (k >> 1)

    if (sx < 0 || sy < 0 || sx >= width || sy >= height) {
      continue
    }

    const weight = (k & 1 ? tx : 1 - tx) * (k >> 1 ? ty : 1 - ty)

    if (!weight) {
      continue
    }

    const i = (sy * width + sx) * channels

    if (channels === 1) {
      alpha += data[i] * weight
    } else {
      const a = data[i + 3] * weight
      r += data[i] * a
      g += data[i + 1] * a
      b += data[i + 2] * a
      alpha += a
    }
  }

  if (channels === 1) {
    out[at] = alpha

    return
  }

  out[at + 3] = alpha
  out[at] = alpha ? r / alpha : 0
  out[at + 1] = alpha ? g / alpha : 0
  out[at + 2] = alpha ? b / alpha : 0
}

/** What a raster placed by `toDocument` shows over a document rectangle, one value a document pixel (before opacity and masks). */
export function toDocumentPixels(raster: Raster, toDocument: Mat, rect: Rect): Raster {
  const width = Math.max(1, Math.round(rect.width))
  const height = Math.max(1, Math.round(rect.height))
  const offset = pixelOffset(toDocument)

  // Whole pixels at 1:1 copy straight across.
  if (offset) {
    return raster.crop({ x: Math.round(rect.x) - offset[0], y: Math.round(rect.y) - offset[1], width, height })
  }

  const out = new Raster(width, height, raster.channels)
  const back = invert(toDocument)
  const sample = new Uint8ClampedArray(4)

  for (let y = 0; y < height; y++) {
    const dy = rect.y + y + 0.5

    for (let x = 0; x < width; x++) {
      const dx = rect.x + x + 0.5
      const u = back.a * dx + back.c * dy + back.e - 0.5
      const v = back.b * dx + back.d * dy + back.f - 0.5

      if (u < -1 || v < -1 || u > raster.width || v > raster.height) {
        continue
      }

      sampleBilinear(raster, u, v, sample)
      const o = (y * width + x) * raster.channels

      for (let c = 0; c < raster.channels; c++) {
        out.data[o + c] = sample[c]
      }
    }
  }

  return out
}

/** The document pixels a placed raster covers, rounded out and cut to the document; null when it is all outside. */
export function documentArea(toDocument: Mat, width: number, height: number, docWidth: number, docHeight: number): Rect | null {
  const points: Vec2[] = [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height]
  ].map((point) => apply(toDocument, point as Vec2))
  const xs = points.map((point) => point[0])
  const ys = points.map((point) => point[1])
  const x = Math.min(...xs)
  const y = Math.min(...ys)

  return clipRect({ x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }, docWidth, docHeight)
}

/**
 * A selection from a raster's opacity (its alpha, or a mask's values) where it lands in the
 * document; null when it covers nothing there.
 */
export function selectionFromRaster(raster: Raster, toDocument: Mat, docWidth: number, docHeight: number): Raster | null {
  const area = documentArea(toDocument, raster.width, raster.height, docWidth, docHeight)

  if (!area) {
    return null
  }

  const placed = toDocumentPixels(raster, toDocument, area)
  const out = new Raster(docWidth, docHeight, 1)
  const offset = raster.channels === 4 ? 3 : 0
  let any = false

  for (let y = 0; y < area.height; y++) {
    for (let x = 0; x < area.width; x++) {
      const value = placed.data[(y * area.width + x) * raster.channels + offset]

      if (value) {
        out.data[(area.y + y) * docWidth + area.x + x] = value
        any = true
      }
    }
  }

  return any ? out : null
}
