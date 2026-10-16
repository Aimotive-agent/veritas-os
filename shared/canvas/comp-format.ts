/*
 * Veritas Canvas projects: the `.comp` package, a folder holding `manifest.json` and an `images/`
 * folder of 8-bit PNGs (RGBA layers, grayscale masks). The same format is read by Compositor on the
 * Mac, so a project moves between the two. Readers there decode records strictly, so every record
 * this module writes is complete, and fields it does not know are kept as they were.
 */

export const FORMAT_ID = 'com.compositor.project'
export const FORMAT_VERSION = 11
export const OLDEST_VERSION = 1

export const LIMITS = {
  side: 30_000,
  layers: 10_000,
  guides: 1_000,
  manifestBytes: 4 * 1024 * 1024,
  assetBytes: 512 * 1024 * 1024,
  sourcePixels: 100_000_000,
  depth: 64,
  clipChain: 256
} as const

/**
 * The values Compositor accepts, field by field ([lowest, highest], both allowed). It refuses a
 * whole project, without a word, when one value is outside them, so the reader holds every field
 * here to the same bounds and the writer never sends one it would refuse.
 */
export const RANGES = {
  hue: [-360, 360],
  saturation: [-100, 100],
  lightness: [-100, 100],
  /** Levels: white must also sit above black. */
  levelsBlack: [0, 254],
  levelsWhite: [1, 255],
  levelsGamma: [0.1, 9.99],
  levelsOutput: [0, 255],
  /** Curves: points in a channel; the first sits at x 0 and the last at x 255. */
  curvePoints: [2, 32],
  curveValue: [0, 255],
  exposure: [-20, 20],
  exposureOffset: [-0.5, 0.5],
  exposureGamma: [0.01, 9.99],
  grainAmount: [0, 100],
  grainSize: [0.5, 20],
  grainRoughness: [0, 100],
  blackWhite: [-200, 300],
  tintHue: [0, 360],
  tintSaturation: [0, 100],
  colorBalance: [-100, 100],
  blurRadius: [0.1, 250],
  motionAngle: [-90, 90],
  motionDistance: [1, 2000],
  noiseAmount: [0.1, 400],
  seed: [0, 4_294_967_295],
  colour: [0, 1],
  opacity: [0, 1],
  strokeSize: [0, 500],
  shadowAngle: [-360, 360],
  shadowDistance: [0, 5000],
  shadowBlur: [0, 500],
  glowSize: [0, 500],
  fontSize: [1, 2000],
  tracking: [-100, 1000],
  /** Baseline to baseline in layer pixels; 0 is automatic (120% of the font size). */
  leading: [0, 5000],
  /** Each side of a paragraph box, whose area stays within `textBoxArea`. */
  textBox: [16, 30_000],
  layerSize: [1, 300_000],
  position: [-1_000_000, 1_000_000]
} as const satisfies Record<string, readonly [number, number]>

export type RangeName = keyof typeof RANGES

export const LIMITS_TEXT = { content: 100_000, boxArea: 200_000_000, fontName: 200, layerName: 16_384 } as const

export const BLEND_MODES = [
  'Normal',
  'Darken',
  'Multiply',
  'Color Burn',
  'Linear Burn',
  'Lighten',
  'Screen',
  'Color Dodge',
  'Linear Dodge (Add)',
  'Overlay',
  'Soft Light',
  'Hard Light',
  'Vivid Light',
  'Linear Light',
  'Pin Light',
  'Hard Mix',
  'Difference',
  'Exclusion',
  'Subtract',
  'Divide',
  'Hue',
  'Saturation',
  'Color',
  'Luminosity'
] as const

export type BlendMode = (typeof BLEND_MODES)[number]

export const ADJUSTMENT_KINDS = [
  'Hue/Saturation',
  'Levels',
  'Curves',
  'Exposure',
  'Gradient Map',
  'Grain',
  'Invert',
  'Black & White',
  'Color Balance',
  'Gaussian Blur',
  'Motion Blur',
  'Add Noise'
] as const

export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number]

/**
 * Adjustments only Veritas Canvas makes. Compositor reads `adjustment.kind` from its own closed list
 * and refuses a whole project over a kind it does not know, so these never go there: a layer keeps
 * one in `heraldAdjustment`, which Compositor skips like any field it does not know, while
 * `adjustment` holds one of Compositor's kinds, the very same change where one exists, otherwise
 * none (see ADR-020).
 */
export const HERALD_ADJUSTMENT_KINDS = ['Brightness/Contrast', 'Vibrance', 'Photo Filter', 'Channel Mixer', 'Selective Color', 'Posterize', 'Threshold', 'Color Lookup'] as const

export type HeraldAdjustmentKind = (typeof HERALD_ADJUSTMENT_KINDS)[number]

export const isHeraldKind = (kind: unknown): kind is HeraldAdjustmentKind => (HERALD_ADJUSTMENT_KINDS as readonly unknown[]).includes(kind)

/** Bounds of the Veritas-only settings: Veritas's own, since Compositor never reads them. */
export const HERALD_RANGES = {
  brightness: [-150, 150],
  contrast: [-50, 100],
  vibrance: [-100, 100],
  saturation: [-100, 100],
  density: [0, 100],
  mixer: [-200, 200],
  inks: [-100, 100],
  posterize: [2, 255],
  threshold: [1, 255],
  /** Entries along each side of a colour table; 0 is a Color Lookup without one yet. */
  tableSize: [2, 65]
} as const satisfies Record<string, readonly [number, number]>

export const SELECTIVE_RANGES = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks'] as const
export type SelectiveRange = (typeof SELECTIVE_RANGES)[number]

/** A Channel Mixer output: percentages of the red, green and blue inputs, plus a constant. */
export interface MixerRow {
  red: number
  green: number
  blue: number
  constant: number
}

/** Selective Color's changes to one range, as percentages of each ink. */
export interface Inks {
  cyan: number
  magenta: number
  yellow: number
  black: number
}

interface OpenRecord {
  [key: string]: unknown
}

export interface BrightnessContrastSettings extends OpenRecord {
  kind: 'Brightness/Contrast'
  brightness: number
  contrast: number
}

export interface VibranceSettings extends OpenRecord {
  kind: 'Vibrance'
  vibrance: number
  saturation: number
}

export interface PhotoFilterSettings extends OpenRecord {
  kind: 'Photo Filter'
  color: RGB
  /** Percent. */
  density: number
  preserveLuminosity: boolean
}

export interface ChannelMixerSettings extends OpenRecord {
  kind: 'Channel Mixer'
  /** One gray output from the gray row instead of three colour ones. */
  monochrome: boolean
  red: MixerRow
  green: MixerRow
  blue: MixerRow
  gray: MixerRow
}

