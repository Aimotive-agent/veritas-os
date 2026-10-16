/*
 * The adjustments only Veritas Canvas makes (comp-format's HERALD_ADJUSTMENT_KINDS): their colour
 * maths in plain TypeScript, as adjust-math.ts has it for Compositor's kinds, transliterated into
 * gpu/adjust-shaders.ts. Each has a stand-in, the Compositor kind its layer's `adjustment` holds
 * for apps that read only those: the very same change where Compositor has one (Brightness/Contrast
 * is a tone curve, Vibrance with no vibrance is Hue/Saturation, a Photo Filter without Preserve
 * Luminosity scales each channel as Levels can), and no change otherwise.
 */

import {
  type Adjustment,
  type BrightnessContrastSettings,
  type ChannelMixerSettings,
  type CurvePoint,
  defaultAdjustment,
  defaultHeraldAdjustment,
  type HeraldAdjustment,
  type HeraldAdjustmentKind,
  identityRange,
  isHeraldKind,
  type MixerRow,
  type PhotoFilterSettings,
  type PosterizeSettings,
  SELECTIVE_RANGES,
  type SelectiveColorSettings,
  type SelectiveRange,
  type ThresholdSettings,
  type VibranceSettings
} from '../../../../shared/canvas/comp-format.ts'
import { applyTables, clamp01, curvesTables, hueSaturation, lum, luma, type RGB3, rgbToHsl, setLum } from './adjust-math.ts'
import { type ColorTable, lookUp } from './color-table.ts'
import { adjustmentLayer, type CanvasLayer } from './document.ts'

/** A layer's Veritas-only adjustment when this version knows its kind; null otherwise (its stand-in then shows). */
export const heraldOf = (layer: Pick<CanvasLayer, 'heraldAdjustment'> | undefined): HeraldAdjustment | null => (layer?.heraldAdjustment && isHeraldKind(layer.heraldAdjustment.kind) ? layer.heraldAdjustment : null)

/** The size of a Color Lookup layer's table (0 for no table, and for every other layer). */
export function tableSizeOf(layer: Pick<CanvasLayer, 'heraldAdjustment'>): number {
  const settings = heraldOf(layer)

  return settings?.kind === 'Color Lookup' ? settings.size : 0
}

/** Points in Brightness/Contrast's curve: the most a curve takes, so any smooth reading of it draws the same line. */
const CURVE_POINTS = 32

/**
 * Brightness/Contrast as a tone curve. Brightness bends the midtones up or down while black and white
 * stay put (at ±150 the middle gray moves a quarter of the way); contrast then steepens the curve
 * around the middle gray into an S (up to three times as steep at 100) or flattens it towards gray
 * (half as steep at −50, black and white meeting it a quarter of the way).
 */
export function brightnessContrastCurve(brightness: number, contrast: number): CurvePoint[] {
  const bend = brightness / 150
  const steep = (contrast / 100) * 12
  const sigmoid = (z: number) => 1 / (1 + Math.exp(-z))
  const shaped = (u: number): number => {
    const lifted = u + bend * u * (1 - u)

    if (contrast > 0) {
      return (sigmoid(steep * (lifted - 0.5)) - sigmoid(-steep / 2)) / (sigmoid(steep / 2) - sigmoid(-steep / 2))
    }

    return 0.5 + (lifted - 0.5) * (1 + contrast / 100)
  }

  return Array.from({ length: CURVE_POINTS }, (_, i) => {
    const x = i === CURVE_POINTS - 1 ? 255 : Math.round((i * 255) / (CURVE_POINTS - 1))

    return { x, y: clamp01(shaped(x / 255)) * 255 }
  })
}

/** Brightness/Contrast's curve as the Curves record its stand-in is. */
const brightnessContrastCurves = (settings: BrightnessContrastSettings): Adjustment['curves'] => {
  const curves = defaultAdjustment('Curves').curves

  return { ...curves, channels: [brightnessContrastCurve(settings.brightness, settings.contrast), ...curves.channels.slice(1)] as Adjustment['curves']['channels'] }
}

/** How much Vibrance spares a hue: skin tones (orange, around 25°) most of all. */
export function skinGuard(hue: number): number {
  const distance = Math.abs(((hue - 25 + 540) % 360) - 180)

  return 1 - 0.6 * Math.max(0, 1 - distance / 35)
}

/**
 * Vibrance: dull colours move furthest from (or towards) gray and vivid ones hardly at all, and
 * raised, skin tones are spared; then Saturation, exactly as Hue/Saturation saturates.
 */
