/*
 * Photoshop documents to Veritas Canvas layers and back, through ag-psd's document model. Pixel
 * layers, folders, masks, clipping, blend modes, opacity, text, the adjustments Veritas has and the
 * layer effects it draws carry over. What Veritas cannot hold is approximated or left out, and
 * each such thing goes into the notes the person is shown. Pure: it runs in a worker and in tests.
 */

import type {
  AdjustmentLayer,
  BlendMode as PsdBlendMode,
  ChannelMixerChannel,
  Color,
  CurvesAdjustmentChannel,
  HueSaturationAdjustmentChannel,
  Layer,
  LayerEffectShadow,
  LayerEffectsInfo,
  LayerMaskData,
  LevelsAdjustmentChannel,
  PixelArray,
  Psd,
  TextStyle as PsdTextStyle,
  UnitsValue
} from 'ag-psd'
import {
  type Adjustment,
  type BlendMode,
  type ChannelMixerSettings,
  type CurvePoint,
  defaultAdjustment,
  defaultEffect,
  defaultHeraldAdjustment,
  defaultTransform,
  type GlowEffect,
  HERALD_RANGES,
  type HeraldAdjustment,
  type Inks,
  isHeraldKind,
  type LayerEffects,
  type LayerRecord,
  type LevelRange,
  LIMITS,
  LIMITS_TEXT,
  type MixerRow,
  newId,
  type PhotoFilterSettings,
  RANGES,
  type RangeName,
  type RGB,
  SELECTIVE_RANGES,
  type SelectiveRange,
  type ShadowEffect,
  type TextAlignment,
  type TextColorRun,
  type TextFontRun,
  type TextStyle,
  type Vec2
} from '../../../../shared/canvas/comp-format.ts'
import { parseCube } from '../engine/color-table.ts'

/** Pixels as plain data, so they cross to and from a worker: RGBA, or one channel for masks. */
export interface PixelData {
  width: number
  height: number
  channels: 1 | 4
  data: Uint8ClampedArray
}

export interface PsdLayer {
  record: LayerRecord
  pixels: PixelData | null
  mask: PixelData | null
  /** A Color Lookup layer's `.cube` file. */
  table?: Uint8Array
  /** A text layer's anchor in the document (the first baseline at its alignment edge, or a paragraph box's corner), for laying it out again. */
  textAnchor?: Vec2
}

export interface ImportedPsd {
  width: number
  height: number
  resolution: number
  /** Bottom to top, each folder right before what is in it. */
  layers: PsdLayer[]
  notes: string[]
}

// --- Shared ------------------------------------------------------------------------------------

/** Veritas's blend modes by ag-psd's names; the rest have no counterpart. */
const FROM_PSD_BLEND: Partial<Record<PsdBlendMode, BlendMode>> = {
  normal: 'Normal',
  darken: 'Darken',
  multiply: 'Multiply',
  'color burn': 'Color Burn',
  'linear burn': 'Linear Burn',
  lighten: 'Lighten',
  screen: 'Screen',
  'color dodge': 'Color Dodge',
  'linear dodge': 'Linear Dodge (Add)',
  overlay: 'Overlay',
  'soft light': 'Soft Light',
  'hard light': 'Hard Light',
  'vivid light': 'Vivid Light',
  'linear light': 'Linear Light',
  'pin light': 'Pin Light',
  'hard mix': 'Hard Mix',
  difference: 'Difference',
  exclusion: 'Exclusion',
  subtract: 'Subtract',
  divide: 'Divide',
  hue: 'Hue',
  saturation: 'Saturation',
  color: 'Color',
  luminosity: 'Luminosity'
}

const TO_PSD_BLEND = Object.fromEntries(Object.entries(FROM_PSD_BLEND).map(([psd, herald]) => [herald, psd])) as Record<BlendMode, PsdBlendMode>

/** Photoshop's name for a blend mode, as its menus show it. */
const blendLabel = (mode: string): string => mode.replace(/\b\w/g, (letter) => letter.toUpperCase())

const clamp = (value: number, [low, high]: readonly [number, number]): number => Math.min(high, Math.max(low, value))
const ranged = (value: number | undefined, range: RangeName, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? clamp(value, RANGES[range]) : fallback)

/** Notes gathered while mapping: one line per kind of thing, naming the layers it touched. */
class Notes {
  private readonly lines = new Map<string, string[]>()

  add(what: string, layer?: string): void {
    const names = this.lines.get(what) ?? []

    if (layer && !names.includes(layer) && names.length < 50) {
      names.push(layer)
    }

    this.lines.set(what, names)
  }

  list(): string[] {
    return [...this.lines].map(([what, names]) => {
      const shown = names.slice(0, 3).map((name) => `“${name}”`)
      const more = names.length > 3 ? ` and ${names.length - 3} more` : ''

      return names.length ? `${what} (${shown.join(', ')}${more})` : what
    })
  }
}

/** A colour in any of ag-psd's colour models, as the format's red, green and blue (0 to 1). */
export function rgbOf(color: Color | undefined, fallback: RGB = { red: 0, green: 0, blue: 0 }): RGB {
  if (!color) {
    return fallback
  }

  const { red, green, blue } = rgbOfModel(color)
  const tidy = (value: number) => Math.round(value * 1e6) / 1e6

  return { red: tidy(red), green: tidy(green), blue: tidy(blue) }
}

function rgbOfModel(color: Color): RGB {
  const unit = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))

  if ('r' in color) {
    return { red: unit(color.r / 255), green: unit(color.g / 255), blue: unit(color.b / 255) }
  }

  if ('fr' in color) {
    return { red: unit(color.fr), green: unit(color.fg), blue: unit(color.fb) }
  }

  if ('h' in color) {
    // Hue as a fraction of a turn, saturation and brightness in percent.
    const h = (((color.h % 1) + 1) % 1) * 6
    const s = unit(color.s / 100)
    const v = unit(color.b / 100)
    const f = h - Math.floor(h)
    const [p, q, t] = [v * (1 - s), v * (1 - s * f), v * (1 - s * (1 - f))]
    const [red, green, blue] = [
      [v, t, p],
      [q, v, p],
      [p, v, t],
      [p, q, v],
      [t, p, v],
      [v, p, q]
    ][Math.floor(h) % 6]

    return { red, green, blue }
  }

  if ('c' in color) {
    const k = unit(color.k / 100)

    return { red: (1 - unit(color.c / 100)) * (1 - k), green: (1 - unit(color.m / 100)) * (1 - k), blue: (1 - unit(color.y / 100)) * (1 - k) }
  }

  if ('l' in color) {
    // CIE Lab (D65) to sRGB.
    const fy = (color.l + 16) / 116
    const fx = fy + color.a / 500
    const fz = fy - color.b / 200
    const f = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787)
    const [x, y, z] = [f(fx) * 0.95047, f(fy), f(fz) * 1.08883]
    const gamma = (c: number) => unit(c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

    return { red: gamma(3.2406 * x - 1.5372 * y - 0.4986 * z), green: gamma(-0.9689 * x + 1.8758 * y + 0.0415 * z), blue: gamma(0.0557 * x - 0.204 * y + 1.057 * z) }
  }

  const gray = 1 - unit(color.k / 100)

  return { red: gray, green: gray, blue: gray }
}

