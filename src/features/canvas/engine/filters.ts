/*
 * The Filter menu's destructive filters, in plain TypeScript so a worker runs them and tests check
 * them: Gaussian Blur, Motion Blur and High Pass; Unsharp Mask and a simple Smart Sharpen; Reduce
 * Noise (edge-preserving: a guided filter steered by the picture's own brightness, with colour noise
 * smoothed along it); Add Noise and Median. Colour is blurred premultiplied, so transparent pixels
 * never bleed dark into edges, and the picture's edge pixels carry on past it, so a blur does not
 * fade at the border. A mask (one channel) is filtered as a gray picture.
 */

import type { Vec2 } from '../../../../shared/canvas/comp-format.ts'
import { guidedCoefficients } from '../ai/segment-math.ts'
import { addNoise, luma, motionDirection } from './adjust-math.ts'
import { boxPass, boxSizes } from './selection.ts'

export const FILTER_KINDS = ['gaussianBlur', 'motionBlur', 'highPass', 'unsharpMask', 'smartSharpen', 'reduceNoise', 'addNoise', 'median'] as const
export type FilterKind = (typeof FILTER_KINDS)[number]

export interface FilterSettings {
  gaussianBlur: { radius: number }
  motionBlur: { angle: number; distance: number }
  highPass: { radius: number }
  unsharpMask: { amount: number; radius: number; threshold: number }
  smartSharpen: { amount: number; radius: number; reduceNoise: number }
  reduceNoise: { strength: number; preserveDetails: number; colorNoise: number }
  addNoise: { amount: number; gaussian: boolean; monochromatic: boolean; seed: number }
  median: { radius: number }
}

export type FilterSpec = { [K in FilterKind]: { kind: K } & FilterSettings[K] }[FilterKind]

export const FILTER_NAMES: Record<FilterKind, string> = {
  gaussianBlur: 'Gaussian Blur',
  motionBlur: 'Motion Blur',
  highPass: 'High Pass',
  unsharpMask: 'Unsharp Mask',
  smartSharpen: 'Smart Sharpen',
  reduceNoise: 'Reduce Noise',
  addNoise: 'Add Noise',
  median: 'Median'
}

export const FILTER_DEFAULTS: { [K in FilterKind]: FilterSettings[K] } = {
  gaussianBlur: { radius: 4 },
  motionBlur: { angle: 0, distance: 20 },
  highPass: { radius: 10 },
  unsharpMask: { amount: 100, radius: 1, threshold: 0 },
  smartSharpen: { amount: 150, radius: 1, reduceNoise: 10 },
  reduceNoise: { strength: 6, preserveDetails: 60, colorNoise: 45 },
  addNoise: { amount: 10, gaussian: false, monochromatic: true, seed: 0 },
  median: { radius: 2 }
}

export interface FilterField {
  label: string
  min: number
  max: number
  step: number
  unit?: string
  /** Sliders over wide ranges move on a square, giving the small values room. */
  curve?: 'square'
}

/** Each numeric setting's range (both ends allowed), label and step; the others are on or off. */
export const FILTER_FIELDS: { [K in FilterKind]: Partial<Record<keyof FilterSettings[K], FilterField>> } = {
  gaussianBlur: { radius: { label: 'Radius', min: 0.1, max: 250, step: 0.1, unit: 'px', curve: 'square' } },
  motionBlur: { angle: { label: 'Angle', min: -90, max: 90, step: 1, unit: '°' }, distance: { label: 'Distance', min: 1, max: 2000, step: 1, unit: 'px', curve: 'square' } },
  highPass: { radius: { label: 'Radius', min: 0.1, max: 250, step: 0.1, unit: 'px', curve: 'square' } },
  unsharpMask: {
    amount: { label: 'Amount', min: 1, max: 500, step: 1, unit: '%' },
    radius: { label: 'Radius', min: 0.1, max: 250, step: 0.1, unit: 'px', curve: 'square' },
    threshold: { label: 'Threshold', min: 0, max: 255, step: 1, unit: 'levels' }
  },
  smartSharpen: {
    amount: { label: 'Amount', min: 1, max: 500, step: 1, unit: '%' },
    radius: { label: 'Radius', min: 0.1, max: 64, step: 0.1, unit: 'px', curve: 'square' },
    reduceNoise: { label: 'Reduce noise', min: 0, max: 100, step: 1, unit: '%' }
  },
  reduceNoise: {
    strength: { label: 'Strength', min: 0, max: 10, step: 1 },
    preserveDetails: { label: 'Preserve details', min: 0, max: 100, step: 1, unit: '%' },
    colorNoise: { label: 'Reduce colour noise', min: 0, max: 100, step: 1, unit: '%' }
  },
  addNoise: { amount: { label: 'Amount', min: 0.1, max: 400, step: 0.1, unit: '%', curve: 'square' }, seed: { label: 'Pattern', min: 0, max: 4_294_967_295, step: 1 } },
  median: { radius: { label: 'Radius', min: 1, max: 25, step: 1, unit: 'px' } }
}

