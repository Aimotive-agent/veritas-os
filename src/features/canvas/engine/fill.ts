/*
 * Fills for Veritas Canvas: finding the pixels like a clicked one (the paint bucket and the magic
 * wand), and laying a colour, a gradient (see gradient.ts) or transparency into a layer's pixels
 * with a strength for each pixel (the selection, the found area and the tool's opacity together).
 * Masks take gray.
 */

import type { Mat } from './geometry.ts'
import { type GradientLine, gradientPosition, TABLE_SIZE } from './gradient.ts'
import { Raster, type Rect } from './raster.ts'

export type RGBA = [number, number, number, number]

/** How strongly a raster pixel takes the fill, 0 to 1. */
export type Strength = (px: number, py: number) => number

/** A colour as a mask value: its luminance. */
export const grayOf = (r: number, g: number, b: number): number => 0.299 * r + 0.587 * g + 0.114 * b

/**
 * Pixels like the one at (x, y): every channel within `tolerance` (0 to 255) of it, compared with
 * colour times alpha so all transparent pixels match each other. With `contiguous`, only those
 * joined to it (side by side). 255 marks them; null when (x, y) is outside the raster.
 */
export function similarPixels(source: Raster, x: number, y: number, tolerance: number, contiguous: boolean): Raster | null {
  const { width, height, channels, data } = source
  const sx = Math.floor(x)
  const sy = Math.floor(y)

  if (sx < 0 || sy < 0 || sx >= width || sy >= height) {
    return null
  }

  const seed = sy * width + sx
  const out = new Raster(width, height, 1)
  const marks = out.data
  let match: (i: number) => boolean

  if (channels === 1) {
    const value = data[seed]
    match = (i) => Math.abs(data[i] - value) <= tolerance
  } else {
    const a = data[seed * 4 + 3]
    const r = (data[seed * 4] * a) / 255
    const g = (data[seed * 4 + 1] * a) / 255
    const b = (data[seed * 4 + 2] * a) / 255
    match = (i) => {
      const o = i * 4
      const alpha = data[o + 3]

      return Math.abs(alpha - a) <= tolerance && Math.abs((data[o] * alpha) / 255 - r) <= tolerance && Math.abs((data[o + 1] * alpha) / 255 - g) <= tolerance && Math.abs((data[o + 2] * alpha) / 255 - b) <= tolerance
    }
  }

  if (!contiguous) {
    for (let i = 0; i < marks.length; i++) {
      if (match(i)) {
        marks[i] = 255
      }
    }

    return out
  }

  // Scanline flood fill: fill a run, then look for runs to fill above and below it.
  const stack = [sx, sy]

  while (stack.length) {
    const py = stack.pop()!
    const px = stack.pop()!
    const row = py * width

    if (marks[row + px] || !match(row + px)) {
      continue
    }

    let left = px
    let right = px

    while (left > 0 && !marks[row + left - 1] && match(row + left - 1)) {
      left--
    }

    while (right < width - 1 && !marks[row + right + 1] && match(row + right + 1)) {
      right++
    }

    marks.fill(255, row + left, row + right + 1)

    for (const ny of [py - 1, py + 1]) {
      if (ny < 0 || ny >= height) {
        continue
      }

      const next = ny * width
      let inRun = false

      for (let nx = left; nx <= right; nx++) {
        const fits = !marks[next + nx] && match(next + nx)

        if (fits && !inRun) {
          stack.push(nx, ny)
        }

        inRun = fits
      }
    }
  }

  return out
}

/** Lay colour over a raster pixel by `amount` (0 to 1): straight alpha over what is there, or towards gray on a mask. */
function lay(raster: Raster, index: number, r: number, g: number, b: number, a: number, amount: number): void {
  const { data } = raster

  if (raster.channels === 1) {
    const k = amount * (a / 255)
    data[index] = data[index] + (grayOf(r, g, b) - data[index]) * k

    return
  }

  const o = index * 4
  const sa = (a / 255) * amount

  if (sa <= 0) {
    return
  }

  const da = data[o + 3] / 255
  const outA = sa + da * (1 - sa)
  const keep = da * (1 - sa)
  data[o] = (r * sa + data[o] * keep) / outA
  data[o + 1] = (g * sa + data[o + 1] * keep) / outA
  data[o + 2] = (b * sa + data[o + 2] * keep) / outA
  data[o + 3] = outA * 255
}

/** Fill an area of a raster with one colour, each pixel by its strength. */
export function fillRaster(raster: Raster, area: Rect, colour: RGBA, strength: Strength): void {
  const [r, g, b, a] = colour

  for (let y = area.y; y < area.y + area.height; y++) {
    for (let x = area.x; x < area.x + area.width; x++) {
      const amount = strength(x, y)

      if (amount > 0) {
        lay(raster, y * raster.width + x, r, g, b, a, Math.min(1, amount))
      }
    }
  }

  raster.touch(area)
}

/** Take pixels away (alpha on a layer; hidden on a mask), each by its strength. */
export function eraseRaster(raster: Raster, area: Rect, strength: Strength): void {
  const { data, channels, width } = raster

  for (let y = area.y; y < area.y + area.height; y++) {
    for (let x = area.x; x < area.x + area.width; x++) {
      const amount = Math.min(1, strength(x, y))

      if (amount > 0) {
        const o = (y * width + x) * channels + (channels === 4 ? 3 : 0)
        data[o] = data[o] * (1 - amount)
      }
    }
  }

  raster.touch(area)
}

export interface GradientSpec extends GradientLine {
  /** The colours along it, from `gradientTable`. */
  table: Float32Array
}

/** A 4×4 ordered dither, so long gradients do not band. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((value) => (value + 0.5) / 16 - 0.5)

/** Lay a gradient into an area of a raster placed by `toDocument`, each pixel by its strength. */
export function paintGradient(raster: Raster, area: Rect, toDocument: Mat, spec: GradientSpec, strength: Strength): void {
  const { table } = spec
  const last = TABLE_SIZE - 1

  for (let y = area.y; y < area.y + area.height; y++) {
    for (let x = area.x; x < area.x + area.width; x++) {
      const amount = strength(x, y)

      if (amount <= 0) {
        continue
      }

      const dx = toDocument.a * (x + 0.5) + toDocument.c * (y + 0.5) + toDocument.e
      const dy = toDocument.b * (x + 0.5) + toDocument.d * (y + 0.5) + toDocument.f
      // Between two entries of the table, mixed, so even a long gradient steps smoothly.
      const at = gradientPosition(spec, dx, dy) * last
      const entry = Math.min(last - 1, Math.floor(at))
      const k = at - entry
      const o = entry * 4
      const dither = BAYER[(y & 3) * 4 + (x & 3)]
      const channel = (c: number) => Math.max(0, Math.min(255, table[o + c] + (table[o + 4 + c] - table[o + c]) * k + dither))
      lay(raster, y * raster.width + x, channel(0), channel(1), channel(2), channel(3), Math.min(1, amount))
    }
  }

  raster.touch(area)
}