export interface SelectiveColorSettings extends OpenRecord, Record<SelectiveRange, Inks> {
  kind: 'Selective Color'
  /** Changes by the given amount, rather than by that share of the ink there is. */
  absolute: boolean
}

export interface PosterizeSettings extends OpenRecord {
  kind: 'Posterize'
  levels: number
}

export interface ThresholdSettings extends OpenRecord {
  kind: 'Threshold'
  level: number
}

/** A colour table, kept in the project as `images/<layer ID>.cube` once `size` is above 0. */
export interface ColorLookupSettings extends OpenRecord {
  kind: 'Color Lookup'
  /** What the table was called (its file name). */
  name: string
  size: number
}

export type HeraldAdjustment =
  | BrightnessContrastSettings
  | VibranceSettings
  | PhotoFilterSettings
  | ChannelMixerSettings
  | SelectiveColorSettings
  | PosterizeSettings
  | ThresholdSettings
  | ColorLookupSettings

export const SAMPLING = ['High quality', 'Smooth', 'Nearest'] as const
export type Sampling = (typeof SAMPLING)[number]

export type Vec2 = [number, number]

export interface LayerTransform {
  origin: Vec2
  size: Vec2
  rotation: number
  flipX: boolean
  flipY: boolean
  sampling: Sampling
}

export interface RGB {
  red: number
  green: number
  blue: number
}

export interface LevelRange {
  black: number
  gamma: number
  white: number
  outputBlack: number
  outputWhite: number
}

export const CHANNELS = ['RGB', 'Red', 'Green', 'Blue'] as const
export type Channel = (typeof CHANNELS)[number]

export interface LevelsSettings {
  channel: Channel
  /** RGB, then red, green and blue. */
  ranges: [LevelRange, LevelRange, LevelRange, LevelRange]
}

export interface CurvePoint {
  x: number
  y: number
}

export interface CurvesSettings {
  channel: Channel
  /** RGB, then red, green and blue; points run from x 0 to 255 in increasing x. */
  channels: [CurvePoint[], CurvePoint[], CurvePoint[], CurvePoint[]]
}

export interface ExposureSettings {
  exposure: number
  offset: number
  gamma: number
}

export interface GradientMapSettings {
  shadows: RGB
  highlights: RGB
  reversed: boolean
}

export interface GrainSettings {
  amount: number
  size: number
  roughness: number
  seed: number
}

export interface BlackWhiteSettings {
  reds: number
  yellows: number
  greens: number
  cyans: number
  blues: number
  magentas: number
  tint: boolean
  tintHue: number
  tintSaturation: number
}

export interface ColorBalanceSettings {
  shadowCyanRed: number
  shadowMagentaGreen: number
  shadowYellowBlue: number
  midCyanRed: number
  midMagentaGreen: number
  midYellowBlue: number
  highlightCyanRed: number
  highlightMagentaGreen: number
  highlightYellowBlue: number
  preserveLuminosity: boolean
}

export interface Adjustment {
  kind: AdjustmentKind
  hue: number
  saturation: number
  lightness: number
  colorize: boolean
  levels: LevelsSettings
  curves: CurvesSettings
  exposureSettings?: ExposureSettings
  gradientMapSettings?: GradientMapSettings
  grainSettings?: GrainSettings
  blackWhiteSettings?: BlackWhiteSettings
  colorBalanceSettings?: ColorBalanceSettings
  blurRadius?: number
  motionAngle?: number
  motionDistance?: number
  noiseAmount?: number
  noiseGaussian?: boolean
  noiseMonochromatic?: boolean
  noiseSeed?: number
  [key: string]: unknown
}

export const TEXT_ALIGNMENTS = ['Left', 'Center', 'Right'] as const
export type TextAlignment = (typeof TEXT_ALIGNMENTS)[number]

export interface TextColorRun extends RGB {
  location: number
  length: number
}

export interface TextFontRun {
  location: number
  length: number
  fontName: string
}

export interface TextStyle extends RGB {
  content: string
  /** PostScript name; a missing face falls back to the system font. */
  fontName: string
  fontSize: number
  alignment: TextAlignment
  tracking: number
  leading: number
  /** Paragraph bounds the text wraps in, in layer pixels. */
  boxSize?: Vec2
  colorRuns?: TextColorRun[]
  fontRuns?: TextFontRun[]
  [key: string]: unknown
}

export const SHAPE_KINDS = ['Rectangle', 'Ellipse', 'Line'] as const
export type ShapeKind = (typeof SHAPE_KINDS)[number]

export interface ShapeStyle extends RGB {
  kind: ShapeKind
  cornerRadius: number
  lineWidth?: number
  /** For lines: the ends as fractions of the layer box. */
  start?: Vec2
  end?: Vec2
  [key: string]: unknown
}

export interface StrokeEffect extends RGB {
  enabled?: boolean
  size: number
  opacity: number
  inside: boolean
}

export interface ShadowEffect extends RGB {
  enabled?: boolean
  angle: number
  distance: number
  blur: number
  opacity: number
}

export interface ColorOverlayEffect extends RGB {
  enabled?: boolean
  opacity: number
}

export interface GlowEffect extends RGB {
  enabled?: boolean
  size: number
  opacity: number
}

export interface LayerEffects {
  stroke?: StrokeEffect
  shadow?: ShadowEffect
  colorOverlay?: ColorOverlayEffect
  innerShadow?: ShadowEffect
  outerGlow?: GlowEffect
  innerGlow?: GlowEffect
  [key: string]: unknown
}

export const EFFECT_KINDS = ['stroke', 'shadow', 'colorOverlay', 'innerShadow', 'outerGlow', 'innerGlow'] as const
export type EffectKind = (typeof EFFECT_KINDS)[number]

export interface LayerRecord {
  id: string
  name: string
  isVisible: boolean
  transform: LayerTransform
  imageFile?: string
  parentID?: string
  isGroup?: boolean
  opacity?: number
  blendMode?: BlendMode
  maskFile?: string
  maskEnabled?: boolean
  /** A clipping mask: the layer whose coverage multiplies this one's. */
  maskSourceID?: string
  /** An unlinked mask keeps its own document-space placement. */
  maskPlacement?: LayerTransform
  maskLinked?: boolean
  adjustment?: Adjustment
  /** An adjustment only Veritas Canvas has; `adjustment` then holds its stand-in. A kind from a newer Veritas is kept as it was. */
  heraldAdjustment?: HeraldAdjustment
  text?: TextStyle
  shape?: ShapeStyle
  effects?: LayerEffects
  [key: string]: unknown
}

export interface Guide {
  id: string
  axis: 'horizontal' | 'vertical'
  position: number
}