/** A filter's settings checked against their ranges, with the defaults filled in. */
export function checkFilter(kind: FilterKind, settings: Record<string, unknown> = {}): FilterSpec {
  const defaults = FILTER_DEFAULTS[kind] as unknown as Record<string, number | boolean>
  const fields = FILTER_FIELDS[kind] as Record<string, FilterField | undefined>
  const out: Record<string, number | boolean> = { ...defaults }

  for (const [key, value] of Object.entries(settings)) {
    if (!(key in defaults)) {
      throw new Error(`${FILTER_NAMES[kind]} has no setting “${key}”: it takes ${Object.keys(defaults).join(', ')}`)
    }

    if (typeof defaults[key] === 'boolean') {
      if (typeof value !== 'boolean') {
        throw new Error(`${key} is true or false`)
      }

      out[key] = value
      continue
    }

    const field = fields[key]!
    const number = typeof value === 'number' ? value : Number(value)

    if (!Number.isFinite(number) || number < field.min || number > field.max) {
      throw new Error(`${key} must be from ${field.min} to ${field.max}${field.unit && field.unit !== 'levels' ? ` ${field.unit}` : ''} (it was ${String(value)})`)
    }

    out[key] = field.step >= 1 ? Math.round(number) : number
  }

  return { kind, ...out } as FilterSpec
}

/** How far a filter reads around a pixel: the border a piece of a picture needs to come out as it would whole. */
export function filterReach(spec: FilterSpec): number {
  switch (spec.kind) {
    case 'gaussianBlur':
    case 'highPass':
      return Math.ceil(spec.radius * 3) + 2
    case 'unsharpMask':
    case 'smartSharpen':
      return Math.ceil(spec.radius * 3) + 3
    case 'motionBlur':
      return Math.ceil(spec.distance / 2) + 3
    case 'reduceNoise':
      return Math.round(1 + spec.strength * 0.5) * 6 + 4
    case 'median':
      return spec.radius
    case 'addNoise':
      return 0
  }
}

/** Pixels a filter works on: RGBA in straight alpha, or one channel (a mask). */
export interface Pixels {
  width: number
  height: number
  channels: 1 | 4
  data: Uint8ClampedArray
}

// Planes.

/** Colour planes premultiplied (red, green and blue times alpha, then alpha), 0 to 1; a mask is one plane. */
function toPlanes(pixels: Pixels): Float32Array[] {
  const count = pixels.width * pixels.height
  const { data, channels } = pixels

  if (channels === 1) {
    return [Float32Array.from(data, (value) => value / 255)]
  }

  const planes = [new Float32Array(count), new Float32Array(count), new Float32Array(count), new Float32Array(count)]

  for (let i = 0; i < count; i++) {
    const a = data[i * 4 + 3] / 255
    planes[0][i] = (data[i * 4] / 255) * a
    planes[1][i] = (data[i * 4 + 1] / 255) * a
    planes[2][i] = (data[i * 4 + 2] / 255) * a
    planes[3][i] = a
  }

  return planes
}

/** Premultiplied planes back to pixels (straight alpha). */
function fromPlanes(planes: Float32Array[], channels: 1 | 4): Uint8ClampedArray {
  const count = planes[0].length

  if (channels === 1) {
    return Uint8ClampedArray.from(planes[0], (value) => value * 255)
  }

  const out = new Uint8ClampedArray(count * 4)

  for (let i = 0; i < count; i++) {
    const a = planes[3][i]

    if (a <= 1e-6) {
      continue
    }

    out[i * 4] = (planes[0][i] / a) * 255
    out[i * 4 + 1] = (planes[1][i] / a) * 255
    out[i * 4 + 2] = (planes[2][i] / a) * 255
    out[i * 4 + 3] = a * 255
  }

  return out
}

