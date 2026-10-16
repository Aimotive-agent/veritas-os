/*
 * The colour maths of Veritas Canvas's adjustment layers, written once in plain TypeScript. The GPU
 * shaders (gpu/adjust-shaders.ts) transliterate it line by line and the tests check it here, so
 * the two stay in step. Colours are straight (not premultiplied) RGB from 0 to 1; noise and grain
 * are placed by document position, so their pattern holds still between renders and scales.
 */

import type {
  Adjustment,
  BlackWhiteSettings,
  ColorBalanceSettings,
  CurvePoint,
  CurvesSettings,
  ExposureSettings,
  GradientMapSettings,
  GrainSettings,
  LevelRange,
  LevelsSettings
} from '../../../../shared/canvas/comp-format.ts'

export type RGB3 = [number, number, number]

export const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

const mix = (a: number, b: number, t: number): number => a + (b - a) * t

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp01((x - edge0) / (edge1 - edge0))

  return t * t * (3 - 2 * t)
}

/** Degrees into 0 up to 360. */
const wrapDegrees = (degrees: number): number => ((degrees % 360) + 360) % 360

// Colour spaces.

export const srgbToLinear = (v: number): number => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))

export const linearToSrgb = (v: number): number => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)

/** Hue in degrees (0 up to 360), saturation and lightness 0 to 1. */
export function rgbToHsl([r, g, b]: RGB3): RGB3 {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2

  if (max === min) {
    return [0, 0, l]
  }

  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number

  if (max === r) {
    h = (g - b) / d + (g < b ? 6 : 0)
  } else if (max === g) {
    h = (b - r) / d + 2
  } else {
    h = (r - g) / d + 4
  }

  return [h * 60, s, l]
}

function hueChannel(p: number, q: number, t: number): number {
  const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t

  if (u < 1 / 6) {
    return p + (q - p) * 6 * u
  }

  if (u < 1 / 2) {
    return q
  }

  if (u < 2 / 3) {
    return p + (q - p) * (2 / 3 - u) * 6
  }

  return p
}