export interface CompManifest {
  format: string
  version: number
  colorSpace: string
  resolution: number
  documentID: string
  width: number
  height: number
  activeLayerID: string | null
  /** Bottom to top; a folder's children refer to it with `parentID`. */
  layers: LayerRecord[]
  guides: Guide[]
  [key: string]: unknown
}

export class CompFormatError extends Error {
  constructor(
    message: string,
    readonly field?: string
  ) {
    super(message)
    this.name = 'CompFormatError'
  }
}

const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i

export function newId(): string {
  return crypto.randomUUID().toUpperCase()
}

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)
export const imageFileFor = (id: string): string => `${id.toUpperCase()}.png`
export const maskFileFor = (id: string): string => `${id.toUpperCase()}.mask.png`
/** A Color Lookup layer's table; Compositor reads only the images layers name, so it passes this file by. */
export const tableFileFor = (id: string): string => `${id.toUpperCase()}.cube`

export const identityRange = (): LevelRange => ({ black: 0, gamma: 1, white: 255, outputBlack: 0, outputWhite: 255 })
export const identityLevels = (): LevelsSettings => ({ channel: 'RGB', ranges: [identityRange(), identityRange(), identityRange(), identityRange()] })
const identityCurve = (): CurvePoint[] => [
  { x: 0, y: 0 },
  { x: 255, y: 255 }
]
export const identityCurves = (): CurvesSettings => ({ channel: 'RGB', channels: [identityCurve(), identityCurve(), identityCurve(), identityCurve()] })

export const defaultTransform = (width: number, height: number, x = 0, y = 0): LayerTransform => ({ origin: [x, y], size: [width, height], rotation: 0, flipX: false, flipY: false, sampling: 'High quality' })

/** Settings each adjustment kind starts with: an identity change until the person edits it. */
export function defaultAdjustment(kind: AdjustmentKind): Adjustment {
  const adjustment: Adjustment = { kind, hue: 0, saturation: 0, lightness: 0, colorize: false, levels: identityLevels(), curves: identityCurves() }

  switch (kind) {
    case 'Exposure':
      adjustment.exposureSettings = { exposure: 0, offset: 0, gamma: 1 }
      break
    case 'Gradient Map':
      adjustment.gradientMapSettings = { shadows: { red: 0, green: 0, blue: 0 }, highlights: { red: 1, green: 1, blue: 1 }, reversed: false }
      break
    case 'Grain':
      adjustment.grainSettings = { amount: 25, size: 1.5, roughness: 50, seed: 0 }
      break
    case 'Black & White':
      adjustment.blackWhiteSettings = { reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: false, tintHue: 40, tintSaturation: 20 }
      break
    case 'Color Balance':
      adjustment.colorBalanceSettings = {
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
      }
      break
    case 'Gaussian Blur':
      adjustment.blurRadius = 8
      break
    case 'Motion Blur':
      adjustment.motionAngle = 0
      adjustment.motionDistance = 20
      break
    case 'Add Noise':
      adjustment.noiseAmount = 10
      adjustment.noiseGaussian = false
      adjustment.noiseMonochromatic = true
      adjustment.noiseSeed = 0
      break
  }

  return adjustment
}

const noInks = (): Inks => ({ cyan: 0, magenta: 0, yellow: 0, black: 0 })

/** Settings each Veritas-only kind starts with: no change, except a Photo Filter's warming tint. */
export function defaultHeraldAdjustment(kind: HeraldAdjustmentKind): HeraldAdjustment {
  switch (kind) {
    case 'Brightness/Contrast':
      return { kind, brightness: 0, contrast: 0 }
    case 'Vibrance':
      return { kind, vibrance: 0, saturation: 0 }
    case 'Photo Filter':
      return { kind, color: { red: 0.925, green: 0.541, blue: 0 }, density: 25, preserveLuminosity: true }
    case 'Channel Mixer':
      return {
        kind,
        monochrome: false,
        red: { red: 100, green: 0, blue: 0, constant: 0 },
        green: { red: 0, green: 100, blue: 0, constant: 0 },
        blue: { red: 0, green: 0, blue: 100, constant: 0 },
        gray: { red: 40, green: 40, blue: 20, constant: 0 }
      }
    case 'Selective Color':
      return { kind, absolute: false, ...(Object.fromEntries(SELECTIVE_RANGES.map((range) => [range, noInks()])) as Record<SelectiveRange, Inks>) }
    case 'Posterize':
      return { kind, levels: 4 }
    case 'Threshold':
      return { kind, level: 128 }
    case 'Color Lookup':
      return { kind, name: '', size: 0 }
  }
}

export const defaultEffect = {
  stroke: (): StrokeEffect => ({ size: 4, red: 0, green: 0, blue: 0, opacity: 1, inside: false }),
  shadow: (): ShadowEffect => ({ angle: 90, distance: 20, blur: 20, red: 0, green: 0, blue: 0, opacity: 0.5 }),
  colorOverlay: (): ColorOverlayEffect => ({ red: 1, green: 0, blue: 0, opacity: 1 }),
  innerShadow: (): ShadowEffect => ({ angle: 90, distance: 10, blur: 10, red: 0, green: 0, blue: 0, opacity: 0.5 }),
  outerGlow: (): GlowEffect => ({ size: 20, red: 1, green: 1, blue: 1, opacity: 0.75 }),
  innerGlow: (): GlowEffect => ({ size: 10, red: 1, green: 1, blue: 1, opacity: 0.75 })
} satisfies Record<EffectKind, () => unknown>

export function newManifest(width: number, height: number, resolution = 72): CompManifest {
  return { format: FORMAT_ID, version: FORMAT_VERSION, colorSpace: 'sRGB', resolution, documentID: newId(), width, height, activeLayerID: null, layers: [], guides: [] }
}

// ---------------------------------------------------------------------------------------------
// Reading.

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

function fail(message: string, field?: string): never {
  throw new CompFormatError(message, field)
}

function finite(value: unknown, field: string, min = -Infinity, max = Infinity, fallback?: number): number {
  if (value === undefined && fallback !== undefined) {
    return fallback
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(`${field} must be a number from ${min} to ${max}${typeof value === 'number' ? ` (it was ${value})` : ''}`, field)
  }

  return value
}

/** A number within one of Compositor's ranges. */
const ranged = (value: unknown, field: string, range: RangeName, fallback?: number): number => finite(value, field, RANGES[range][0], RANGES[range][1], fallback)

function integer(value: unknown, field: string, min: number, max: number): number {
  const number = finite(value, field, min, max)

  if (!Number.isInteger(number)) {
    fail(`${field} must be a whole number`, field)
  }

  return number
}