/** One pass of a kernel along rows or columns, the edge pixels carried on past the edge. */
function convolve(source: Float32Array, width: number, height: number, kernel: Float32Array, vertical: boolean): Float32Array {
  const out = new Float32Array(source.length)
  const r = (kernel.length - 1) / 2
  const length = vertical ? height : width
  const lines = vertical ? width : height
  const step = vertical ? width : 1
  const line = new Float32Array(length + r * 2)

  for (let l = 0; l < lines; l++) {
    const base = vertical ? l : l * width

    // The line with its ends carried on, so the sum needs no checks.
    for (let i = -r; i < length + r; i++) {
      line[i + r] = source[base + Math.min(length - 1, Math.max(0, i)) * step]
    }

    for (let i = 0; i < length; i++) {
      let sum = 0

      for (let k = 0; k < kernel.length; k++) {
        sum += line[i + k] * kernel[k]
      }

      out[base + i * step] = sum
    }
  }

  return out
}

/** Below this sigma the blur takes an exact gaussian kernel; above it, three box passes, quick at any size. */
const EXACT_SIGMA = 2.5

/** A plane blurred by a gaussian of `sigma` pixels. */
export function gaussianPlane(plane: Float32Array, width: number, height: number, sigma: number): Float32Array {
  if (sigma < 0.05) {
    return plane.slice()
  }

  if (sigma < EXACT_SIGMA) {
    const r = Math.max(1, Math.ceil(sigma * 3))
    const kernel = Float32Array.from({ length: r * 2 + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)))
    const total = kernel.reduce((sum, w) => sum + w, 0)
    kernel.forEach((w, i) => (kernel[i] = w / total))

    return convolve(convolve(plane, width, height, kernel, false), width, height, kernel, true)
  }

  const a = plane.slice()
  const b = new Float32Array(plane.length)

  for (const size of boxSizes(sigma)) {
    const r = (size - 1) / 2
    boxPass(a, b, width, height, r, false)
    boxPass(b, a, width, height, r, true)
  }

  return a
}

/** Straight colour from premultiplied planes at a pixel (the pixel's own colour where it is clear). */
function straight(planes: Float32Array[], i: number, out: number[]): void {
  const a = planes[3][i]

  out[0] = a > 1e-6 ? Math.min(1, planes[0][i] / a) : 0
  out[1] = a > 1e-6 ? Math.min(1, planes[1][i] / a) : 0
  out[2] = a > 1e-6 ? Math.min(1, planes[2][i] / a) : 0
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value)

/** Pixels from straight colour planes (0 to 1) and the original alpha. */
function fromStraight(colour: Float32Array[], pixels: Pixels): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels.data.length)
  const count = pixels.width * pixels.height

  for (let i = 0; i < count; i++) {
    if (pixels.channels === 1) {
      out[i] = colour[0][i] * 255
      continue
    }

    out[i * 4] = colour[0][i] * 255
    out[i * 4 + 1] = colour[1][i] * 255
    out[i * 4 + 2] = colour[2][i] * 255
    out[i * 4 + 3] = pixels.data[i * 4 + 3]
  }

  return out
}

/** Straight colour planes (0 to 1): three for RGBA, one for a mask. */
function straightPlanes(pixels: Pixels): Float32Array[] {
  const count = pixels.width * pixels.height

  if (pixels.channels === 1) {
    return [Float32Array.from(pixels.data, (value) => value / 255)]
  }

  const planes = [new Float32Array(count), new Float32Array(count), new Float32Array(count)]

  for (let i = 0; i < count; i++) {
    planes[0][i] = pixels.data[i * 4] / 255
    planes[1][i] = pixels.data[i * 4 + 1] / 255
    planes[2][i] = pixels.data[i * 4 + 2] / 255
  }

  return planes
}

// Blurs.

function gaussianBlur(pixels: Pixels, radius: number): Uint8ClampedArray {
  return fromPlanes(
    toPlanes(pixels).map((plane) => gaussianPlane(plane, pixels.width, pixels.height, radius)),
    pixels.channels
  )
}