export function vibrance(c: RGB3, settings: Pick<VibranceSettings, 'vibrance' | 'saturation'>): RGB3 {
  let out = c

  if (settings.vibrance !== 0) {
    const chroma = Math.max(...c) - Math.min(...c)
    const amount = settings.vibrance / 100
    const k = amount > 0 ? 1 + amount * (1 - chroma) ** 2 * 1.5 * skinGuard(rgbToHsl(c)[0]) : 1 + amount * (1 - chroma * 0.5)
    const gray = luma(c)
    out = [clamp01(gray + (c[0] - gray) * k), clamp01(gray + (c[1] - gray) * k), clamp01(gray + (c[2] - gray) * k)]
  }

  return settings.saturation !== 0 ? hueSaturation(out, { hue: 0, saturation: settings.saturation, lightness: 0, colorize: false }) : out
}

/** What a Photo Filter multiplies each channel by: white, tinted towards the filter colour by the density. */
export function filterScale(settings: Pick<PhotoFilterSettings, 'color' | 'density'>): RGB3 {
  const d = settings.density / 100

  return [1 - d + d * settings.color.red, 1 - d + d * settings.color.green, 1 - d + d * settings.color.blue]
}

/** Photo Filter: the colour seen through a tinted filter, with its brightness put back when luminosity is preserved. */
export function photoFilter(c: RGB3, settings: Pick<PhotoFilterSettings, 'color' | 'density' | 'preserveLuminosity'>): RGB3 {
  const [r, g, b] = filterScale(settings)
  const filtered: RGB3 = [c[0] * r, c[1] * g, c[2] * b]

  return settings.preserveLuminosity ? (setLum(filtered, lum(c)).map(clamp01) as RGB3) : filtered
}

const mixed = (c: RGB3, row: MixerRow): number => clamp01((row.red * c[0] + row.green * c[1] + row.blue * c[2] + row.constant) / 100)

/** Channel Mixer: each output channel a mix of the three inputs plus a constant, in percent; monochrome makes one gray from the gray row. */
export function channelMixer(c: RGB3, settings: ChannelMixerSettings): RGB3 {
  if (settings.monochrome) {
    const gray = mixed(c, settings.gray)

    return [gray, gray, gray]
  }

  return [mixed(c, settings.red), mixed(c, settings.green), mixed(c, settings.blue)]
}

/**
 * How much of a colour belongs to each of Selective Color's ranges, 0 to 1: the colour ranges as
 * Black & White splits a colour (its primary part and its secondary part), whites by how light its
 * darkest channel is, blacks by how dark its lightest one is, and neutrals by how near both are to
 * the middle gray.
 */
export function selectiveWeights(c: RGB3): Record<SelectiveRange, number> {
  const [r, g, b] = c
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const mid = r + g + b - max - min
  const weights = Object.fromEntries(SELECTIVE_RANGES.map((range) => [range, 0])) as Record<SelectiveRange, number>

  if (r >= g && r >= b) {
    weights.reds = max - mid
    weights[g >= b ? 'yellows' : 'magentas'] = mid - min
  } else if (g >= b) {
    weights.greens = max - mid
    weights[r >= b ? 'yellows' : 'cyans'] = mid - min
  } else {
    weights.blues = max - mid
    weights[g >= r ? 'cyans' : 'magentas'] = mid - min
  }

  weights.whites = clamp01((min - 0.5) * 2)
  weights.blacks = clamp01((0.5 - max) * 2)
  weights.neutrals = clamp01(1 - Math.abs(max - 0.5) - Math.abs(min - 0.5))

  return weights
}

/**
 * Selective Color: each range adds or takes away cyan, magenta, yellow and black where it applies
 * (cyan is the absence of red, magenta of green, yellow of blue, black of all three). Relative, a
 * change is that share of the ink there is (a colour with no cyan gains none); absolute, it is the
 * amount itself.
 */
export function selectiveColor(c: RGB3, settings: SelectiveColorSettings): RGB3 {
  const weights = selectiveWeights(c)
  const black = 1 - Math.max(...c)
  const change: RGB3 = [0, 0, 0]

  for (const range of SELECTIVE_RANGES) {
    const weight = weights[range]

    if (!weight) {
      continue
    }

    const inks = settings[range]
    const share = (ink: number) => (settings.absolute ? 1 : ink)
    const k = (inks.black / 100) * share(black)
    change[0] += weight * ((inks.cyan / 100) * share(1 - c[0]) + k)
    change[1] += weight * ((inks.magenta / 100) * share(1 - c[1]) + k)
    change[2] += weight * ((inks.yellow / 100) * share(1 - c[2]) + k)
  }

  return [clamp01(c[0] - change[0]), clamp01(c[1] - change[1]), clamp01(c[2] - change[2])]
}