function bool(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback
  }

  if (typeof value !== 'boolean') {
    fail(`${field} must be true or false`, field)
  }

  return value
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string, fallback?: T): T {
  if (value === undefined && fallback !== undefined) {
    return fallback
  }

  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail(`${field} must be one of: ${allowed.join(', ')}`, field)
  }

  return value as T
}

function vec2(value: unknown, field: string, min = -1_000_000, max = 1_000_000): Vec2 {
  if (!Array.isArray(value) || value.length !== 2) {
    fail(`${field} must be a pair of numbers`, field)
  }

  return [finite(value[0], `${field}[0]`, min, max), finite(value[1], `${field}[1]`, min, max)]
}

function rgb(value: Json, field: string, fallback?: RGB): RGB {
  return {
    red: ranged(value.red, `${field}.red`, 'colour', fallback?.red),
    green: ranged(value.green, `${field}.green`, 'colour', fallback?.green),
    blue: ranged(value.blue, `${field}.blue`, 'colour', fallback?.blue)
  }
}

export function parseTransform(value: unknown, field: string): LayerTransform {
  if (!isObject(value)) {
    fail(`${field} is missing`, field)
  }

  return {
    ...value,
    origin: vec2(value.origin, `${field}.origin`, ...RANGES.position),
    size: vec2(value.size, `${field}.size`, ...RANGES.layerSize),
    rotation: finite(value.rotation, `${field}.rotation`, -1_000_000, 1_000_000, 0),
    flipX: bool(value.flipX, `${field}.flipX`, false),
    flipY: bool(value.flipY, `${field}.flipY`, false),
    sampling: oneOf(value.sampling, SAMPLING, `${field}.sampling`, 'High quality')
  }
}

function parseLevels(value: unknown, field: string): LevelsSettings {
  if (value === undefined) {
    return identityLevels()
  }

  if (!isObject(value) || !Array.isArray(value.ranges) || value.ranges.length !== 4) {
    fail(`${field} needs four channel ranges`, field)
  }

  const ranges = value.ranges.map((range: unknown, i: number) => {
    const at = `${field}.ranges[${i}]`

    if (!isObject(range)) {
      fail(`${at} is not a range`, at)
    }

    const black = ranged(range.black, `${at}.black`, 'levelsBlack', 0)
    const white = ranged(range.white, `${at}.white`, 'levelsWhite', 255)

    if (white <= black) {
      fail(`${at}.white (${white}) must be above ${at}.black (${black}), up to 255`, `${at}.white`)
    }

    return {
      black,
      gamma: ranged(range.gamma, `${at}.gamma`, 'levelsGamma', 1),
      white,
      outputBlack: ranged(range.outputBlack, `${at}.outputBlack`, 'levelsOutput', 0),
      outputWhite: ranged(range.outputWhite, `${at}.outputWhite`, 'levelsOutput', 255)
    }
  }) as LevelsSettings['ranges']

  return { channel: oneOf(value.channel, CHANNELS, `${field}.channel`, 'RGB'), ranges }
}

function parseCurves(value: unknown, field: string): CurvesSettings {
  if (value === undefined) {
    return identityCurves()
  }

  if (!isObject(value) || !Array.isArray(value.channels) || value.channels.length !== 4) {
    fail(`${field} needs four channel curves`, field)
  }

  const channels = value.channels.map((points: unknown, i: number) => {
    const at = `${field}.channels[${i}]`
    const [fewest, most] = RANGES.curvePoints

    if (!Array.isArray(points) || points.length < fewest || points.length > most) {
      fail(`${at} needs ${fewest} to ${most} points`, at)
    }

    let lastX = -1

    const parsed = points.map((point: unknown, j: number) => {
      if (!isObject(point)) {
        fail(`${at}[${j}] is not a point`, at)
      }

      const x = ranged(point.x, `${at}[${j}].x`, 'curveValue')

      if (x <= lastX) {
        fail(`${at} points must run in increasing x`, at)
      }

      lastX = x

      return { x, y: ranged(point.y, `${at}[${j}].y`, 'curveValue') }
    })

    if (parsed[0].x !== 0 || parsed[parsed.length - 1].x !== 255) {
      fail(`${at} must start at x 0 and end at x 255`, at)
    }

    return parsed
  }) as CurvesSettings['channels']

  return { channel: oneOf(value.channel, CHANNELS, `${field}.channel`, 'RGB'), channels }
}