export function hslToRgb(h: number, s: number, l: number): RGB3 {
  if (s <= 0) {
    return [l, l, l]
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const t = wrapDegrees(h) / 360

  return [hueChannel(p, q, t + 1 / 3), hueChannel(p, q, t), hueChannel(p, q, t - 1 / 3)]
}

/** Rec. 709 luma of gamma-encoded colour: what Gradient Map, Grain and Color Balance read as brightness. */
export const luma = ([r, g, b]: RGB3): number => 0.2126 * r + 0.7152 * g + 0.0722 * b

// The W3C blend modes' luminosity, so Preserve Luminosity agrees with the Luminosity mode.
export const lum = ([r, g, b]: RGB3): number => 0.3 * r + 0.59 * g + 0.11 * b

export function setLum(c: RGB3, l: number): RGB3 {
  const d = l - lum(c)
  let out: RGB3 = [c[0] + d, c[1] + d, c[2] + d]
  const ll = lum(out)
  const n = Math.min(...out)
  const x = Math.max(...out)

  if (n < 0) {
    out = out.map((v) => ll + ((v - ll) * ll) / Math.max(ll - n, 1e-6)) as RGB3
  }

  if (x > 1) {
    out = out.map((v) => ll + ((v - ll) * (1 - ll)) / Math.max(x - ll, 1e-6)) as RGB3
  }

  return out
}

// Per-pixel adjustments.

export interface HueSaturation {
  hue: number
  saturation: number
  lightness: number
  colorize: boolean
}

/**
 * Hue/Saturation: the hue turns by `hue` degrees; saturation below 0 fades towards gray (−100 is
 * gray) and above 0 divides by what is left, so +100 saturates fully; lightness pulls towards
 * white above 0 and black below. Colorize paints every pixel in one hue at `saturation` percent.
 */
export function hueSaturation(c: RGB3, settings: HueSaturation): RGB3 {
  let [h, s, l] = rgbToHsl(c)

  if (settings.colorize) {
    h = wrapDegrees(settings.hue)
    s = clamp01(settings.saturation / 100)
  } else {
    h = wrapDegrees(h + settings.hue)
    const amount = Math.max(-1, Math.min(1, settings.saturation / 100))
    s = amount <= 0 ? s * (1 + amount) : amount >= 1 ? (s > 0 ? 1 : 0) : Math.min(1, s / (1 - amount))
  }

  const k = Math.max(-1, Math.min(1, settings.lightness / 100))
  l = k >= 0 ? l + (1 - l) * k : l * (1 + k)

  return hslToRgb(h, s, clamp01(l))
}

/** One Levels range on a value: input black and white stretched to the ends, bent by gamma, then fitted to the output range. */
export function levelRange(v: number, range: LevelRange): number {
  const black = range.black / 255
  const white = range.white / 255
  const t = white > black ? clamp01((v - black) / (white - black)) : v >= white ? 1 : 0

  return clamp01((range.outputBlack + Math.pow(t, 1 / range.gamma) * (range.outputWhite - range.outputBlack)) / 255)
}

/** Levels as lookup tables: 256 entries a row, rows RGB, red, green, blue (the record's order). */
export function levelsTables(levels: LevelsSettings): Float32Array {
  const out = new Float32Array(256 * 4)

  for (let row = 0; row < 4; row++) {
    for (let i = 0; i < 256; i++) {
      out[row * 256 + i] = levelRange(i / 255, levels.ranges[row])
    }
  }

  return out
}

/**
 * A curve through its points, 0 to 1 at each of 256 inputs: a monotone cubic (Fritsch and Carlson),
 * so it is smooth but never overshoots between two points, and flat before the first point and after
 * the last.
 */
export function curveTable(points: readonly CurvePoint[]): Float32Array {
  const out = new Float32Array(256)
  const n = points.length
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)

  if (n < 2) {
    out.forEach((_, i) => (out[i] = n ? clamp01(ys[0] / 255) : i / 255))

    return out
  }

  const secants = xs.slice(1).map((x, i) => (ys[i + 1] - ys[i]) / (x - xs[i]))
  const tangents = xs.map((_, i) => (i === 0 ? secants[0] : i === n - 1 ? secants[n - 2] : secants[i - 1] * secants[i] <= 0 ? 0 : (secants[i - 1] + secants[i]) / 2))

  for (let i = 0; i < n - 1; i++) {
    if (secants[i] === 0) {
      tangents[i] = 0
      tangents[i + 1] = 0
      continue
    }

    const a = tangents[i] / secants[i]
    const b = tangents[i + 1] / secants[i]
    const h = a * a + b * b

    // Past this circle the cubic would swing beyond its two points.
    if (h > 9) {
      const t = 3 / Math.sqrt(h)
      tangents[i] = t * a * secants[i]
      tangents[i + 1] = t * b * secants[i]
    }
  }

  let k = 0

  for (let i = 0; i < 256; i++) {
    let y: number

    if (i <= xs[0]) {
      y = ys[0]
    } else if (i >= xs[n - 1]) {
      y = ys[n - 1]
    } else {
      while (k < n - 2 && i >= xs[k + 1]) {
        k++
      }

      const h = xs[k + 1] - xs[k]
      const t = (i - xs[k]) / h
      const t2 = t * t
      const t3 = t2 * t
      y = (2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h * tangents[k] + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h * tangents[k + 1]
    }

    out[i] = clamp01(y / 255)
  }

  return out
}

/** Curves as lookup tables, laid out as `levelsTables` lays them. */
export function curvesTables(curves: CurvesSettings): Float32Array {
  const out = new Float32Array(256 * 4)
  curves.channels.forEach((points, row) => out.set(curveTable(points), row * 256))

  return out
}

/** A table row at a value, between its entries. */
function lookup(tables: Float32Array, row: number, v: number): number {
  const x = clamp01(v) * 255
  const lo = Math.min(254, Math.floor(x))

  return mix(tables[row * 256 + lo], tables[row * 256 + lo + 1], x - lo)
}

/** Levels or Curves tables on a colour: each channel's own row first, then the RGB row on the result. */
export const applyTables = (c: RGB3, tables: Float32Array): RGB3 => c.map((v, i) => lookup(tables, 0, lookup(tables, i + 1, v))) as RGB3

/** Exposure in linear light: `exposure` stops scale it, `offset` shifts it, then gamma bends it. */
export function exposure(c: RGB3, settings: ExposureSettings): RGB3 {
  const scale = Math.pow(2, settings.exposure)

  return c.map((v) => clamp01(linearToSrgb(Math.pow(Math.max(0, srgbToLinear(v) * scale + settings.offset), 1 / settings.gamma)))) as RGB3
}

/** Gradient Map: brightness picks a colour from the shadows colour to the highlights colour (the other way round when reversed). */
export function gradientMap(c: RGB3, settings: GradientMapSettings): RGB3 {
  const t = clamp01(luma(c))
  const dark = settings.reversed ? settings.highlights : settings.shadows
  const light = settings.reversed ? settings.shadows : settings.highlights

  return [mix(dark.red, light.red, t), mix(dark.green, light.green, t), mix(dark.blue, light.blue, t)]
}

export const invert = (c: RGB3): RGB3 => [1 - c[0], 1 - c[1], 1 - c[2]]

/**
 * Black & White: a colour is its smallest channel of gray, plus the part its two brightest channels
 * share (a secondary: yellow, cyan or magenta) and the part only its brightest has (a primary: red,
 * green or blue). Each part turns as light as its colour's percentage says.
 */
export function blackWhite(c: RGB3, settings: BlackWhiteSettings): RGB3 {
  const [r, g, b] = c
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const mid = r + g + b - max - min
  let primary: number
  let secondary: number

  if (r >= g && r >= b) {
    primary = settings.reds
    secondary = g >= b ? settings.yellows : settings.magentas
  } else if (g >= b) {
    primary = settings.greens
    secondary = r >= b ? settings.yellows : settings.cyans
  } else {
    primary = settings.blues
    secondary = g >= r ? settings.cyans : settings.magentas
  }

  const gray = clamp01(min + ((mid - min) * secondary) / 100 + ((max - mid) * primary) / 100)

  return settings.tint ? hslToRgb(settings.tintHue, clamp01(settings.tintSaturation / 100), gray) : [gray, gray, gray]
}

/** How much a brightness belongs to the shadows, the midtones and the highlights: overlapping, so a shift fades in and out. */
export function tonalWeights(l: number): RGB3 {
  return [1 - smoothstep(0, 0.6, l), smoothstep(0, 0.5, l) * (1 - smoothstep(0.5, 1, l)), smoothstep(0.4, 1, l)]
}

/** The furthest a Color Balance slider at ±100 moves a channel, where its tone has full weight. */
export const BALANCE_REACH = 0.5

/**
 * Color Balance: each pair moves a channel (cyan–red the red one, magenta–green the green one,
 * yellow–blue the blue one), separately for shadows, midtones and highlights by the pixel's
 * brightness. Preserve Luminosity puts the brightness back afterwards.
 */
export function colorBalance(c: RGB3, settings: ColorBalanceSettings): RGB3 {
  const [s, m, h] = tonalWeights(luma(c))
  const shift = (shadow: number, mid: number, highlight: number) => ((shadow * s + mid * m + highlight * h) / 100) * BALANCE_REACH
  const out: RGB3 = [
    clamp01(c[0] + shift(settings.shadowCyanRed, settings.midCyanRed, settings.highlightCyanRed)),
    clamp01(c[1] + shift(settings.shadowMagentaGreen, settings.midMagentaGreen, settings.highlightMagentaGreen)),
    clamp01(c[2] + shift(settings.shadowYellowBlue, settings.midYellowBlue, settings.highlightYellowBlue))
  ]

  return settings.preserveLuminosity ? (setLum(out, lum(c)).map(clamp01) as RGB3) : out
}

// Noise and grain.

/** A well-spread 32-bit hash (Jarzynski and Olano's PCG hash for GPUs). */
export function pcg(value: number): number {
  const state = (Math.imul(value >>> 0, 747796405) + 2891336453) >>> 0
  const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0

  return ((word >>> 22) ^ word) >>> 0
}

/** A hash as a number from 0 up to 1, exact in 32-bit floats too. */
export const unit = (hash: number): number => (hash >>> 8) / 16777216

/** A document pixel's hash for a seed. */
export const pixelHash = (x: number, y: number, seed: number): number => pcg(((x >>> 0) + pcg(((y >>> 0) + pcg(seed >>> 0)) >>> 0)) >>> 0)

export interface NoiseSettings {
  amount: number
  gaussian: boolean
  monochromatic: boolean
  seed: number
}

/** Add Noise at 100% moves a channel by up to this much (uniform), or by this over √3 typically (gaussian). */
export const NOISE_REACH = 0.5

/** The noise added at a document pixel: the same for all three channels when monochromatic. */
export function noiseAt(x: number, y: number, settings: NoiseSettings): RGB3 {
  const base = pixelHash(x, y, settings.seed)
  const amplitude = (settings.amount / 100) * NOISE_REACH
  const channel = (i: number): number => {
    const key = settings.monochromatic ? base : pcg((base + i + 1) >>> 0)
    const u = unit(key)

    if (!settings.gaussian) {
      return (u * 2 - 1) * amplitude
    }

    // Box and Muller: two uniform numbers make one with a normal spread, here of the uniform's variance.
    return Math.sqrt(-2 * Math.log(1 - u)) * Math.cos(6.283185307179586 * unit(pcg(key))) * (amplitude / Math.sqrt(3))
  }

  return [channel(0), channel(1), channel(2)]
}

export function addNoise(c: RGB3, x: number, y: number, settings: NoiseSettings): RGB3 {
  const n = noiseAt(x, y, settings)

  return [clamp01(c[0] + n[0]), clamp01(c[1] + n[1]), clamp01(c[2] + n[2])]
}

/** A value from −1 up to 1 for a lattice point of a seed. */
const lattice = (ix: number, iy: number, seed: number): number => unit(pixelHash(ix, iy, seed)) * 2 - 1

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10)