/** The integral of a row from its start up to `t` pixels along it, the end values carried on past the ends. */
function rowIntegral(row: Float32Array, prefix: Float64Array, t: number): number {
  const n = row.length

  if (t <= 0) {
    return row[0] * t
  }

  if (t >= n) {
    return prefix[n] + row[n - 1] * (t - n)
  }

  const i = Math.floor(t)

  return prefix[i] + row[i] * (t - i)
}

/** An even streak `length` pixels long through every pixel of every row. */
function streakRows(plane: Float32Array, width: number, height: number, length: number): Float32Array {
  const out = new Float32Array(plane.length)
  const prefix = new Float64Array(width + 1)
  const half = length / 2

  for (let y = 0; y < height; y++) {
    const row = plane.subarray(y * width, (y + 1) * width)

    for (let x = 0; x < width; x++) {
      prefix[x + 1] = prefix[x] + row[x]
    }

    for (let x = 0; x < width; x++) {
      const centre = x + 0.5
      out[y * width + x] = (rowIntegral(row, prefix, centre + half) - rowIntegral(row, prefix, centre - half)) / length
    }
  }

  return out
}

/** Bilinear sample at a position in pixel-centre units (pixel i's centre is at i), the edges carried on. */
function sample(plane: Float32Array, width: number, height: number, x: number, y: number): number {
  const cx = Math.min(width - 1, Math.max(0, x))
  const cy = Math.min(height - 1, Math.max(0, y))
  const x0 = Math.floor(cx)
  const y0 = Math.floor(cy)
  const x1 = Math.min(width - 1, x0 + 1)
  const y1 = Math.min(height - 1, y0 + 1)
  const tx = cx - x0
  const ty = cy - y0
  const top = plane[y0 * width + x0] * (1 - tx) + plane[y0 * width + x1] * tx
  const bottom = plane[y1 * width + x0] * (1 - tx) + plane[y1 * width + x1] * tx

  return top * (1 - ty) + bottom * ty
}

/**
 * A motion blur of one plane: an even streak `length` pixels long, `degrees` counterclockwise from
 * horizontal. A slanted streak turns the plane so it runs along rows, blurs them with running sums
 * (as quick for a long streak as a short one), and turns it back.
 */
export function motionPlane(plane: Float32Array, width: number, height: number, degrees: number, length: number): Float32Array {
  if (length <= 1) {
    return plane.slice()
  }

  const [ux, uy] = motionDirection(degrees)

  if (Math.abs(uy) < 1e-6) {
    return streakRows(plane, width, height, length)
  }

  if (Math.abs(ux) < 1e-6) {
    // Down the columns: the plane turned a quarter, blurred along its rows, turned back.
    const turned = new Float32Array(plane.length)

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        turned[x * height + y] = plane[y * width + x]
      }
    }

    const blurred = streakRows(turned, height, width, length)
    const out = new Float32Array(plane.length)

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        out[y * width + x] = blurred[x * height + y]
      }
    }

    return out
  }

  // The streak along u, the rows of the turned plane along v; it covers the picture with room for the streak.
  const [vx, vy] = [-uy, ux]
  const halfS = (width * Math.abs(ux) + height * Math.abs(uy)) / 2 + length / 2 + 2
  const halfT = (width * Math.abs(vx) + height * Math.abs(vy)) / 2 + 2
  const turnedWidth = Math.ceil(halfS * 2)
  const turnedHeight = Math.ceil(halfT * 2)
  const turned = new Float32Array(turnedWidth * turnedHeight)
  const cx = width / 2
  const cy = height / 2

  for (let j = 0; j < turnedHeight; j++) {
    const t = j + 0.5 - halfT

    for (let i = 0; i < turnedWidth; i++) {
      const s = i + 0.5 - halfS
      turned[j * turnedWidth + i] = sample(plane, width, height, cx + s * ux + t * vx - 0.5, cy + s * uy + t * vy - 0.5)
    }
  }

  const blurred = streakRows(turned, turnedWidth, turnedHeight, length)
  const out = new Float32Array(plane.length)

  for (let y = 0; y < height; y++) {
    const dy = y + 0.5 - cy

    for (let x = 0; x < width; x++) {
      const dx = x + 0.5 - cx
      out[y * width + x] = sample(blurred, turnedWidth, turnedHeight, dx * ux + dy * uy + halfS - 0.5, dx * vx + dy * vy + halfT - 0.5)
    }
  }

  return out
}