function parseAdjustment(value: unknown, field: string): Adjustment {
  if (!isObject(value)) {
    fail(`${field} is not an adjustment`, field)
  }

  const kind = oneOf(value.kind, ADJUSTMENT_KINDS, `${field}.kind`)
  const adjustment: Adjustment = {
    ...value,
    kind,
    hue: ranged(value.hue, `${field}.hue`, 'hue', 0),
    saturation: ranged(value.saturation, `${field}.saturation`, 'saturation', 0),
    lightness: ranged(value.lightness, `${field}.lightness`, 'lightness', 0),
    colorize: bool(value.colorize, `${field}.colorize`, false),
    levels: parseLevels(value.levels, `${field}.levels`),
    curves: parseCurves(value.curves, `${field}.curves`)
  }

  if (value.hsvSettings !== undefined) {
    checkHsvSettings(value.hsvSettings, `${field}.hsvSettings`)
  }

  if (isObject(value.exposureSettings)) {
    const at = `${field}.exposureSettings`
    adjustment.exposureSettings = {
      exposure: ranged(value.exposureSettings.exposure, `${at}.exposure`, 'exposure', 0),
      offset: ranged(value.exposureSettings.offset, `${at}.offset`, 'exposureOffset', 0),
      gamma: ranged(value.exposureSettings.gamma, `${at}.gamma`, 'exposureGamma', 1)
    }
  }

  if (isObject(value.gradientMapSettings)) {
    const at = `${field}.gradientMapSettings`
    const settings = value.gradientMapSettings
    adjustment.gradientMapSettings = {
      shadows: rgb(isObject(settings.shadows) ? settings.shadows : {}, `${at}.shadows`, { red: 0, green: 0, blue: 0 }),
      highlights: rgb(isObject(settings.highlights) ? settings.highlights : {}, `${at}.highlights`, { red: 1, green: 1, blue: 1 }),
      reversed: bool(settings.reversed, `${at}.reversed`, false)
    }
  }

  if (isObject(value.grainSettings)) {
    const at = `${field}.grainSettings`
    const settings = value.grainSettings
    adjustment.grainSettings = {
      amount: ranged(settings.amount, `${at}.amount`, 'grainAmount', 25),
      size: ranged(settings.size, `${at}.size`, 'grainSize', 1.5),
      roughness: ranged(settings.roughness, `${at}.roughness`, 'grainRoughness', 50),
      seed: integer(settings.seed ?? 0, `${at}.seed`, ...RANGES.seed)
    }
  }

  if (isObject(value.blackWhiteSettings)) {
    const at = `${field}.blackWhiteSettings`
    const settings = value.blackWhiteSettings
    const weight = (key: string, fallback: number) => ranged(settings[key], `${at}.${key}`, 'blackWhite', fallback)
    adjustment.blackWhiteSettings = {
      reds: weight('reds', 40),
      yellows: weight('yellows', 60),
      greens: weight('greens', 40),
      cyans: weight('cyans', 60),
      blues: weight('blues', 20),
      magentas: weight('magentas', 80),
      tint: bool(settings.tint, `${at}.tint`, false),
      tintHue: ranged(settings.tintHue, `${at}.tintHue`, 'tintHue', 40),
      tintSaturation: ranged(settings.tintSaturation, `${at}.tintSaturation`, 'tintSaturation', 20)
    }
  }

  if (isObject(value.colorBalanceSettings)) {
    const at = `${field}.colorBalanceSettings`
    const settings = value.colorBalanceSettings
    const shift = (key: string) => ranged(settings[key], `${at}.${key}`, 'colorBalance', 0)
    adjustment.colorBalanceSettings = {
      shadowCyanRed: shift('shadowCyanRed'),
      shadowMagentaGreen: shift('shadowMagentaGreen'),
      shadowYellowBlue: shift('shadowYellowBlue'),
      midCyanRed: shift('midCyanRed'),
      midMagentaGreen: shift('midMagentaGreen'),
      midYellowBlue: shift('midYellowBlue'),
      highlightCyanRed: shift('highlightCyanRed'),
      highlightMagentaGreen: shift('highlightMagentaGreen'),
      highlightYellowBlue: shift('highlightYellowBlue'),
      preserveLuminosity: bool(settings.preserveLuminosity, `${at}.preserveLuminosity`, true)
    }
  }

  if (value.blurRadius !== undefined) {
    adjustment.blurRadius = ranged(value.blurRadius, `${field}.blurRadius`, 'blurRadius')
  }

  if (value.motionAngle !== undefined) {
    adjustment.motionAngle = ranged(value.motionAngle, `${field}.motionAngle`, 'motionAngle')
  }

  if (value.motionDistance !== undefined) {
    adjustment.motionDistance = ranged(value.motionDistance, `${field}.motionDistance`, 'motionDistance')
  }

  if (value.noiseAmount !== undefined) {
    adjustment.noiseAmount = ranged(value.noiseAmount, `${field}.noiseAmount`, 'noiseAmount')
  }

  if (value.noiseGaussian !== undefined) {
    adjustment.noiseGaussian = bool(value.noiseGaussian, `${field}.noiseGaussian`, false)
  }

  if (value.noiseMonochromatic !== undefined) {
    adjustment.noiseMonochromatic = bool(value.noiseMonochromatic, `${field}.noiseMonochromatic`, false)
  }

  if (value.noiseSeed !== undefined) {
    adjustment.noiseSeed = integer(value.noiseSeed, `${field}.noiseSeed`, ...RANGES.seed)
  }

  return adjustment
}

type HeraldRangeName = keyof typeof HERALD_RANGES

/**
 * A Veritas-only adjustment's settings, held to Veritas's bounds with its defaults filled in. A kind
 * this version does not know (from a newer Veritas Canvas) is kept as it was: the layer then shows
 * its stand-in, as Compositor does.
 */
function parseHeraldAdjustment(value: unknown, field: string): HeraldAdjustment {
  if (!isObject(value) || typeof value.kind !== 'string' || !value.kind) {
    fail(`${field} is not a Veritas Canvas adjustment`, field)
  }

  if (!isHeraldKind(value.kind)) {
    return value as unknown as HeraldAdjustment
  }

  const kind = value.kind
  const number = (record: Json, key: string, at: string, range: HeraldRangeName, fallback: number) => finite(record[key], `${at}.${key}`, HERALD_RANGES[range][0], HERALD_RANGES[range][1], fallback)
  const part = (key: string): Json => (isObject(value[key]) ? value[key] : {})

  switch (kind) {
    case 'Brightness/Contrast':
      return { ...value, kind, brightness: number(value, 'brightness', field, 'brightness', 0), contrast: number(value, 'contrast', field, 'contrast', 0) }
    case 'Vibrance':
      return { ...value, kind, vibrance: number(value, 'vibrance', field, 'vibrance', 0), saturation: number(value, 'saturation', field, 'saturation', 0) }
    case 'Photo Filter': {
      const defaults = defaultHeraldAdjustment(kind) as PhotoFilterSettings

      return {
        ...value,
        kind,
        color: rgb(part('color'), `${field}.color`, defaults.color),
        density: number(value, 'density', field, 'density', defaults.density),
        preserveLuminosity: bool(value.preserveLuminosity, `${field}.preserveLuminosity`, true)
      }
    }
    case 'Channel Mixer': {
      const defaults = defaultHeraldAdjustment(kind) as ChannelMixerSettings
      const row = (key: 'red' | 'green' | 'blue' | 'gray'): MixerRow => {
        const at = `${field}.${key}`
        const entry = part(key)

        return {
          red: number(entry, 'red', at, 'mixer', defaults[key].red),
          green: number(entry, 'green', at, 'mixer', defaults[key].green),
          blue: number(entry, 'blue', at, 'mixer', defaults[key].blue),
          constant: number(entry, 'constant', at, 'mixer', defaults[key].constant)
        }
      }

      return { ...value, kind, monochrome: bool(value.monochrome, `${field}.monochrome`, false), red: row('red'), green: row('green'), blue: row('blue'), gray: row('gray') }
    }
    case 'Selective Color': {
      const inks = (range: SelectiveRange): Inks => {
        const at = `${field}.${range}`
        const entry = part(range)

        return { cyan: number(entry, 'cyan', at, 'inks', 0), magenta: number(entry, 'magenta', at, 'inks', 0), yellow: number(entry, 'yellow', at, 'inks', 0), black: number(entry, 'black', at, 'inks', 0) }
      }

      return { ...value, kind, absolute: bool(value.absolute, `${field}.absolute`, false), ...(Object.fromEntries(SELECTIVE_RANGES.map((range) => [range, inks(range)])) as Record<SelectiveRange, Inks>) }
    }
    case 'Posterize':
      return { ...value, kind, levels: integer(value.levels ?? 4, `${field}.levels`, ...HERALD_RANGES.posterize) }
    case 'Threshold':
      return { ...value, kind, level: integer(value.level ?? 128, `${field}.level`, ...HERALD_RANGES.threshold) }
    case 'Color Lookup': {
      const size = integer(value.size ?? 0, `${field}.size`, 0, HERALD_RANGES.tableSize[1])

      if (size > 0 && size < HERALD_RANGES.tableSize[0]) {
        fail(`${field}.size must be 0 (no table) or from ${HERALD_RANGES.tableSize[0]} to ${HERALD_RANGES.tableSize[1]}`, `${field}.size`)
      }

      return { ...value, kind, name: typeof value.name === 'string' ? value.name : '', size }
    }
  }
}

