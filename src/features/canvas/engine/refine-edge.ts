/*
 * Select and Mask: a selection (or a layer's mask) refined along its edge against the picture.
 *
 * - A band around the edge (Radius wide; with Smart Radius narrower where the picture's own edge is
 *   crisp and the full width where it is soft, like hair), plus whatever the Refine brush painted,
 *   is worked out again: each pixel's coverage from where its colour sits between the colours of
 *   the sure foreground and the sure background nearby, then smoothed with the guided filter (the
 *   same edge-following filter that refines the AI masks), steered by the picture's brightness.
 * - Then, over the whole edge: Smooth rounds off jagged outlines, Feather softens, Contrast sharpens
 *   a soft edge, and Shift Edge moves it in or out.
 * - Decontaminate Colors replaces the background colour left in half-covered edge pixels (hair
 *   against a sky) with the colour of the sure foreground nearby, for output to a new layer.
 */

import { boxMean, guidedFilter, remap } from '../ai/segment-math.ts'
import { gaussianPlane } from './filters.ts'
import { distanceField } from './selection.ts'

export interface RefineSettings {
  /** Pixels on each side of the edge worked out again (0 to 250). */
  radius: number
  smartRadius: boolean
  /** 0 to 100. */
  smooth: number
  /** Pixels (0 to 250). */
  feather: number
  /** Percent (0 to 100). */
  contrast: number
  /** Percent (−100 to 100): out (positive) or in. */
  shiftEdge: number
}

export const DEFAULT_REFINE: RefineSettings = { radius: 8, smartRadius: true, smooth: 0, feather: 0, contrast: 0, shiftEdge: 0 }

export const REFINE_RANGES: Record<keyof Omit<RefineSettings, 'smartRadius'>, [number, number]> = {
  radius: [0, 250],
  smooth: [0, 100],
  feather: [0, 250],
  contrast: [0, 100],
  shiftEdge: [-100, 100]
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value)

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp01((x - edge0) / (edge1 - edge0))

  return t * t * (3 - 2 * t)
}

/** Brightness (0 to 1) of straight RGBA pixels. */
export function brightnessOf(rgba: ArrayLike<number>, count: number): Float32Array {
  const out = new Float32Array(count)

  for (let i = 0; i < count; i++) {
    out[i] = (0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]) / 255
  }

  return out
}

/** Each pixel's distance (pixels) to the edge where the matte crosses a half. */
export function edgeDistance(matte: Float32Array, width: number, height: number): Float32Array {
  const toOutside = distanceField(width, height, (i) => matte[i] < 0.5)
  const toInside = distanceField(width, height, (i) => matte[i] >= 0.5)

  return Float32Array.from(matte, (value, i) => Math.sqrt(value >= 0.5 ? toOutside[i] : toInside[i]))
}

/** How crisp the picture's edges are around each pixel, 0 (soft) to 1 (a hard, high-contrast edge). */
export function crispness(light: Float32Array, width: number, height: number): Float32Array {
  const gradient = new Float32Array(light.length)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (dx: number, dy: number) => light[Math.min(height - 1, Math.max(0, y + dy)) * width + Math.min(width - 1, Math.max(0, x + dx))]
      const gx = at(1, -1) + 2 * at(1, 0) + at(1, 1) - at(-1, -1) - 2 * at(-1, 0) - at(-1, 1)
      const gy = at(-1, 1) + 2 * at(0, 1) + at(1, 1) - at(-1, -1) - 2 * at(0, -1) - at(1, -1)
      gradient[y * width + x] = Math.hypot(gx, gy) / 4
    }
  }

  // The strongest gradient near each pixel, eased: a step of a third of the range or more reads as crisp.
  return Float32Array.from(boxMean(gradient, width, height, 2), (value) => smoothstep(0.04, 0.2, value * 3))
}

/**
 * How much each pixel belongs to the band that is worked out again: 1 within the radius of the
 * edge (narrower where the picture's edge is crisp, with Smart Radius), fading over a pixel, and
 * wherever the Refine brush painted.
 */
export function edgeBand(distance: Float32Array, crisp: Float32Array | null, radius: number, painted?: Uint8Array | null): Float32Array {
  return Float32Array.from(distance, (d, i) => {
    const reach = crisp ? Math.max(1, radius * (1 - 0.75 * crisp[i])) : radius
    const band = radius > 0 ? 1 - smoothstep(reach, reach + 1, d) : 0

    return Math.max(band, painted ? painted[i] / 255 : 0)
  })
}

/** The average colour of the marked pixels around each pixel (and how many there are), within `reach`. */
function nearbyColour(rgba: ArrayLike<number>, marked: Float32Array, width: number, height: number, reach: number): { weight: Float32Array; colour: Float32Array[] } {
  const count = width * height

  return {
    weight: boxMean(marked, width, height, reach),
    colour: [0, 1, 2].map((c) => boxMean(Float32Array.from({ length: count }, (_, i) => (rgba[i * 4 + c] / 255) * marked[i]), width, height, reach))
  }
}