const toPsdColor = ({ red, green, blue }: RGB): Color => ({ r: Math.round(red * 255), g: Math.round(green * 255), b: Math.round(blue * 255) })

/** Photoshop keeps opacity in a byte: read back to the whole percent its own controls show. */
const percent = (value: number): number => Math.round(clamp(value, RANGES.opacity) * 100) / 100

/** A length in pixels from ag-psd's units (points count as pixels at 72 per inch, as Photoshop's own documents do). */
const pixelsOf = (value: UnitsValue | undefined, fallback: number): number => (value && Number.isFinite(value.value) ? value.value : fallback)

const px = (value: number): UnitsValue => ({ units: 'Pixels', value })

/** ag-psd's pixels (8, 16 or 32 bits a channel) as 8-bit RGBA, or one channel (the red one) for masks. */
export function eightBit(width: number, height: number, data: PixelArray, channels: 1 | 4): PixelData {
  const out = new Uint8ClampedArray(width * height * channels)
  const scale = data instanceof Uint16Array ? 1 / 257 : data instanceof Float32Array ? 255 : 1
  const count = width * height

  if (channels === 4) {
    if (scale === 1) {
      out.set(data.subarray(0, count * 4))
    } else {
      for (let i = 0; i < count * 4; i++) {
        out[i] = data[i] * scale
      }
    }
  } else {
    for (let i = 0; i < count; i++) {
      out[i] = data[i * 4] * scale
    }
  }

  return { width, height, channels, data: out }
}

// --- Photoshop to Veritas -----------------------------------------------------------------------

/** One of the twelve adjustments from a Photoshop adjustment layer, or null when Veritas has no counterpart. */
export function adjustmentFrom(source: AdjustmentLayer, notes: Notes, name: string): Adjustment | null {
  switch (source.type) {
    case 'hue/saturation': {
      const adjustment = defaultAdjustment('Hue/Saturation')
      const master = source.master
      // Photoshop keeps the colorize switch and its settings ahead of the master settings, which ag-psd reads as the master's first four numbers.
      const colorize = Boolean(master?.a)
      adjustment.colorize = colorize
      adjustment.hue = ranged(colorize ? master?.b : master?.hue, 'hue', 0)
      adjustment.saturation = ranged(colorize ? master?.c : master?.saturation, 'saturation', 0)
      adjustment.lightness = ranged(colorize ? master?.d : master?.lightness, 'lightness', 0)
      const ranges = [source.reds, source.yellows, source.greens, source.cyans, source.blues, source.magentas]

      if (ranges.some((range) => range && (range.hue || range.saturation || range.lightness))) {
        notes.add('Hue/Saturation settings for single colour ranges were left out; the master setting is kept', name)
      }

      return adjustment
    }
    case 'levels': {
      const adjustment = defaultAdjustment('Levels')
      const range = (channel: LevelsAdjustmentChannel | undefined): LevelRange => {
        const black = ranged(channel?.shadowInput, 'levelsBlack', 0)

        return {
          black,
          white: Math.max(black + 1, ranged(channel?.highlightInput, 'levelsWhite', 255)),
          gamma: ranged(channel?.midtoneInput, 'levelsGamma', 1),
          outputBlack: ranged(channel?.shadowOutput, 'levelsOutput', 0),
          outputWhite: ranged(channel?.highlightOutput, 'levelsOutput', 255)
        }
      }
      adjustment.levels = { channel: 'RGB', ranges: [range(source.rgb), range(source.red), range(source.green), range(source.blue)] }

      return adjustment
    }
    case 'curves': {
      const adjustment = defaultAdjustment('Curves')
      adjustment.curves = { channel: 'RGB', channels: [curveFrom(source.rgb), curveFrom(source.red), curveFrom(source.green), curveFrom(source.blue)] }

      return adjustment
    }
    case 'exposure': {
      const adjustment = defaultAdjustment('Exposure')
      adjustment.exposureSettings = { exposure: ranged(source.exposure, 'exposure', 0), offset: ranged(source.offset, 'exposureOffset', 0), gamma: ranged(source.gamma, 'exposureGamma', 1) }

      return adjustment
    }
    case 'invert':
      return defaultAdjustment('Invert')
    case 'black & white': {
      const adjustment = defaultAdjustment('Black & White')
      const weight = (value: number | undefined, fallback: number) => ranged(value, 'blackWhite', fallback)
      const defaults = adjustment.blackWhiteSettings!
      const tint = rgbOf(source.tintColor, { red: 0.88, green: 0.66, blue: 0.4 })
      const [tintHue, tintSaturation] = hueAndSaturation(tint)
      adjustment.blackWhiteSettings = {
        reds: weight(source.reds, defaults.reds),
        yellows: weight(source.yellows, defaults.yellows),
        greens: weight(source.greens, defaults.greens),
        cyans: weight(source.cyans, defaults.cyans),
        blues: weight(source.blues, defaults.blues),
        magentas: weight(source.magentas, defaults.magentas),
        tint: Boolean(source.useTint),
        tintHue: ranged(tintHue, 'tintHue', defaults.tintHue),
        tintSaturation: ranged(tintSaturation, 'tintSaturation', defaults.tintSaturation)
      }

      return adjustment
    }
    case 'color balance': {
      const adjustment = defaultAdjustment('Color Balance')
      const shift = (value: number | undefined) => ranged(value, 'colorBalance', 0)
      adjustment.colorBalanceSettings = {
        shadowCyanRed: shift(source.shadows?.cyanRed),
        shadowMagentaGreen: shift(source.shadows?.magentaGreen),
        shadowYellowBlue: shift(source.shadows?.yellowBlue),
        midCyanRed: shift(source.midtones?.cyanRed),
        midMagentaGreen: shift(source.midtones?.magentaGreen),
        midYellowBlue: shift(source.midtones?.yellowBlue),
        highlightCyanRed: shift(source.highlights?.cyanRed),
        highlightMagentaGreen: shift(source.highlights?.magentaGreen),
        highlightYellowBlue: shift(source.highlights?.yellowBlue),
        preserveLuminosity: source.preserveLuminosity !== false
      }

      return adjustment
    }
    case 'gradient map': {
      const adjustment = defaultAdjustment('Gradient Map')
      const stops = [...(source.colorStops ?? [])].sort((a, b) => a.location - b.location)

      if (source.gradientType !== 'solid' || stops.length > 2) {
        notes.add('Gradient maps with more than two colours became two-colour maps, from the first colour to the last', name)
      }

      adjustment.gradientMapSettings = {
        shadows: rgbOf(stops[0]?.color, { red: 0, green: 0, blue: 0 }),
        highlights: rgbOf(stops.at(-1)?.color, { red: 1, green: 1, blue: 1 }),
        reversed: Boolean(source.reverse)
      }

      return adjustment
    }
    default:
      notes.add(`${blendLabel(source.type)} adjustment layers have no counterpart and were left out`, name)

      return null
  }
}