/**
 * Compositor's own Hue/Saturation record (a setting per colour range, kept as it was): its ranges'
 * values are held to the same bounds, since it refuses the project over them too. Its dictionaries
 * are stored as lists of keys and values in turn.
 */
function checkHsvSettings(value: unknown, field: string): void {
  if (!isObject(value)) {
    return
  }

  const entries = (list: unknown): Json[] => (Array.isArray(list) ? list.filter(isObject) : isObject(list) ? Object.values(list).filter(isObject) : [])

  entries(value.adjustments).forEach((entry, i) => {
    const at = `${field}.adjustments[${i}]`
    ranged(entry.hue, `${at}.hue`, 'hue', 0)
    ranged(entry.saturation, `${at}.saturation`, 'saturation', 0)
    ranged(entry.lightness, `${at}.lightness`, 'lightness', 0)
  })

  entries(value.bands).forEach((band, i) => {
    for (const key of ['falloffStart', 'rangeStart', 'rangeEnd', 'falloffEnd']) {
      if (band[key] !== undefined) {
        finite(band[key], `${field}.bands[${i}].${key}`)
      }
    }
  })
}

function parseRuns<T>(value: unknown, field: string, length: number, item: (run: Json, at: string) => T): (T & { location: number; length: number })[] | undefined {
  if (value === undefined) {
    return undefined
  }

  if (!Array.isArray(value)) {
    fail(`${field} must be a list`, field)
  }

  let end = 0

  return value.map((run: unknown, i: number) => {
    const at = `${field}[${i}]`

    if (!isObject(run)) {
      fail(`${at} is not a run`, at)
    }

    const location = integer(run.location, `${at}.location`, 0, length)
    const span = integer(run.length, `${at}.length`, 1, length)

    if (location < end || location + span > length) {
      fail(`${field} runs must be sorted, not overlap and end within the text`, field)
    }

    end = location + span

    return { ...item(run, at), location, length: span }
  })
}

function parseText(value: unknown, field: string): TextStyle {
  if (!isObject(value)) {
    fail(`${field} is not text`, field)
  }

  const content = typeof value.content === 'string' ? value.content : fail(`${field}.content must be text`, field)
  const units = content.length

  if (units > LIMITS_TEXT.content) {
    fail(`${field}.content holds at most ${LIMITS_TEXT.content.toLocaleString('en')} characters`, `${field}.content`)
  }

  const text: TextStyle = {
    ...value,
    content,
    fontName: typeof value.fontName === 'string' && value.fontName ? value.fontName : 'Helvetica',
    fontSize: ranged(value.fontSize, `${field}.fontSize`, 'fontSize', 72),
    ...rgb(value, field, { red: 0, green: 0, blue: 0 }),
    alignment: oneOf(value.alignment, TEXT_ALIGNMENTS, `${field}.alignment`, 'Left'),
    tracking: ranged(value.tracking, `${field}.tracking`, 'tracking', 0),
    leading: ranged(value.leading, `${field}.leading`, 'leading', 0)
  }

  if (value.boxSize !== undefined) {
    const box = vec2(value.boxSize, `${field}.boxSize`, ...RANGES.textBox)

    if (box[0] * box[1] > LIMITS_TEXT.boxArea) {
      fail(`${field}.boxSize covers at most ${LIMITS_TEXT.boxArea.toLocaleString('en')} pixels`, `${field}.boxSize`)
    }

    text.boxSize = box
  }

  // An empty list of runs is no runs at all (a strict reader refuses an empty one).
  const colorRuns = value.colorRuns !== undefined ? parseRuns(value.colorRuns, `${field}.colorRuns`, units, (run, at) => rgb(run, at)) : undefined
  const fontRuns =
    value.fontRuns !== undefined
      ? parseRuns(value.fontRuns, `${field}.fontRuns`, units, (run, at) => {
          const name = run.fontName

          if (typeof name !== 'string' || !name || name.length > LIMITS_TEXT.fontName || /[\n\r\u2028\u2029]/.test(name)) {
            fail(`${at}.fontName must be a font name of 1 to ${LIMITS_TEXT.fontName} characters on one line`, at)
          }

          return { fontName: name }
        })
      : undefined

  for (const [key, runs] of [
    ['colorRuns', colorRuns],
    ['fontRuns', fontRuns]
  ] as const) {
    if (runs?.length) {
      ;(text as Record<string, unknown>)[key] = runs
    } else {
      delete text[key]
    }
  }

  return text
}

function parseShape(value: unknown, field: string): ShapeStyle {
  if (!isObject(value)) {
    fail(`${field} is not a shape`, field)
  }

  return {
    ...value,
    kind: oneOf(value.kind, SHAPE_KINDS, `${field}.kind`),
    ...rgb(value, field, { red: 0, green: 0, blue: 0 }),
    cornerRadius: finite(value.cornerRadius, `${field}.cornerRadius`, 0, 1_000_000, 0),
    ...(value.lineWidth !== undefined ? { lineWidth: finite(value.lineWidth, `${field}.lineWidth`, 0, 1_000_000) } : {}),
    ...(value.start !== undefined ? { start: vec2(value.start, `${field}.start`, -1000, 1000) } : {}),
    ...(value.end !== undefined ? { end: vec2(value.end, `${field}.end`, -1000, 1000) } : {})
  }
}