/** Sure pixels are this share of a window, at least, for their colour to count. */
const ENOUGH = 1e-3

/**
 * Each pixel's coverage from its colour: where it sits on the line from the background colour to
 * the foreground colour nearby (each the average of the sure pixels within `reach`, or within three
 * and nine times that where there are none so close, as deep inside a band the Refine brush
 * painted), with how sure that is (low where the two colours are alike). Unknown where either
 * colour has no samples.
 */
export function colourAlpha(rgba: ArrayLike<number>, matte: Float32Array, band: Float32Array, width: number, height: number, reach: number): { alpha: Float32Array; confidence: Float32Array } {
  const count = width * height
  const fg = Float32Array.from(matte, (value, i) => (value >= 0.95 && band[i] < 0.99 ? 1 : 0))
  const bg = Float32Array.from(matte, (value, i) => (value <= 0.05 && band[i] < 0.99 ? 1 : 0))
  const reaches = [reach, reach * 3, reach * 9].map((r) => Math.min(r, Math.max(width, height)))
  const fgScales = reaches.map((r) => nearbyColour(rgba, fg, width, height, r))
  const bgScales = reaches.map((r) => nearbyColour(rgba, bg, width, height, r))
  const alpha = new Float32Array(count)
  const confidence = new Float32Array(count)

  for (let i = 0; i < count; i++) {
    const fgAt = fgScales.find((scale) => scale.weight[i] >= ENOUGH)
    const bgAt = bgScales.find((scale) => scale.weight[i] >= ENOUGH)

    if (!fgAt || !bgAt) {
      alpha[i] = matte[i]
      continue
    }

    let along = 0
    let length = 0

    for (let c = 0; c < 3; c++) {
      const f = fgAt.colour[c][i] / fgAt.weight[i]
      const b = bgAt.colour[c][i] / bgAt.weight[i]
      const p = rgba[i * 4 + c] / 255
      along += (p - b) * (f - b)
      length += (f - b) * (f - b)
    }

    alpha[i] = length > 1e-6 ? clamp01(along / length) : matte[i]
    confidence[i] = smoothstep(0.003, 0.03, length)
  }

  return { alpha, confidence }
}

/** The box (pixels) around everything near the matte's edge, grown by `margin`; null when the matte has no edge. */
export function edgeBox(matte: Float32Array, width: number, height: number, margin: number, painted?: Uint8Array | null): { x: number; y: number; width: number; height: number } | null {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const value = matte[i]
      const soft = value > 0.002 && value < 0.998
      const step = (x + 1 < width && value >= 0.5 !== matte[i + 1] >= 0.5) || (y + 1 < height && value >= 0.5 !== matte[i + width] >= 0.5)

      if (soft || step || (painted && painted[i])) {
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
      }
    }
  }

  if (maxX < 0) {
    return null
  }

  const x0 = Math.max(0, Math.floor(minX - margin))
  const y0 = Math.max(0, Math.floor(minY - margin))
  const x1 = Math.min(width, Math.ceil(maxX + 1 + margin))
  const y1 = Math.min(height, Math.ceil(maxY + 1 + margin))

  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/** The global refinements on a matte, in Photoshop's order: Smooth, Feather, Contrast, Shift Edge. */
export function globalRefinements(matte: Float32Array, width: number, height: number, settings: RefineSettings): Float32Array {
  let out = matte

  if (settings.smooth > 0) {
    // A blur rounds the outline off; steepening its ramp again keeps the edge as crisp as it was.
    const sigma = (settings.smooth / 100) * 4
    const k = 1 + settings.smooth / 25
    out = gaussianPlane(out, width, height, sigma).map((value) => clamp01(0.5 + (value - 0.5) * k))
  }

  if (settings.feather > 0) {
    out = gaussianPlane(out, width, height, settings.feather / 2)
  }

  if (settings.contrast > 0) {
    const k = 1 + (settings.contrast / 100) * 19
    out = out.map((value) => clamp01(0.5 + (value - 0.5) * k))
  }

  if (settings.shiftEdge !== 0) {
    // A hard edge is softened a little first, so there is a ramp for the half-way point to move along.
    const sigma = 1 + (Math.abs(settings.shiftEdge) / 100) * 4
    const threshold = 0.5 - settings.shiftEdge / 200
    out = gaussianPlane(out, width, height, sigma).map((value) => remap(value, threshold))
  }

  return out
}

/**
 * The refined matte (0 to 1 a pixel) of a picture (straight RGBA, the same size): the band near the
 * edge (and painted with the Refine brush) worked out again from colour, then the global
 * refinements. Only the box around the edge is worked on; the rest keeps its value.
 */