/** Smooth noise with features `cell` document pixels across. */
export function valueNoise(px: number, py: number, cell: number, seed: number): number {
  const u = px / cell
  const v = py / cell
  const ix = Math.floor(u)
  const iy = Math.floor(v)
  const tx = fade(u - ix)
  const ty = fade(v - iy)
  const top = mix(lattice(ix, iy, seed), lattice(ix + 1, iy, seed), tx)
  const bottom = mix(lattice(ix, iy + 1, seed), lattice(ix + 1, iy + 1, seed), tx)

  return mix(top, bottom, ty)
}

/** How strong Grain at 100 is, before the midtones' weighting. */
export const GRAIN_REACH = 0.3

/** The second, finer pattern Grain roughens with: its own seed, and features this share of the grain size. */
export const GRAIN_DETAIL = 0.35

const fineSeed = (seed: number): number => pcg((seed ^ 0x5bd1e995) >>> 0)

/**
 * Grain at a document position: smooth noise at the grain size, roughened towards a finer pattern,
 * strongest in the midtones as film grain is. One value for all three channels.
 */
export function grainAt(px: number, py: number, l: number, settings: GrainSettings): number {
  const size = Math.max(0.1, settings.size)
  const coarse = valueNoise(px, py, size, settings.seed)
  const fine = valueNoise(px, py, Math.max(0.5, size * GRAIN_DETAIL), fineSeed(settings.seed))
  // Interpolating between lattice values narrows their spread; this brings it back to about −1 to 1.
  const n = mix(coarse, fine, clamp01(settings.roughness / 100)) * 1.7
  const weight = 0.3 + 2.8 * l * (1 - l)

  return n * (settings.amount / 100) * GRAIN_REACH * weight
}