function parseEffects(value: unknown, field: string): LayerEffects {
  if (!isObject(value)) {
    fail(`${field} is not a set of effects`, field)
  }

  const effects: LayerEffects = { ...value }
  const enabled = (record: Json, at: string) => (record.enabled === undefined ? {} : { enabled: bool(record.enabled, `${at}.enabled`, true) })
  const shadow = (record: Json, at: string, defaults: ShadowEffect): ShadowEffect => ({
    ...enabled(record, at),
    angle: ranged(record.angle, `${at}.angle`, 'shadowAngle', defaults.angle),
    distance: ranged(record.distance, `${at}.distance`, 'shadowDistance', defaults.distance),
    blur: ranged(record.blur, `${at}.blur`, 'shadowBlur', defaults.blur),
    ...rgb(record, at, defaults),
    opacity: ranged(record.opacity, `${at}.opacity`, 'opacity', defaults.opacity)
  })
  const glow = (record: Json, at: string, defaults: GlowEffect): GlowEffect => ({
    ...enabled(record, at),
    size: ranged(record.size, `${at}.size`, 'glowSize', defaults.size),
    ...rgb(record, at, defaults),
    opacity: ranged(record.opacity, `${at}.opacity`, 'opacity', defaults.opacity)
  })

  if (isObject(value.stroke)) {
    const at = `${field}.stroke`
    const defaults = defaultEffect.stroke()
    effects.stroke = {
      ...enabled(value.stroke, at),
      size: ranged(value.stroke.size, `${at}.size`, 'strokeSize', defaults.size),
      ...rgb(value.stroke, at, defaults),
      opacity: ranged(value.stroke.opacity, `${at}.opacity`, 'opacity', defaults.opacity),
      inside: bool(value.stroke.inside, `${at}.inside`, defaults.inside)
    }
  }

  if (isObject(value.shadow)) {
    effects.shadow = shadow(value.shadow, `${field}.shadow`, defaultEffect.shadow())
  }

  if (isObject(value.innerShadow)) {
    effects.innerShadow = shadow(value.innerShadow, `${field}.innerShadow`, defaultEffect.innerShadow())
  }

  if (isObject(value.colorOverlay)) {
    const at = `${field}.colorOverlay`
    const defaults = defaultEffect.colorOverlay()
    effects.colorOverlay = { ...enabled(value.colorOverlay, at), ...rgb(value.colorOverlay, at, defaults), opacity: ranged(value.colorOverlay.opacity, `${at}.opacity`, 'opacity', defaults.opacity) }
  }

  if (isObject(value.outerGlow)) {
    effects.outerGlow = glow(value.outerGlow, `${field}.outerGlow`, defaultEffect.outerGlow())
  }

  if (isObject(value.innerGlow)) {
    effects.innerGlow = glow(value.innerGlow, `${field}.innerGlow`, defaultEffect.innerGlow())
  }

  return effects
}

/** A layer's name: a blank one becomes "Layer" (a strict reader refuses blank names), a very long one is refused. */
function layerName(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    return 'Layer'
  }

  if (new TextEncoder().encode(value).length > LIMITS_TEXT.layerName) {
    fail(`${field} is longer than ${LIMITS_TEXT.layerName.toLocaleString('en')} bytes`, field)
  }

  return value
}

function parseLayer(value: unknown, index: number): LayerRecord {
  const field = `layers[${index}]`

  if (!isObject(value)) {
    fail(`${field} is not a layer`, field)
  }

  if (!isUuid(value.id)) {
    fail(`${field}.id must be a UUID`, `${field}.id`)
  }

  const id = value.id.toUpperCase()
  const isGroup = bool(value.isGroup, `${field}.isGroup`, false)
  const layer: LayerRecord = {
    ...value,
    id,
    name: layerName(value.name, `${field}.name`),
    isVisible: bool(value.isVisible, `${field}.isVisible`, true),
    transform: parseTransform(value.transform, `${field}.transform`),
    isGroup,
    opacity: ranged(value.opacity, `${field}.opacity`, 'opacity', 1),
    blendMode: isGroup ? 'Normal' : oneOf(value.blendMode, BLEND_MODES, `${field}.blendMode`, 'Normal')
  }

  if (value.imageFile !== undefined && value.imageFile !== null) {
    if (isGroup || value.adjustment !== undefined) {
      fail(`${field} is a folder or an adjustment, so it cannot have an image`, `${field}.imageFile`)
    }

    if (value.imageFile !== imageFileFor(id)) {
      fail(`${field}.imageFile must be ${imageFileFor(id)}`, `${field}.imageFile`)
    }

    layer.imageFile = imageFileFor(id)
  } else {
    delete layer.imageFile
  }

  if (value.parentID !== undefined && value.parentID !== null) {
    if (!isUuid(value.parentID)) {
      fail(`${field}.parentID must be a UUID`, `${field}.parentID`)
    }

    layer.parentID = value.parentID.toUpperCase()
  } else {
    delete layer.parentID
  }

  if (value.maskFile !== undefined && value.maskFile !== null) {
    if (value.maskFile !== maskFileFor(id)) {
      fail(`${field}.maskFile must be ${maskFileFor(id)}`, `${field}.maskFile`)
    }

    layer.maskFile = maskFileFor(id)
    layer.maskEnabled = bool(value.maskEnabled, `${field}.maskEnabled`, true)

    if (value.maskLinked !== undefined) {
      layer.maskLinked = bool(value.maskLinked, `${field}.maskLinked`, true)
    }

    if (value.maskPlacement !== undefined) {
      layer.maskPlacement = parseTransform(value.maskPlacement, `${field}.maskPlacement`)
    }
  } else {
    for (const key of ['maskFile', 'maskEnabled', 'maskLinked', 'maskPlacement']) {
      delete layer[key]
    }
  }

  if (value.maskSourceID !== undefined && value.maskSourceID !== null) {
    if (!isUuid(value.maskSourceID)) {
      fail(`${field}.maskSourceID must be a UUID`, `${field}.maskSourceID`)
    }

    layer.maskSourceID = value.maskSourceID.toUpperCase()
  } else {
    delete layer.maskSourceID
  }

  if (value.adjustment !== undefined && value.adjustment !== null) {
    if (isGroup || value.text !== undefined) {
      fail(`${field} cannot be both an adjustment and a folder or text`, `${field}.adjustment`)
    }

    layer.adjustment = parseAdjustment(value.adjustment, `${field}.adjustment`)
  } else {
    delete layer.adjustment
  }

  if (value.heraldAdjustment !== undefined && value.heraldAdjustment !== null) {
    if (!layer.adjustment) {
      fail(`${field} has Veritas Canvas adjustment settings but is not an adjustment layer`, `${field}.heraldAdjustment`)
    }

    layer.heraldAdjustment = parseHeraldAdjustment(value.heraldAdjustment, `${field}.heraldAdjustment`)
  } else {
    delete layer.heraldAdjustment
  }

  if (value.text !== undefined && value.text !== null) {
    layer.text = parseText(value.text, `${field}.text`)
  } else {
    delete layer.text
  }

  if (value.shape !== undefined && value.shape !== null) {
    layer.shape = parseShape(value.shape, `${field}.shape`)
  } else {
    delete layer.shape
  }

  if (value.effects !== undefined && value.effects !== null) {
    layer.effects = parseEffects(value.effects, `${field}.effects`)
  } else {
    delete layer.effects
  }

  return layer
}

/** An adjustment record checked as strictly as a project file's, with its defaults filled in. */
export const checkAdjustment = (value: unknown): Adjustment => parseAdjustment(value, 'adjustment')