/**
 * Posterize and Threshold read a channel as the 8-bit value it shows, and a value right on a step
 * counts as reaching it: the GPU (in half floats) and this reference then put every pixel on the
 * same side of a step.
 */
const eightBit = (value: number): number => Math.round(clamp01(value) * 255)
const ON_STEP = 1e-4

/** Posterize: each channel in `levels` even bands, from black to white. */
export function posterize(c: RGB3, settings: Pick<PosterizeSettings, 'levels'>): RGB3 {
  const n = settings.levels

  return c.map((value) => Math.min(n - 1, Math.floor((eightBit(value) * n) / 255 + ON_STEP)) / (n - 1)) as RGB3
}

/** Threshold: white where a colour's brightness (Rec. 709, as `luma`) reaches the level (1 to 255), black below it. */
export function threshold(c: RGB3, settings: Pick<ThresholdSettings, 'level'>): RGB3 {
  const value = 0.2126 * eightBit(c[0]) + 0.7152 * eightBit(c[1]) + 0.0722 * eightBit(c[2]) + ON_STEP >= settings.level ? 1 : 0

  return [value, value, value]
}

/**
 * A pixel's colour through a Veritas-only adjustment; a Color Lookup takes the layer's table (none
 * yet changes nothing).
 */
export function adjustVeritas(c: RGB3, settings: HeraldAdjustment, table: ColorTable | null = null): RGB3 {
  switch (settings.kind) {
    case 'Brightness/Contrast':
      return applyTables(c, curvesTables(brightnessContrastCurves(settings)))
    case 'Vibrance':
      return vibrance(c, settings)
    case 'Photo Filter':
      return photoFilter(c, settings)
    case 'Channel Mixer':
      return channelMixer(c, settings)
    case 'Selective Color':
      return selectiveColor(c, settings)
    case 'Posterize':
      return posterize(c, settings)
    case 'Threshold':
      return threshold(c, settings)
    case 'Color Lookup':
      return table && settings.size > 0 ? lookUp(c, table) : c
    default:
      return c
  }
}

/** Does the stand-in make the very same change (so Compositor shows the layer as Veritas does)? */
export function standInIsExact(settings: HeraldAdjustment): boolean {
  switch (settings.kind) {
    case 'Brightness/Contrast':
      return true
    case 'Vibrance':
      return settings.vibrance === 0
    case 'Photo Filter':
      return !settings.preserveLuminosity
    default:
      return false
  }
}

/** The Compositor adjustment a Veritas-only one stands in as: the same change where one exists, otherwise Levels that change nothing. */
export function standInFor(settings: HeraldAdjustment): Adjustment {
  if (standInIsExact(settings)) {
    switch (settings.kind) {
      case 'Brightness/Contrast':
        return { ...defaultAdjustment('Curves'), curves: brightnessContrastCurves(settings) }
      case 'Vibrance':
        return { ...defaultAdjustment('Hue/Saturation'), saturation: settings.saturation }
      case 'Photo Filter': {
        const scale = filterScale(settings)
        const levels = defaultAdjustment('Levels').levels
        const channel = (i: number) => ({ ...identityRange(), outputWhite: scale[i] * 255 })

        return { ...defaultAdjustment('Levels'), levels: { ...levels, ranges: [levels.ranges[0], channel(0), channel(1), channel(2)] } }
      }
    }
  }

  return defaultAdjustment('Levels')
}

/** A layer's adjustment fields for Veritas-only settings: the settings and their stand-in together. */
export const withVeritas = (settings: HeraldAdjustment): Pick<CanvasLayer, 'adjustment' | 'heraldAdjustment'> => ({ heraldAdjustment: settings, adjustment: standInFor(settings) })

/** A new adjustment layer of a Veritas-only kind, named after it, at its defaults. */
export const heraldLayer = (kind: HeraldAdjustmentKind, width: number, height: number): CanvasLayer => ({ ...adjustmentLayer('Levels', width, height), name: kind, ...withVeritas(defaultHeraldAdjustment(kind)) })