const heraldRanged = (value: number | undefined, range: keyof typeof HERALD_RANGES, fallback: number, whole = false): number => {
  const number = typeof value === 'number' && Number.isFinite(value) ? clamp(value, HERALD_RANGES[range]) : fallback

  return whole ? Math.round(number) : number
}

/**
 * One of Veritas's own adjustments from a Photoshop adjustment layer (with a Color Lookup's `.cube`
 * file), or null when the layer is none of them. A Color Lookup holding another kind of table, or
 * a colour profile, is left out with a note.
 */
export function heraldFrom(source: AdjustmentLayer, notes: Notes, name: string): { settings: HeraldAdjustment; table?: Uint8Array } | 'left out' | null {
  const mixer = (channel: ChannelMixerChannel | undefined, fallback: MixerRow): MixerRow =>
    channel ? { red: heraldRanged(channel.red, 'mixer', fallback.red), green: heraldRanged(channel.green, 'mixer', fallback.green), blue: heraldRanged(channel.blue, 'mixer', fallback.blue), constant: heraldRanged(channel.constant, 'mixer', fallback.constant) } : fallback
  const inks = (cmyk: { c: number; m: number; y: number; k: number } | undefined): Inks => ({
    cyan: heraldRanged(cmyk?.c, 'inks', 0),
    magenta: heraldRanged(cmyk?.m, 'inks', 0),
    yellow: heraldRanged(cmyk?.y, 'inks', 0),
    black: heraldRanged(cmyk?.k, 'inks', 0)
  })

  switch (source.type) {
    case 'brightness/contrast':
      if (source.useLegacy) {
        notes.add('Legacy Brightness/Contrast settings were kept as they are, and look a little different', name)
      }

      return { settings: { kind: 'Brightness/Contrast', brightness: heraldRanged(source.brightness, 'brightness', 0), contrast: heraldRanged(source.contrast, 'contrast', 0) } }
    case 'vibrance':
      return { settings: { kind: 'Vibrance', vibrance: heraldRanged(source.vibrance, 'vibrance', 0), saturation: heraldRanged(source.saturation, 'saturation', 0) } }
    case 'photo filter': {
      const defaults = defaultHeraldAdjustment('Photo Filter') as PhotoFilterSettings

      return { settings: { kind: 'Photo Filter', color: rgbOf(source.color, defaults.color), density: heraldRanged(source.density, 'density', defaults.density), preserveLuminosity: source.preserveLuminosity !== false } }
    }
    case 'channel mixer': {
      const defaults = defaultHeraldAdjustment('Channel Mixer') as ChannelMixerSettings

      return {
        settings: { kind: 'Channel Mixer', monochrome: Boolean(source.monochrome), red: mixer(source.red, defaults.red), green: mixer(source.green, defaults.green), blue: mixer(source.blue, defaults.blue), gray: mixer(source.gray, defaults.gray) }
      }
    }
    case 'selective color':
      return { settings: { kind: 'Selective Color', absolute: source.mode === 'absolute', ...(Object.fromEntries(SELECTIVE_RANGES.map((range) => [range, inks(source[range])])) as Record<SelectiveRange, Inks>) } }
    case 'posterize':
      return { settings: { kind: 'Posterize', levels: heraldRanged(source.levels, 'posterize', 4, true) } }
    case 'threshold':
      return { settings: { kind: 'Threshold', level: heraldRanged(source.level, 'threshold', 128, true) } }
    case 'color lookup': {
      const data = source.lut3DFileData

      if (!data || (source.lutFormat !== undefined && source.lutFormat !== 'cube')) {
        notes.add('Color Lookup layers with a .3dl or .look table, or a colour profile, have no counterpart and were left out', name)

        return 'left out'
      }

      try {
        const table = parseCube(data)

        return { settings: { kind: 'Color Lookup', name: source.lut3DFileName || source.name || 'Colour table', size: table.size }, table: data }
      } catch (error) {
        notes.add(`A Color Lookup's table could not be read (${error instanceof Error ? error.message : String(error)}), so the layer was left out`, name)

        return 'left out'
      }
    }
    default:
      return null
  }
}

/** Veritas's own adjustment as a Photoshop adjustment layer; a Color Lookup needs its table's file. */
export function heraldTo(settings: HeraldAdjustment, table: Uint8Array | undefined): AdjustmentLayer | null {
  const whole = (row: MixerRow) => ({ red: Math.round(row.red), green: Math.round(row.green), blue: Math.round(row.blue), constant: Math.round(row.constant) })
  const cmyk = (entry: Inks) => ({ c: Math.round(entry.cyan), m: Math.round(entry.magenta), y: Math.round(entry.yellow), k: Math.round(entry.black) })

  switch (settings.kind) {
    case 'Brightness/Contrast':
      return { type: 'brightness/contrast', brightness: Math.round(settings.brightness), contrast: Math.round(settings.contrast), useLegacy: false }
    case 'Vibrance':
      return { type: 'vibrance', vibrance: Math.round(settings.vibrance), saturation: Math.round(settings.saturation) }
    case 'Photo Filter':
      return { type: 'photo filter', color: toPsdColor(settings.color), density: Math.round(settings.density), preserveLuminosity: settings.preserveLuminosity }
    case 'Channel Mixer':
      return { type: 'channel mixer', monochrome: settings.monochrome, red: whole(settings.red), green: whole(settings.green), blue: whole(settings.blue), gray: whole(settings.gray) }
    case 'Selective Color':
      return { type: 'selective color', mode: settings.absolute ? 'absolute' : 'relative', ...Object.fromEntries(SELECTIVE_RANGES.map((range) => [range, cmyk(settings[range])])) }
    case 'Posterize':
      return { type: 'posterize', levels: settings.levels }
    case 'Threshold':
      return { type: 'threshold', level: settings.level }
    case 'Color Lookup':
      return table && settings.size > 0 ? { type: 'color lookup', lookupType: '3dlut', name: settings.name, lutFormat: 'cube', lut3DFileData: table, lut3DFileName: settings.name } : null
    default:
      return null
  }
}