function motionBlur(pixels: Pixels, degrees: number, distance: number): Uint8ClampedArray {
  return fromPlanes(
    toPlanes(pixels).map((plane) => motionPlane(plane, pixels.width, pixels.height, degrees, distance)),
    pixels.channels
  )
}

/** The picture's colour (straight) and its blur (worked out premultiplied, then straightened), channel by channel. */
function withBlur(pixels: Pixels, radius: number): { colour: Float32Array[]; blurred: Float32Array[] } {
  const colour = straightPlanes(pixels)

  if (pixels.channels === 1) {
    return { colour, blurred: [gaussianPlane(colour[0], pixels.width, pixels.height, radius)] }
  }

  const planes = toPlanes(pixels).map((plane) => gaussianPlane(plane, pixels.width, pixels.height, radius))
  const count = pixels.width * pixels.height
  const blurred = [new Float32Array(count), new Float32Array(count), new Float32Array(count)]
  const rgb = [0, 0, 0]

  for (let i = 0; i < count; i++) {
    straight(planes, i, rgb)
    const known = planes[3][i] > 1e-6
    blurred[0][i] = known ? rgb[0] : colour[0][i]
    blurred[1][i] = known ? rgb[1] : colour[1][i]
    blurred[2][i] = known ? rgb[2] : colour[2][i]
  }

  return { colour, blurred }
}

function highPass(pixels: Pixels, radius: number): Uint8ClampedArray {
  const { colour, blurred } = withBlur(pixels, radius)

  return fromStraight(
    colour.map((plane, c) => plane.map((value, i) => clamp01(value - blurred[c][i] + 0.5))),
    pixels
  )
}

// Sharpening.

/**
 * Unsharp Mask: the picture plus `amount` times its difference from a blur of it; pixels whose
 * difference in brightness is under `threshold` levels are left alone, so smooth skin and sky do
 * not turn grainy.
 */
function unsharpMask(pixels: Pixels, amount: number, radius: number, threshold: number): Uint8ClampedArray {
  const { colour, blurred } = withBlur(pixels, radius)
  const k = amount / 100
  const count = pixels.width * pixels.height
  const out = colour.map((plane) => plane.slice())
  const gray = colour.length === 1
  const weights = gray ? [1] : [0.299, 0.587, 0.114]

  for (let i = 0; i < count; i++) {
    let brightness = 0

    for (let c = 0; c < colour.length; c++) {
      brightness += weights[c] * (colour[c][i] - blurred[c][i])
    }

    if (Math.abs(brightness) * 255 < threshold) {
      continue
    }

    for (let c = 0; c < colour.length; c++) {
      out[c][i] = clamp01(colour[c][i] + k * (colour[c][i] - blurred[c][i]))
    }
  }

  return fromStraight(out, pixels)
}

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp01((x - edge0) / (edge1 - edge0))

  return t * t * (3 - 2 * t)
}

/** The darkest and lightest brightness in each pixel's 3×3 neighbourhood. */
function neighbourRange(plane: Float32Array, width: number, height: number): { low: Float32Array; high: Float32Array } {
  const low = new Float32Array(plane.length)
  const high = new Float32Array(plane.length)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let lo = 1
      let hi = 0

      for (let dy = -1; dy <= 1; dy++) {
        const row = Math.min(height - 1, Math.max(0, y + dy)) * width

        for (let dx = -1; dx <= 1; dx++) {
          const value = plane[row + Math.min(width - 1, Math.max(0, x + dx))]
          lo = value < lo ? value : lo
          hi = value > hi ? value : hi
        }
      }

      low[y * width + x] = lo
      high[y * width + x] = hi
    }
  }

  return { low, high }
}

/** How far past its neighbours' brightness Smart Sharpen lets a pixel go, so edges get no bright or dark halos. */
const HALO_LIMIT = 0.02

/**
 * Smart Sharpen, simply: sharpening on brightness only (so colours do not fringe), small
 * differences (noise) eased out by `reduceNoise`, and each pixel kept within a little of its
 * neighbours' brightness range, so edges sharpen without halos.
 */