export function grain(c: RGB3, px: number, py: number, settings: GrainSettings): RGB3 {
  const delta = grainAt(px, py, clamp01(luma(c)), settings)

  return [clamp01(c[0] + delta), clamp01(c[1] + delta), clamp01(c[2] + delta)]
}

// One pixel through an adjustment.

/** The kinds that read only the pixel itself; the others look at its neighbours. */
export const isPerPixel = (kind: Adjustment['kind']): boolean => kind !== 'Gaussian Blur' && kind !== 'Motion Blur'

/** The settings the GPU uses for an adjustment, with the defaults the record leaves out. */
export function resolved(adjustment: Adjustment) {
  return {
    exposure: adjustment.exposureSettings ?? { exposure: 0, offset: 0, gamma: 1 },
    gradientMap: adjustment.gradientMapSettings ?? { shadows: { red: 0, green: 0, blue: 0 }, highlights: { red: 1, green: 1, blue: 1 }, reversed: false },
    grain: adjustment.grainSettings ?? { amount: 25, size: 1.5, roughness: 50, seed: 0 },
    blackWhite: adjustment.blackWhiteSettings ?? { reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: false, tintHue: 40, tintSaturation: 20 },
    colorBalance: adjustment.colorBalanceSettings ?? {
      shadowCyanRed: 0,
      shadowMagentaGreen: 0,
      shadowYellowBlue: 0,
      midCyanRed: 0,
      midMagentaGreen: 0,
      midYellowBlue: 0,
      highlightCyanRed: 0,
      highlightMagentaGreen: 0,
      highlightYellowBlue: 0,
      preserveLuminosity: true
    },
    blurRadius: adjustment.blurRadius ?? 10,
    motionAngle: adjustment.motionAngle ?? 0,
    motionDistance: adjustment.motionDistance ?? 10,
    noise: { amount: adjustment.noiseAmount ?? 10, gaussian: adjustment.noiseGaussian ?? false, monochromatic: adjustment.noiseMonochromatic ?? false, seed: adjustment.noiseSeed ?? 0 }
  }
}