function curveFrom(points: CurvesAdjustmentChannel | undefined): CurvePoint[] {
  const sorted = (points ?? [])
    .map((point) => ({ x: Math.round(clamp(point.input, RANGES.curveValue)), y: Math.round(clamp(point.output, RANGES.curveValue)) }))
    .sort((a, b) => a.x - b.x)
    .filter((point, i, all) => i === 0 || point.x > all[i - 1].x)
  const curve = sorted.length ? sorted : [{ x: 0, y: 0 }]

  if (curve[0].x !== 0) {
    curve.unshift({ x: 0, y: curve[0].y })
  }

  if (curve.at(-1)!.x !== 255) {
    curve.push({ x: 255, y: curve.length > 1 ? curve.at(-1)!.y : 255 })
  }

  // The format takes at most 32 points: keep the ends and an even spread of the rest.
  if (curve.length > RANGES.curvePoints[1]) {
    const most = RANGES.curvePoints[1]

    return Array.from({ length: most }, (_, i) => curve[Math.round((i * (curve.length - 1)) / (most - 1))])
  }

  return curve
}

/** A colour's hue (degrees) and saturation (percent), as HSL reads them. */
function hueAndSaturation({ red, green, blue }: RGB): [number, number] {
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const l = (max + min) / 2
  const d = max - min

  if (!d) {
    return [0, 0]
  }

  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === red ? (green - blue) / d + (green < blue ? 6 : 0) : max === green ? (blue - red) / d + 2 : (red - green) / d + 4

  return [h * 60, s * 100]
}

/** Veritas's layer effects from Photoshop's, with what does not carry over noted. */
export function effectsFrom(fx: LayerEffectsInfo, globalAngle: number, notes: Notes, name: string): LayerEffects | undefined {
  const effects: LayerEffects = {}
  const off = fx.disabled === true
  const shown = (record: { enabled?: boolean } | undefined) => (off || record?.enabled === false ? { enabled: false } : {})
  const first = <T>(list: T[] | undefined, what: string): T | undefined => {
    if (list && list.length > 1) {
      notes.add(`Only the first ${what} of each layer was kept`, name)
    }

    return list?.[0]
  }
  const shadow = (record: LayerEffectShadow | undefined, defaults: ShadowEffect): ShadowEffect | undefined => {
    if (!record) {
      return undefined
    }

    if (record.choke && pixelsOf(record.choke, 0) > 0) {
      notes.add('Shadow spread and choke were left out', name)
    }

    return {
      ...shown(record),
      angle: ranged(record.useGlobalLight ? globalAngle : record.angle, 'shadowAngle', defaults.angle),
      distance: ranged(pixelsOf(record.distance, defaults.distance), 'shadowDistance', defaults.distance),
      blur: ranged(pixelsOf(record.size, defaults.blur), 'shadowBlur', defaults.blur),
      ...rgbOf(record.color, defaults),
      opacity: ranged(record.opacity, 'opacity', defaults.opacity)
    }
  }
  const glow = (record: LayerEffectsInfo['outerGlow'] | LayerEffectsInfo['innerGlow'], defaults: GlowEffect, inner: boolean): GlowEffect | undefined => {
    if (!record) {
      return undefined
    }

    if (inner && (record as { source?: string }).source === 'center') {
      notes.add('Inner glows from the centre became glows from the edge', name)
    }

    if (record.choke && pixelsOf(record.choke, 0) > 0) {
      notes.add('Glow spread and choke were left out', name)
    }

    return { ...shown(record), size: ranged(pixelsOf(record.size, defaults.size), 'glowSize', defaults.size), ...rgbOf(record.color, defaults), opacity: ranged(record.opacity, 'opacity', defaults.opacity) }
  }

  const drop = shadow(first(fx.dropShadow, 'drop shadow'), defaultEffect.shadow())
  const inner = shadow(first(fx.innerShadow, 'inner shadow'), defaultEffect.innerShadow())
  const outer = glow(fx.outerGlow, defaultEffect.outerGlow(), false)
  const innerGlow = glow(fx.innerGlow, defaultEffect.innerGlow(), true)
  const fill = first(fx.solidFill, 'colour overlay')
  const stroke = first(fx.stroke, 'stroke')

  if (drop) effects.shadow = drop
  if (inner) effects.innerShadow = inner
  if (outer) effects.outerGlow = outer
  if (innerGlow) effects.innerGlow = innerGlow

  if (fill) {
    if (fill.blendMode && fill.blendMode !== 'normal') {
      notes.add('Colour overlays in blend modes other than Normal became Normal', name)
    }

    effects.colorOverlay = { ...shown(fill), ...rgbOf(fill.color, defaultEffect.colorOverlay()), opacity: ranged(fill.opacity, 'opacity', 1) }
  }

  if (stroke) {
    if (stroke.fillType && stroke.fillType !== 'color') {
      notes.add('Gradient and pattern strokes became solid strokes', name)
    }

    if (stroke.position === 'center') {
      notes.add('Centred strokes became outside strokes', name)
    }

    const defaults = defaultEffect.stroke()
    effects.stroke = {
      ...shown(stroke),
      size: ranged(pixelsOf(stroke.size, defaults.size), 'strokeSize', defaults.size),
      ...rgbOf(stroke.color, defaults),
      opacity: ranged(stroke.opacity, 'opacity', 1),
      inside: stroke.position === 'inside'
    }
  }

  const dropped = [fx.bevel && 'bevel and emboss', fx.satin && 'satin', fx.gradientOverlay?.length && 'gradient overlay', fx.patternOverlay && 'pattern overlay'].filter(Boolean)

  if (dropped.length) {
    notes.add(`Layer effects Veritas Canvas does not draw (${dropped.join(', ')}) were left out`, name)
  }

  return Object.keys(effects).length ? effects : undefined
}

const JUSTIFY: Record<string, TextAlignment> = { left: 'Left', center: 'Center', right: 'Right', 'justify-left': 'Left', 'justify-center': 'Center', 'justify-right': 'Right', 'justify-all': 'Left' }