/** Veritas-only adjustment settings checked as strictly as a project file's, with their defaults filled in. */
export const checkHeraldAdjustment = (value: unknown): HeraldAdjustment => parseHeraldAdjustment(value, 'heraldAdjustment')

/** A layer's effects checked as strictly as a project file's, with each effect's defaults filled in. */
export const checkEffects = (value: unknown): LayerEffects => parseEffects(value, 'effects')

/** Folder structure: every parent exists and is a folder, there are no loops, and nesting stays shallow enough. */
function checkTree(layers: LayerRecord[]): void {
  const byId = new Map(layers.map(layer => [layer.id, layer]))

  for (const layer of layers) {
    let depth = 0
    let parent = layer.parentID

    while (parent) {
      const node = byId.get(parent)

      if (!node || !node.isGroup) {
        fail(`${layer.name || layer.id} sits in a folder that does not exist`, 'parentID')
      }

      if (parent === layer.id || ++depth > LIMITS.depth) {
        fail('Folders nest in a loop or too deeply', 'parentID')
      }

      parent = node.parentID
    }
  }
}

/** Clipping links go from a layer (not a folder) to one with pixels (not a folder or an adjustment), never to itself, and never in a loop. */
function checkClipping(layers: LayerRecord[]): void {
  const byId = new Map(layers.map(layer => [layer.id, layer]))

  for (const layer of layers) {
    if (layer.maskSourceID && layer.isGroup) {
      fail(`${layer.name || layer.id} is a folder, and a folder cannot be clipped`, 'maskSourceID')
    }

    let source = layer.maskSourceID
    let steps = 0

    while (source) {
      const node = byId.get(source)

      if (!node || node.isGroup || node.adjustment) {
        fail(`${layer.name || layer.id} is clipped to a layer that cannot clip it (a missing layer, a folder or an adjustment layer)`, 'maskSourceID')
      }

      if (source === layer.id || ++steps > LIMITS.clipChain) {
        fail('Clipping masks link in a loop', 'maskSourceID')
      }

      source = node.maskSourceID
    }
  }
}

/** A manifest as stored, checked as strictly as a reader of the format checks it, with defaults filled in. */
export function parseManifest(value: unknown): CompManifest {
  if (!isObject(value)) {
    fail('manifest.json is not a JSON object')
  }

  if (value.format !== FORMAT_ID) {
    fail('This is not a Veritas Canvas or Compositor project', 'format')
  }

  const version = integer(value.version, 'version', 1, 1_000)

  if (version > FORMAT_VERSION) {
    fail(`This project was saved by a newer app (format ${version}); this version opens up to ${FORMAT_VERSION}`, 'version')
  }

  if (value.colorSpace !== undefined && value.colorSpace !== 'sRGB') {
    fail('Only sRGB projects are supported', 'colorSpace')
  }

  if (!isUuid(value.documentID)) {
    fail('documentID must be a UUID', 'documentID')
  }

  if (!Array.isArray(value.layers) || value.layers.length > LIMITS.layers) {
    fail(`layers must be a list of up to ${LIMITS.layers}`, 'layers')
  }

  const layers = value.layers.map(parseLayer)
  const ids = new Set<string>()

  for (const layer of layers) {
    if (ids.has(layer.id)) {
      fail(`Two layers share the id ${layer.id}`, 'layers')
    }

    ids.add(layer.id)
  }

  checkTree(layers)
  checkClipping(layers)

  const guides = value.guides === undefined ? [] : value.guides

  if (!Array.isArray(guides) || guides.length > LIMITS.guides) {
    fail(`guides must be a list of up to ${LIMITS.guides}`, 'guides')
  }

  const active = value.activeLayerID
  const guideIds = new Set<string>()

  return {
    ...value,
    format: FORMAT_ID,
    version,
    colorSpace: 'sRGB',
    resolution: finite(value.resolution, 'resolution', 1, 9600, 72),
    documentID: value.documentID.toUpperCase(),
    width: integer(value.width, 'width', 1, LIMITS.side),
    height: integer(value.height, 'height', 1, LIMITS.side),
    activeLayerID: isUuid(active) && ids.has(active.toUpperCase()) ? active.toUpperCase() : null,
    layers,
    guides: guides.map((guide: unknown, i: number) => {
      const at = `guides[${i}]`

      if (!isObject(guide) || !isUuid(guide.id)) {
        fail(`${at} needs a UUID`, at)
      }

      const id = guide.id.toUpperCase()

      if (guideIds.has(id)) {
        fail(`Two guides share the id ${id}`, at)
      }

      guideIds.add(id)

      return { id, axis: oneOf(guide.axis, ['horizontal', 'vertical'] as const, `${at}.axis`), position: ranged(guide.position, `${at}.position`, 'position') }
    })
  }
}

/** Parse manifest.json text, rejecting files too large to be a real manifest. */
export function parseManifestText(text: string): CompManifest {
  if (text.length > LIMITS.manifestBytes) {
    fail('manifest.json is too large')
  }

  let json: unknown

  try {
    json = JSON.parse(text)
  } catch {
    fail('manifest.json is not valid JSON')
  }

  return parseManifest(json)
}

// ---------------------------------------------------------------------------------------------
// Writing.

/** The files a manifest refers to: what must be in `images/`, and nothing more. */
export function referencedAssets(manifest: CompManifest): Set<string> {
  const files = new Set<string>()

  for (const layer of manifest.layers) {
    if (layer.imageFile) {
      files.add(layer.imageFile)
    }

    if (layer.maskFile) {
      files.add(layer.maskFile)
    }

    if (layer.heraldAdjustment?.kind === 'Color Lookup' && (layer.heraldAdjustment as ColorLookupSettings).size > 0) {
      files.add(tableFileFor(layer.id))
    }
  }

  return files
}

/** manifest.json text, always at the current format version. */
export function serializeManifest(manifest: CompManifest): string {
  // Re-parse first: a manifest that would not load again is never written.
  const checked = parseManifest({ ...manifest, version: FORMAT_VERSION })

  return `${JSON.stringify(checked, null, 2)}\n`
}

/** Siblings in stacking order, with each folder's children right after it (bottom to top). */
export function orderLayers<T extends LayerRecord>(layers: readonly T[]): T[] {
  const children = new Map<string | undefined, T[]>()

  for (const layer of layers) {
    const key = layer.parentID
    children.set(key, [...(children.get(key) ?? []), layer])
  }

  const ordered: T[] = []
  const visit = (parent: string | undefined) => {
    for (const layer of children.get(parent) ?? []) {
      ordered.push(layer)

      if (layer.isGroup) {
        visit(layer.id)
      }
    }
  }
  visit(undefined)

  return ordered
}