function smartSharpen(pixels: Pixels, amount: number, radius: number, reduceNoise: number): Uint8ClampedArray {
  const colour = straightPlanes(pixels)
  const count = pixels.width * pixels.height
  const light = colour.length === 1 ? colour[0] : Float32Array.from({ length: count }, (_, i) => luma([colour[0][i], colour[1][i], colour[2][i]]))
  const blurred = gaussianPlane(light, pixels.width, pixels.height, radius)
  const { low, high } = neighbourRange(light, pixels.width, pixels.height)
  const k = amount / 100
  const noise = (reduceNoise / 100) * 0.03
  const out = colour.map(() => new Float32Array(count))

  for (let i = 0; i < count; i++) {
    const detail = light[i] - blurred[i]
    const weight = noise > 0 ? smoothstep(noise * 0.5, noise * 1.5, Math.abs(detail)) : 1
    const sharpened = Math.min(high[i] + HALO_LIMIT, Math.max(low[i] - HALO_LIMIT, light[i] + k * detail * weight))
    const change = sharpened - light[i]

    for (let c = 0; c < colour.length; c++) {
      out[c][i] = clamp01(colour[c][i] + change)
    }
  }

  return fromStraight(out, pixels)
}

// Noise.

/**
 * Reduce Noise: brightness is smoothed with a guided filter steered by itself (it keeps edges and
 * evens out flat areas; Preserve Details keeps more of the fine texture), colour noise is smoothed
 * further along the brightness's edges, so colours do not bleed across them.
 */
function reduceNoise(pixels: Pixels, strength: number, preserveDetails: number, colorNoise: number): Uint8ClampedArray {
  const { width, height } = pixels
  const colour = straightPlanes(pixels)
  const count = width * height
  const radius = Math.max(1, Math.round(1 + strength * 0.5))
  const eps = (strength / 10) ** 2 * 0.012 * (1 - 0.9 * (preserveDetails / 100)) + 1e-6

  const smoothed = (guide: Float32Array, input: Float32Array, r: number, e: number): Float32Array => {
    const { a, b } = guidedCoefficients(guide, input, width, height, r, e)

    return Float32Array.from(guide, (value, i) => a[i] * value + b[i])
  }

  if (colour.length === 1) {
    return fromStraight([strength > 0 ? smoothed(colour[0], colour[0], radius, eps).map(clamp01) : colour[0]], pixels)
  }

  // Brightness and colour difference (full-range YCbCr).
  const y = new Float32Array(count)
  const cb = new Float32Array(count)
  const cr = new Float32Array(count)

  for (let i = 0; i < count; i++) {
    const [r, g, b] = [colour[0][i], colour[1][i], colour[2][i]]
    y[i] = 0.299 * r + 0.587 * g + 0.114 * b
    cb[i] = -0.168736 * r - 0.331264 * g + 0.5 * b
    cr[i] = 0.5 * r - 0.418688 * g - 0.081312 * b
  }

  const y2 = strength > 0 ? smoothed(y, y, radius, eps) : y
  const chroma = colorNoise / 100
  const chromaEps = chroma * chroma * 0.02 + 1e-6
  const chromaRadius = Math.max(1, Math.round(radius * 2 + chroma * 6))
  const cb2 = chroma > 0 ? smoothed(y2, cb, chromaRadius, chromaEps) : cb
  const cr2 = chroma > 0 ? smoothed(y2, cr, chromaRadius, chromaEps) : cr
  const out = [new Float32Array(count), new Float32Array(count), new Float32Array(count)]

  for (let i = 0; i < count; i++) {
    out[0][i] = clamp01(y2[i] + 1.402 * cr2[i])
    out[1][i] = clamp01(y2[i] - 0.344136 * cb2[i] - 0.714136 * cr2[i])
    out[2][i] = clamp01(y2[i] + 1.772 * cb2[i])
  }

  return fromStraight(out, pixels)
}

function noise(pixels: Pixels, settings: FilterSettings['addNoise'], origin: Vec2): Uint8ClampedArray {
  const { width, height } = pixels
  const colour = straightPlanes(pixels)
  const out = colour.map((plane) => plane.slice())

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const [r, g, b] = addNoise(colour.length === 1 ? [colour[0][i], colour[0][i], colour[0][i]] : [colour[0][i], colour[1][i], colour[2][i]], x + origin[0], y + origin[1], settings)
      out[0][i] = r

      if (colour.length === 3) {
        out[1][i] = g
        out[2][i] = b
      }
    }
  }

  return fromStraight(out, pixels)
}