/** A Photoshop text layer as Veritas's text record and its anchor, or null (with a note) when it has to stay a picture. */
export function textFrom(layer: Layer, notes: Notes, name: string): { text: TextStyle; anchor: Vec2 } | null {
  const source = layer.text

  if (!source) {
    return null
  }

  const [xx = 1, xy = 0, yx = 0, yy = 1, tx = 0, ty = 0] = source.transform ?? []
  const keep = (why: string) => {
    notes.add(`Text kept as a picture, as ${why}`, name)

    return null
  }

  if (source.orientation === 'vertical') {
    return keep('Veritas Canvas sets text horizontally')
  }

  if (source.warp && source.warp.style && source.warp.style !== 'none') {
    return keep('it is warped')
  }

  if (Math.abs(xy) > 1e-3 || Math.abs(yx) > 1e-3 || xx <= 0 || yy <= 0 || Math.abs(xx - yy) > 0.01 * Math.max(xx, yy)) {
    return keep('it is turned, slanted or stretched')
  }

  const scale = Math.sqrt(xx * yy)
  const runs = source.styleRuns ?? []
  // Photoshop keeps the face and colour in the runs: the text's own are the ones most of it uses.
  const dominant = <T>(pick: (style: PsdTextStyle) => T | undefined, key: (value: T) => string): T | undefined => {
    const lengths = new Map<string, { value: T; length: number }>()

    for (const run of runs) {
      const value = pick({ ...source.style, ...run.style })

      if (value !== undefined) {
        const entry = lengths.get(key(value)) ?? { value, length: 0 }
        entry.length += run.length
        lengths.set(key(value), entry)
      }
    }

    return [...lengths.values()].sort((a, b) => b.length - a.length)[0]?.value
  }
  const font = dominant((style) => style.font, (value) => value.name)
  const fill = dominant((style) => style.fillColor, (value) => JSON.stringify(value))
  const base: PsdTextStyle = { ...source.style, ...runs[0]?.style, ...(font ? { font } : {}), ...(fill ? { fillColor: fill } : {}) }
  let content = source.text.replace(/[\r\u0003]/g, '\n')

  if (content.endsWith('\n')) {
    content = content.slice(0, -1)
  }

  if (!content.trim() || content.length > LIMITS_TEXT.content) {
    return keep(content.trim() ? 'it is too long' : 'it is empty')
  }

  const fontSize = clamp((base.fontSize ?? 12) * scale, RANGES.fontSize)
  const fontName = validFontName(base.font?.name) ?? 'Helvetica'
  const justification = source.paragraphStyle?.justification ?? source.paragraphStyleRuns?.[0]?.style.justification ?? 'left'

  if (justification.startsWith('justify')) {
    notes.add('Justified text is set ragged when it is edited', name)
  }

  const styleNotes = [base.fauxBold && 'faux bold', base.fauxItalic && 'faux italic', base.underline && 'underline', base.strikethrough && 'strikethrough', (base.horizontalScale ?? 1) !== 1 && 'horizontal scale', (base.verticalScale ?? 1) !== 1 && 'vertical scale', base.baselineShift && 'baseline shift'].filter(Boolean)

  if (styleNotes.length) {
    notes.add(`Text styling Veritas Canvas lacks (${styleNotes.join(', ')}) goes when the text is edited`, name)
  }

  const text: TextStyle = {
    content,
    fontName,
    fontSize,
    ...rgbOf(base.fillColor, { red: 0, green: 0, blue: 0 }),
    alignment: JUSTIFY[justification] ?? 'Left',
    tracking: clamp(((base.tracking ?? 0) / 1000) * fontSize, RANGES.tracking),
    leading: base.autoLeading === false && base.leading ? clamp(base.leading * scale, RANGES.leading) : 0
  }
  let anchor: Vec2 = [tx, ty]

  if (source.shapeType === 'box' && source.boxBounds?.length === 4) {
    const [left, top, right, bottom] = source.boxBounds
    const box: Vec2 = [clamp((right - left) * scale, RANGES.textBox), clamp((bottom - top) * scale, RANGES.textBox)]

    if (box[0] * box[1] <= LIMITS_TEXT.boxArea) {
      text.boxSize = [Math.round(box[0]), Math.round(box[1])]
      anchor = [tx + left * scale, ty + top * scale]
    }
  }

  const colorRuns: TextColorRun[] = []
  const fontRuns: TextFontRun[] = []
  let at = 0

  for (const run of runs) {
    const length = Math.min(run.length, content.length - at)

    if (length <= 0) {
      break
    }

    const style = { ...base, ...run.style }
    const colour = rgbOf(style.fillColor, text)
    const face = validFontName(style.font?.name) ?? fontName
    const last = colorRuns.at(-1)

    if (colour.red !== text.red || colour.green !== text.green || colour.blue !== text.blue) {
      if (last && last.location + last.length === at && last.red === colour.red && last.green === colour.green && last.blue === colour.blue) {
        last.length += length
      } else {
        colorRuns.push({ location: at, length, ...colour })
      }
    }

    if (face !== fontName) {
      const lastFont = fontRuns.at(-1)

      if (lastFont && lastFont.location + lastFont.length === at && lastFont.fontName === face) {
        lastFont.length += length
      } else {
        fontRuns.push({ location: at, length, fontName: face })
      }
    }

    at += run.length
  }

  if (colorRuns.length) text.colorRuns = colorRuns
  if (fontRuns.length) text.fontRuns = fontRuns

  return { text, anchor }
}

const validFontName = (name: string | undefined): string | undefined => (name && name.length <= LIMITS_TEXT.fontName && !/[\n\r\u2028\u2029]/.test(name) ? name : undefined)

interface MaskResult {
  mask: PixelData
  enabled: boolean
  /** Placed on its own (it stays where it is when the layer moves), rather than stretched over the layer's box. */
  placement?: LayerRecord['transform']
}