/**
 * A pixel's colour through a per-pixel adjustment, at document pixel (x, y) (noise is per pixel;
 * grain reads the pixel's centre). Blurs need the neighbours, so they leave the colour as it is.
 */
export function adjustPixel(c: RGB3, adjustment: Adjustment, x = 0, y = 0): RGB3 {
  const settings = resolved(adjustment)

  switch (adjustment.kind) {
    case 'Hue/Saturation':
      return hueSaturation(c, adjustment)
    case 'Levels':
      return applyTables(c, levelsTables(adjustment.levels))
    case 'Curves':
      return applyTables(c, curvesTables(adjustment.curves))
    case 'Exposure':
      return exposure(c, settings.exposure)
    case 'Gradient Map':
      return gradientMap(c, settings.gradientMap)
    case 'Grain':
      return grain(c, x + 0.5, y + 0.5, settings.grain)
    case 'Invert':
      return invert(c)
    case 'Black & White':
      return blackWhite(c, settings.blackWhite)
    case 'Color Balance':
      return colorBalance(c, settings.colorBalance)
    case 'Add Noise':
      return addNoise(c, x, y, settings.noise)
    default:
      return c
  }
}

// Blurs.

/** Pairs of neighbouring taps merged into one linear-filtered sample: offsets from the centre and weights (the centre is offset 0). */
export interface Taps {
  offsets: number[]
  weights: number[]
}

/** A normalised gaussian of `sigma` pixels, as taps that each read two texels through linear filtering. */
export function gaussianTaps(sigma: number): Taps {
  if (sigma < 0.05) {
    return { offsets: [0], weights: [1] }
  }

  const radius = Math.max(1, Math.ceil(sigma * 3))
  const raw = Array.from({ length: radius + 1 }, (_, i) => Math.exp(-(i * i) / (2 * sigma * sigma)))
  const total = raw[0] + 2 * raw.slice(1).reduce((sum, w) => sum + w, 0)
  const w = raw.map((value) => value / total)
  const offsets = [0]
  const weights = [w[0]]

  for (let i = 1; i <= radius; i += 2) {
    const a = w[i]
    const b = i + 1 <= radius ? w[i + 1] : 0
    offsets.push((i * a + (i + 1) * b) / (a + b))
    weights.push(a + b)
  }

  return { offsets, weights }
}

/** The most taps a blur pass reads on each side of the centre. */
export const MAX_TAPS = 16

/**
 * How to blur by `sigma` target pixels cheaply: halve the image `factor` times over (a box of
 * `factor` pixels), blur by the reduced `sigma` there, and stretch back with linear filtering (a
 * tent `factor` wide). Their variances add up to the gaussian asked for.
 */
export function blurPlan(sigma: number): { factor: number; sigma: number } {
  let factor = 1

  while (factor * 2 <= sigma / 2 && factor < 1 << 12) {
    factor *= 2
  }

  if (factor === 1) {
    return { factor, sigma }
  }

  const left = sigma * sigma - (factor * factor - 1) / 12 - (factor * factor) / 6

  return { factor, sigma: Math.sqrt(Math.max(0.25, left)) / factor }
}

/** The most samples a motion-blur pass takes. */
export const MOTION_TAPS = 128

/** Samples a streak takes per pixel of its length, so a slanted one reads as smooth as a straight one. */
const MOTION_DENSITY = 2

/**
 * An even streak `length` pixels long, as passes of `taps` samples `spacing` apart, finest first:
 * each pass spreads the last one's result `taps` times wider, so a long streak takes two passes
 * rather than thousands of samples. One pass where it can, as every pass adds linear filtering.
 */
export function motionPasses(length: number): { taps: number; spacing: number }[] {
  if (length <= 1) {
    return []
  }

  const samples = length * MOTION_DENSITY
  let passes = 1

  while (MOTION_TAPS ** passes < samples) {
    passes++
  }

  const taps = Math.max(2, Math.ceil(samples ** (1 / passes) - 1e-9))
  const finest = length / taps ** passes

  return Array.from({ length: passes }, (_, i) => ({ taps, spacing: finest * taps ** i }))
}

/** A motion blur's direction in document pixels (y down): the angle turns counterclockwise from horizontal, as on screen. */
export const motionDirection = (degrees: number): [number, number] => [Math.cos((degrees * Math.PI) / 180), -Math.sin((degrees * Math.PI) / 180)]