/** One channel's median over a (2r+1)² window, with a running histogram (Huang's method): a few steps a pixel whatever the radius. */
export function medianChannel(source: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const out = new Uint8Array(source.length)
  const histogram = new Int32Array(256)
  const half = ((radius * 2 + 1) ** 2 + 1) >> 1
  const column = (x: number) => Math.min(width - 1, Math.max(0, x))
  const rowAt = (y: number) => Math.min(height - 1, Math.max(0, y)) * width

  for (let y = 0; y < height; y++) {
    histogram.fill(0)

    for (let dy = -radius; dy <= radius; dy++) {
      const row = rowAt(y + dy)

      for (let dx = -radius; dx <= radius; dx++) {
        histogram[source[row + column(dx)]]++
      }
    }

    // `median` is the value with `below` samples under it, the half-th smallest of the window.
    let median = 0
    let below = 0

    while (below + histogram[median] < half) {
      below += histogram[median]
      median++
    }

    out[y * width] = median

    for (let x = 1; x < width; x++) {
      const leaving = column(x - radius - 1)
      const entering = column(x + radius)

      for (let dy = -radius; dy <= radius; dy++) {
        const row = rowAt(y + dy)
        const gone = source[row + leaving]
        const come = source[row + entering]
        histogram[gone]--
        histogram[come]++
        below += (come < median ? 1 : 0) - (gone < median ? 1 : 0)
      }

      while (below >= half) {
        median--
        below -= histogram[median]
      }

      while (below + histogram[median] < half) {
        below += histogram[median]
        median++
      }

      out[y * width + x] = median
    }
  }

  return out
}

/** Median: each channel (premultiplied) replaced by the middle value around it, taking out specks and scratches. */
function median(pixels: Pixels, radius: number): Uint8ClampedArray {
  const planes = toPlanes(pixels).map((plane) => Uint8Array.from(plane, (value) => Math.round(value * 255)))
  // An opaque picture's alpha stays opaque: only its colour needs the work.
  const opaque = planes.length === 4 && planes[3].every((value) => value === 255)
  const filtered = planes.map((plane, c) => (opaque && c === 3 ? plane : medianChannel(plane, pixels.width, pixels.height, radius)))

  return fromPlanes(
    filtered.map((plane) => Float32Array.from(plane, (value) => value / 255)),
    pixels.channels
  )
}

/** A filter on pixels; `origin` is where they sit in the layer, so Add Noise's pattern holds still between pieces. */
export function applyFilter(pixels: Pixels, spec: FilterSpec, origin: Vec2 = [0, 0]): Uint8ClampedArray {
  switch (spec.kind) {
    case 'gaussianBlur':
      return gaussianBlur(pixels, spec.radius)
    case 'motionBlur':
      return motionBlur(pixels, spec.angle, spec.distance)
    case 'highPass':
      return highPass(pixels, spec.radius)
    case 'unsharpMask':
      return unsharpMask(pixels, spec.amount, spec.radius, spec.threshold)
    case 'smartSharpen':
      return smartSharpen(pixels, spec.amount, spec.radius, spec.reduceNoise)
    case 'reduceNoise':
      return reduceNoise(pixels, spec.strength, spec.preserveDetails, spec.colorNoise)
    case 'addNoise':
      return noise(pixels, spec, origin)
    case 'median':
      return median(pixels, spec.radius)
  }
}

/** A filter's settings at a smaller scale (for a preview of a reduced copy): sizes shrink, amounts stay. */
export function scaledFilter(spec: FilterSpec, scale: number): FilterSpec {
  switch (spec.kind) {
    case 'gaussianBlur':
    case 'highPass':
      return { ...spec, radius: Math.max(0.1, spec.radius * scale) }
    case 'unsharpMask':
    case 'smartSharpen':
      return { ...spec, radius: Math.max(0.1, spec.radius * scale) }
    case 'motionBlur':
      return { ...spec, distance: Math.max(1, spec.distance * scale) }
    case 'median':
      return { ...spec, radius: Math.max(1, Math.round(spec.radius * scale)) }
    default:
      return spec
  }
}