/** A Photoshop layer mask over a box (the layer's pixels, or the whole document for folders and adjustments). */
function maskFrom(mask: LayerMaskData | undefined, box: { x: number; y: number; width: number; height: number }, ownBox: boolean, notes: Notes, name: string): MaskResult | null {
  if (!mask) {
    return null
  }

  const outside = (mask.defaultColor ?? 0) >= 128 ? 255 : 0
  const enabled = !mask.disabled
  const image = mask.imageData
  const left = mask.left ?? 0
  const top = mask.top ?? 0
  const width = Math.max(0, (mask.right ?? 0) - left)
  const height = Math.max(0, (mask.bottom ?? 0) - top)

  if (!image || !width || !height) {
    // Nothing but what lies outside it: one value over the whole box.
    return { mask: { width: 1, height: 1, channels: 1, data: new Uint8ClampedArray([outside]) }, enabled }
  }

  const pixels = eightBit(width, height, image.data, 1)

  if (!ownBox && outside === 0) {
    return { mask: pixels, enabled, placement: defaultTransform(width, height, left, top) }
  }

  if (box.width * box.height > LIMITS.sourcePixels) {
    notes.add('A mask too large to hold was left out', name)

    return null
  }

  const out = new Uint8ClampedArray(box.width * box.height).fill(outside)

  for (let y = 0; y < height; y++) {
    const dy = top + y - box.y

    if (dy < 0 || dy >= box.height) {
      continue
    }

    for (let x = 0; x < width; x++) {
      const dx = left + x - box.x

      if (dx >= 0 && dx < box.width) {
        out[dy * box.width + dx] = pixels.data[y * width + x]
      }
    }
  }

  return { mask: { width: box.width, height: box.height, channels: 1, data: out }, enabled }
}

/** A Photoshop document (read with `useImageData`) as Veritas layers, with notes on what changed on the way. */
export function fromPsd(psd: Psd): ImportedPsd {
  const notes = new Notes()
  const layers: PsdLayer[] = []
  const { width, height } = psd
  const globalAngle = psd.imageResources?.globalAngle ?? 120

  if ((psd.bitsPerChannel ?? 8) > 8) {
    notes.add(`${psd.bitsPerChannel}-bit colour was reduced to 8 bits a channel`)
  }

  if (psd.colorMode !== undefined && psd.colorMode !== 3) {
    notes.add('Colours were converted to RGB without colour management')
  }

  const walk = (children: Layer[], parentID: string | undefined) => {
    // The base of the clipping stack forming at this level: the last layer that is not clipped.
    let base: PsdLayer | null = null

    for (const source of children) {
      const name = source.name?.trim() || 'Layer'
      const id = newId()
      const isGroup = Boolean(source.children)
      const blend = source.blendMode ?? (isGroup ? 'pass through' : 'normal')
      const record: LayerRecord = {
        id,
        name,
        isVisible: !source.hidden,
        transform: defaultTransform(width, height),
        isGroup,
        opacity: percent((source.opacity ?? 1) * (isGroup ? 1 : (source.fillOpacity ?? 1))),
        blendMode: 'Normal'
      }

      if (parentID) {
        record.parentID = parentID
      }

      if (!isGroup && (source.fillOpacity ?? 1) < 1 && source.effects) {
        notes.add('Fill opacity was folded into the layer opacity, which also fades its effects', name)
      }

      if (isGroup) {
        if (blend !== 'pass through' && blend !== 'normal') {
          notes.add(`Folders are pass-through in Veritas Canvas, so a folder’s own blend mode (${blendLabel(blend)}) became Pass Through`, name)
        }
      } else if (FROM_PSD_BLEND[blend]) {
        record.blendMode = FROM_PSD_BLEND[blend]
      } else {
        notes.add(`Blend mode ${blendLabel(blend)} has no counterpart and became Normal`, name)
      }

      let pixels: PixelData | null = null
      let table: Uint8Array | null = null
      const left = source.left ?? 0
      const top = source.top ?? 0
      const layerWidth = Math.max(0, (source.right ?? 0) - left)
      const layerHeight = Math.max(0, (source.bottom ?? 0) - top)

      if (!isGroup && source.imageData && layerWidth && layerHeight) {
        if (layerWidth * layerHeight > LIMITS.sourcePixels) {
          notes.add('A layer too large to hold was left empty', name)
        } else {
          pixels = eightBit(layerWidth, layerHeight, source.imageData.data, 4)
          record.transform = defaultTransform(layerWidth, layerHeight, left, top)
        }
      }

      if (source.adjustment) {
        const herald = heraldFrom(source.adjustment, notes, name)
        // A Veritas-only kind's stand-in is made when the document is put together; Levels holds its place.
        const adjustment = herald ? (herald === 'left out' ? null : defaultAdjustment('Levels')) : adjustmentFrom(source.adjustment, notes, name)

        if (!adjustment) {
          continue
        }

        record.adjustment = adjustment

        if (herald && herald !== 'left out') {
          record.heraldAdjustment = herald.settings
          table = herald.table ?? null
        }

        pixels = null
        record.transform = defaultTransform(width, height)
      }

      const box = pixels ? { x: left, y: top, width: layerWidth, height: layerHeight } : { x: 0, y: 0, width, height }
      const mask = maskFrom(source.realMask ?? source.mask, box, Boolean(pixels), notes, name)

      if (source.vectorMask && !source.realMask && !source.mask) {
        notes.add('Vector masks were left out', name)
      }

      if (source.placedLayer) {
        notes.add('Smart objects became plain pixels', name)
      }

      if (source.effects && !isGroup && !record.adjustment) {
        const effects = effectsFrom(source.effects, globalAngle, notes, name)

        if (effects) {
          record.effects = effects
        }
      } else if (source.effects && (isGroup || record.adjustment)) {
        notes.add('Effects on folders and adjustment layers were left out', name)
      }

      if (mask) {
        record.maskEnabled = mask.enabled
        record.maskLinked = !mask.placement

        if (mask.placement) {
          record.maskPlacement = mask.placement
        }
      }

      const layer: PsdLayer = { record, pixels, mask: mask?.mask ?? null, ...(table ? { table } : {}) }

      if (source.text && pixels) {
        const text = textFrom(source, notes, name)

        if (text) {
          record.text = text.text
          layer.textAnchor = text.anchor
        }
      }

      if (source.clipping && !isGroup) {
        if (base && !base.record.isGroup && !base.record.adjustment) {
          record.maskSourceID = base.record.id

          // Photoshop hides a clipping stack with its base; Veritas would go on clipping to a hidden base.
          if (!base.record.isVisible && record.isVisible) {
            record.isVisible = false
            notes.add('Layers clipped to a hidden layer were hidden too, as Photoshop shows them', name)
          }
        } else {
          notes.add('Clipping to a folder or an adjustment layer was let go', name)
        }
      } else {
        base = layer
      }

      layers.push(layer)

      if (isGroup) {
        walk(source.children ?? [], id)
      }
    }
  }

  walk(psd.children ?? [], undefined)

  // A document without layers is its composite, as one layer.
  if (!layers.length && psd.imageData) {
    const record: LayerRecord = { id: newId(), name: 'Background', isVisible: true, transform: defaultTransform(width, height), isGroup: false, opacity: 1, blendMode: 'Normal' }
    layers.push({ record, pixels: eightBit(width, height, psd.imageData.data, 4), mask: null })
  }

  const resolution = psd.imageResources?.resolutionInfo
  const ppi = resolution ? (resolution.horizontalResolutionUnit === 'PPCM' ? resolution.horizontalResolution * 2.54 : resolution.horizontalResolution) : 72

  return { width, height, resolution: clamp(Math.round(ppi) || 72, [1, 9600]), layers, notes: notes.list() }
}