export function refineMatte(matte: Float32Array, rgba: ArrayLike<number>, width: number, height: number, settings: RefineSettings, painted?: Uint8Array | null): Float32Array {
  const margin = Math.ceil(settings.radius + settings.feather * 1.5 + (settings.smooth / 100) * 12 + Math.abs(settings.shiftEdge / 100) * 12 + 8)
  const box = edgeBox(matte, width, height, margin, painted)
  const out = matte.slice()

  if (!box) {
    return out
  }

  // The box's own copies of everything, worked on as a picture of its own.
  const count = box.width * box.height
  const local = new Float32Array(count)
  const colour = new Uint8ClampedArray(count * 4)
  const brush = painted ? new Uint8Array(count) : null

  for (let y = 0; y < box.height; y++) {
    for (let x = 0; x < box.width; x++) {
      const i = (box.y + y) * width + box.x + x
      const j = y * box.width + x
      local[j] = matte[i]
      colour[j * 4] = rgba[i * 4]
      colour[j * 4 + 1] = rgba[i * 4 + 1]
      colour[j * 4 + 2] = rgba[i * 4 + 2]
      colour[j * 4 + 3] = 255

      if (brush && painted) {
        brush[j] = painted[i]
      }
    }
  }

  let refined: Float32Array = local

  if (settings.radius > 0 || brush) {
    const light = brightnessOf(colour, count)
    const band = edgeBand(edgeDistance(local, box.width, box.height), settings.smartRadius ? crispness(light, box.width, box.height) : null, settings.radius, brush)
    const reach = Math.max(3, Math.round(settings.radius + 4))
    const { alpha, confidence } = colourAlpha(colour, local, band, box.width, box.height, reach)
    const smoothed = guidedFilter(light, alpha, box.width, box.height, 2, 1e-3)
    refined = Float32Array.from(local, (value, i) => {
      const weight = band[i] * confidence[i]

      return weight > 0 ? value + (clamp01(smoothed[i]) - value) * weight : value
    })
  }

  refined = globalRefinements(refined, box.width, box.height, settings)

  for (let y = 0; y < box.height; y++) {
    out.set(refined.subarray(y * box.width, (y + 1) * box.width), (box.y + y) * width + box.x)
  }

  return out
}

/**
 * Decontaminate Colors: in half-covered pixels, the colour moves towards the sure foreground's
 * colour nearby by `amount` (0 to 1) times how uncovered the pixel is. Straight RGBA, a new copy.
 */
export function decontaminate(rgba: Uint8ClampedArray, matte: Float32Array, width: number, height: number, amount: number, reach: number): Uint8ClampedArray {
  const count = width * height
  const out = rgba.slice()
  const sure = Float32Array.from(matte, (value) => (value >= 0.98 ? 1 : 0))
  const weight = boxMean(sure, width, height, reach)
  const sums = [0, 1, 2].map((c) => boxMean(Float32Array.from({ length: count }, (_, i) => (rgba[i * 4 + c] / 255) * sure[i]), width, height, reach))

  for (let i = 0; i < count; i++) {
    const m = matte[i]

    if (m <= 0.002 || m >= 0.98 || weight[i] < 1e-4) {
      continue
    }

    const k = amount * (1 - m)

    for (let c = 0; c < 3; c++) {
      const target = (sums[c][i] / weight[i]) * 255
      out[i * 4 + c] = rgba[i * 4 + c] + (target - rgba[i * 4 + c]) * k
    }
  }

  return out
}

export type RefineView = 'overlay' | 'black' | 'white' | 'bw' | 'ants'

export const REFINE_VIEWS: { id: RefineView; label: string }[] = [
  { id: 'overlay', label: 'Overlay' },
  { id: 'black', label: 'On Black' },
  { id: 'white', label: 'On White' },
  { id: 'bw', label: 'Black & White' },
  { id: 'ants', label: 'Marching Ants' }
]

/** What a view mode shows of a picture and its matte, as opaque RGBA (marching ants show the picture itself). */
export function viewPixels(rgba: ArrayLike<number>, matte: Float32Array, view: RefineView): Uint8ClampedArray {
  const count = matte.length
  const out = new Uint8ClampedArray(count * 4)

  for (let i = 0; i < count; i++) {
    const m = matte[i]

    for (let c = 0; c < 3; c++) {
      const p = rgba[i * 4 + c]
      out[i * 4 + c] = view === 'bw' ? m * 255 : view === 'black' ? p * m : view === 'white' ? p * m + 255 * (1 - m) : view === 'overlay' ? p + ((c === 0 ? 255 : 0) - p) * 0.55 * (1 - m) : p
    }

    out[i * 4 + 3] = 255
  }

  return out
}