// --- Veritas to Photoshop -----------------------------------------------------------------------

export interface PsdSourceLayer {
  record: LayerRecord
  /** A Color Lookup layer's `.cube` file. */
  table?: Uint8Array
  /** The pixels as they sit in the document, unturned: their top-left corner and size. */
  pixels: { left: number; top: number; image: PixelData } | null
  /** The mask as it sits in the document, and the value outside it. */
  mask: { left: number; top: number; image: PixelData; outside: 0 | 255 } | null
  /** For text: layout pixels to the document (scale and turn, then the anchor's place), as Photoshop's text transform. */
  textTransform?: [number, number, number, number, number, number]
}

export interface PsdSource {
  width: number
  height: number
  resolution: number
  /** Bottom to top, folders before what is in them (the `.comp` order). */
  layers: PsdSourceLayer[]
  /** The flattened image, which Photoshop shows when it does not read the layers (and Finder's previews). */
  composite: PixelData
}

const asImageData = (image: PixelData) => {
  if (image.channels === 4) {
    return { width: image.width, height: image.height, data: image.data }
  }

  const data = new Uint8ClampedArray(image.width * image.height * 4)

  for (let i = 0; i < image.width * image.height; i++) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = image.data[i]
    data[i * 4 + 3] = 255
  }

  return { width: image.width, height: image.height, data }
}

/** Veritas's adjustment as a Photoshop adjustment layer, or null for the four Photoshop keeps as filters. */
export function adjustmentTo(adjustment: Adjustment): AdjustmentLayer | null {
  switch (adjustment.kind) {
    case 'Hue/Saturation': {
      const channel: HueSaturationAdjustmentChannel = adjustment.colorize
        ? { a: 256, b: Math.round(((adjustment.hue % 360) + 360) % 360), c: Math.round(clamp(adjustment.saturation, [0, 100])), d: Math.round(adjustment.lightness), hue: 0, saturation: 0, lightness: 0 }
        : { a: 0, b: 0, c: 0, d: 0, hue: Math.round(((((adjustment.hue + 180) % 360) + 360) % 360) - 180), saturation: Math.round(adjustment.saturation), lightness: Math.round(adjustment.lightness) }

      return { type: 'hue/saturation', master: channel }
    }
    case 'Levels': {
      const channel = (range: LevelRange): LevelsAdjustmentChannel => ({ shadowInput: range.black, highlightInput: range.white, midtoneInput: range.gamma, shadowOutput: range.outputBlack, highlightOutput: range.outputWhite })
      const [rgb, red, green, blue] = adjustment.levels.ranges

      return { type: 'levels', rgb: channel(rgb), red: channel(red), green: channel(green), blue: channel(blue) }
    }
    case 'Curves': {
      const channel = (points: CurvePoint[]): CurvesAdjustmentChannel => points.map((point) => ({ input: point.x, output: point.y }))
      const [rgb, red, green, blue] = adjustment.curves.channels

      return { type: 'curves', rgb: channel(rgb), red: channel(red), green: channel(green), blue: channel(blue) }
    }
    case 'Exposure': {
      const settings = adjustment.exposureSettings ?? { exposure: 0, offset: 0, gamma: 1 }

      return { type: 'exposure', exposure: settings.exposure, offset: settings.offset, gamma: settings.gamma }
    }
    case 'Invert':
      return { type: 'invert' }
    case 'Black & White': {
      const settings = adjustment.blackWhiteSettings ?? defaultAdjustment('Black & White').blackWhiteSettings!
      const tint = hslColour(settings.tintHue, settings.tintSaturation / 100, 0.5)

      return { type: 'black & white', reds: settings.reds, yellows: settings.yellows, greens: settings.greens, cyans: settings.cyans, blues: settings.blues, magentas: settings.magentas, useTint: settings.tint, tintColor: toPsdColor(tint) }
    }
    case 'Color Balance': {
      const settings = adjustment.colorBalanceSettings ?? defaultAdjustment('Color Balance').colorBalanceSettings!

      return {
        type: 'color balance',
        shadows: { cyanRed: settings.shadowCyanRed, magentaGreen: settings.shadowMagentaGreen, yellowBlue: settings.shadowYellowBlue },
        midtones: { cyanRed: settings.midCyanRed, magentaGreen: settings.midMagentaGreen, yellowBlue: settings.midYellowBlue },
        highlights: { cyanRed: settings.highlightCyanRed, magentaGreen: settings.highlightMagentaGreen, yellowBlue: settings.highlightYellowBlue },
        preserveLuminosity: settings.preserveLuminosity
      }
    }
    case 'Gradient Map': {
      const settings = adjustment.gradientMapSettings ?? defaultAdjustment('Gradient Map').gradientMapSettings!

      return {
        type: 'gradient map',
        name: 'Veritas Canvas',
        gradientType: 'solid',
        reverse: settings.reversed,
        smoothness: 1,
        colorStops: [
          { color: toPsdColor(settings.shadows), location: 0, midpoint: 0.5 },
          { color: toPsdColor(settings.highlights), location: 1, midpoint: 0.5 }
        ],
        opacityStops: [
          { opacity: 1, location: 0, midpoint: 0.5 },
          { opacity: 1, location: 1, midpoint: 0.5 }
        ]
      }
    }
    default:
      return null
  }
}

function hslColour(hue: number, saturation: number, lightness: number): RGB {
  const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation
  const p = 2 * lightness - q
  const channel = (t: number) => {
    const u = ((t % 1) + 1) % 1

    return u < 1 / 6 ? p + (q - p) * 6 * u : u < 0.5 ? q : u < 2 / 3 ? p + (q - p) * (2 / 3 - u) * 6 : p
  }
  const h = hue / 360

  return { red: channel(h + 1 / 3), green: channel(h), blue: channel(h - 1 / 3) }
}

/** Veritas's layer effects as Photoshop's. */
export function effectsTo(effects: LayerEffects): LayerEffectsInfo | undefined {
  const fx: LayerEffectsInfo = {}
  const enabled = (record: { enabled?: boolean }) => record.enabled !== false
  const shadow = (record: ShadowEffect, blendMode: PsdBlendMode): LayerEffectShadow => ({
    present: true,
    showInDialog: true,
    enabled: enabled(record),
    size: px(record.blur),
    angle: record.angle,
    distance: px(record.distance),
    color: toPsdColor(record),
    blendMode,
    opacity: record.opacity,
    useGlobalLight: false,
    choke: px(0)
  })
  const glow = (record: GlowEffect) => ({ present: true, showInDialog: true, enabled: enabled(record), size: px(record.size), color: toPsdColor(record), blendMode: 'screen' as const, opacity: record.opacity, choke: px(0), range: 0.5 })

  if (effects.shadow) fx.dropShadow = [shadow(effects.shadow, 'multiply')]
  if (effects.innerShadow) fx.innerShadow = [shadow(effects.innerShadow, 'multiply')]
  if (effects.outerGlow) fx.outerGlow = glow(effects.outerGlow)
  if (effects.innerGlow) fx.innerGlow = { ...glow(effects.innerGlow), source: 'edge' }
  if (effects.colorOverlay) fx.solidFill = [{ present: true, showInDialog: true, enabled: enabled(effects.colorOverlay), blendMode: 'normal', color: toPsdColor(effects.colorOverlay), opacity: effects.colorOverlay.opacity }]

  if (effects.stroke) {
    const stroke = effects.stroke
    fx.stroke = [{ present: true, showInDialog: true, enabled: enabled(stroke), size: px(stroke.size), position: stroke.inside ? 'inside' : 'outside', fillType: 'color', blendMode: 'normal', opacity: stroke.opacity, color: toPsdColor(stroke) }]
  }

  return Object.keys(fx).length ? fx : undefined
}

/**
 * Veritas's text record as Photoshop's (Photoshop sets it again when the person updates the layer):
 * `transform` takes layout pixels to the document, its last two numbers the anchor's place.
 */
export function textTo(text: TextStyle, transform: [number, number, number, number, number, number]): NonNullable<Layer['text']> {
  const content = text.content.replace(/\n/g, '\r')
  const color = toPsdColor(text)
  const style: PsdTextStyle = {
    font: { name: text.fontName },
    fontSize: text.fontSize,
    fillColor: color,
    tracking: text.fontSize ? Math.round((text.tracking / text.fontSize) * 1000) : 0,
    autoLeading: !text.leading,
    ...(text.leading ? { leading: text.leading } : {})
  }
  const boundaries = new Set([0, content.length])

  for (const run of [...(text.colorRuns ?? []), ...(text.fontRuns ?? [])]) {
    boundaries.add(run.location)
    boundaries.add(Math.min(content.length, run.location + run.length))
  }

  const cuts = [...boundaries].filter((cut) => cut >= 0 && cut <= content.length).sort((a, b) => a - b)
  const styleRuns = cuts.slice(0, -1).map((start, i) => {
    const colour = text.colorRuns?.find((run) => start >= run.location && start < run.location + run.length)
    const font = text.fontRuns?.find((run) => start >= run.location && start < run.location + run.length)

    return { length: cuts[i + 1] - start, style: { ...style, ...(colour ? { fillColor: toPsdColor(colour) } : {}), ...(font ? { font: { name: font.fontName } } : {}) } }
  })
  const record: NonNullable<Layer['text']> = {
    text: content,
    transform,
    antiAlias: 'smooth',
    style,
    ...(styleRuns.length > 1 ? { styleRuns } : {}),
    paragraphStyle: { justification: text.alignment === 'Center' ? 'center' : text.alignment === 'Right' ? 'right' : 'left' }
  }

  if (text.boxSize && text.boxSize[0] > 0) {
    record.shapeType = 'box'
    record.boxBounds = [0, 0, text.boxSize[0], text.boxSize[1]]
  }

  return record
}

/** Veritas layers as a Photoshop document (with notes on what changed on the way). */
export function toPsd(source: PsdSource): { psd: Psd; notes: string[] } {
  const notes = new Notes()
  const byParent = new Map<string | undefined, PsdSourceLayer[]>()

  for (const layer of source.layers) {
    const key = layer.record.parentID
    byParent.set(key, [...(byParent.get(key) ?? []), layer])
  }

  const build = (parent: string | undefined): Layer[] =>
    (byParent.get(parent) ?? []).flatMap((entry): Layer[] => {
      const { record } = entry
      const layer: Layer = { name: record.name, hidden: !record.isVisible, opacity: record.opacity ?? 1 }

      if (entry.mask) {
        const { left, top, image, outside } = entry.mask
        layer.mask = { left, top, right: left + image.width, bottom: top + image.height, defaultColor: outside, disabled: record.maskEnabled === false, imageData: asImageData(image) }
      }

      if (record.isGroup) {
        return [{ ...layer, blendMode: 'pass through', opened: true, children: build(record.id) }]
      }

      layer.blendMode = TO_PSD_BLEND[record.blendMode ?? 'Normal'] ?? 'normal'

      if (record.maskSourceID) {
        layer.clipping = true
      }

      if (record.adjustment) {
        const herald = record.heraldAdjustment && isHeraldKind(record.heraldAdjustment.kind) ? record.heraldAdjustment : null
        // A kind from a newer Veritas Canvas goes as its stand-in.
        const adjustment = herald ? heraldTo(herald, entry.table) : adjustmentTo(record.adjustment)

        if (!adjustment) {
          notes.add(herald?.kind === 'Color Lookup' ? 'A Color Lookup without a table was left out' : `${record.adjustment.kind} has no adjustment layer in Photoshop: it shows in the flattened image only`, record.name)

          return []
        }

        return [{ ...layer, adjustment }]
      }

      if (entry.pixels) {
        layer.left = entry.pixels.left
        layer.top = entry.pixels.top
        layer.right = entry.pixels.left + entry.pixels.image.width
        layer.bottom = entry.pixels.top + entry.pixels.image.height
        layer.imageData = asImageData(entry.pixels.image)
      }

      if (record.effects) {
        const fx = effectsTo(record.effects)

        if (fx) {
          layer.effects = fx
        }
      }

      if (record.text && entry.textTransform) {
        layer.text = textTo(record.text, entry.textTransform)
      }

      if (record.shape) {
        notes.add('Shape layers were written as pixels', record.name)
      }

      return [layer]
    })

  const psd: Psd = {
    width: source.width,
    height: source.height,
    children: build(undefined),
    imageData: asImageData(source.composite),
    imageResources: {
      resolutionInfo: { horizontalResolution: source.resolution, horizontalResolutionUnit: 'PPI', widthUnit: 'Inches', verticalResolution: source.resolution, verticalResolutionUnit: 'PPI', heightUnit: 'Inches' }
    }
  }

  return { psd, notes: notes.list() }
}

export { Notes }
