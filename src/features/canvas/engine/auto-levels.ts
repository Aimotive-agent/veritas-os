/*
 * Auto Tone, Auto Contrast and Auto Color: Levels settings worked out from a picture's histogram,
 * so the fix lands as an adjustment layer that stays editable.
 *
 * - Auto Contrast stretches all three channels by the same amount: the darkest and lightest values
 *   of the pooled histogram (past a small clipped share) go to black and white, so colours keep
 *   their balance.
 * - Auto Tone stretches each channel on its own, which also takes out a colour cast that sits in
 *   one channel's ends.
 * - Auto Color finds the average of the darkest and of the lightest pixels (by brightness, past the
 *   clipped share) and maps them to black and white, channel by channel, then bends each channel's
 *   midtone so the near-gray midtones come out neutral.
 */

import { identityLevels, identityRange, type LevelRange, type LevelsSettings } from '../../../../shared/canvas/comp-format.ts'

export const AUTO_MODES = ['tone', 'contrast', 'color'] as const
export type AutoMode = (typeof AUTO_MODES)[number]

export const AUTO_LABELS: Record<AutoMode, string> = { tone: 'Auto Tone', contrast: 'Auto Contrast', color: 'Auto Color' }

/** The share of the darkest and of the lightest pixels ignored, as photo editors clip by default (0.1%). */
export const DEFAULT_CLIP = 0.001

/** Pixels more transparent than this are left out of the histogram. */
const MIN_ALPHA = 128

export interface Histograms {
  red: Float64Array
  green: Float64Array
  blue: Float64Array
  /** Rec. 709 brightness, rounded to 0…255. */
  luma: Float64Array
  /** Pixels counted. */
  count: number
}

const lumaOf = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b

/** The histograms of straight RGBA pixels, transparent ones left out. */
export function histogramsOf(rgba: ArrayLike<number>): Histograms {
  const out: Histograms = { red: new Float64Array(256), green: new Float64Array(256), blue: new Float64Array(256), luma: new Float64Array(256), count: 0 }

  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < MIN_ALPHA) {
      continue
    }

    out.red[rgba[i]]++
    out.green[rgba[i + 1]]++
    out.blue[rgba[i + 2]]++
    out.luma[Math.round(lumaOf(rgba[i], rgba[i + 1], rgba[i + 2]))]++
    out.count++
  }

  return out
}

/** The values past which `fraction` of a histogram's pixels lie at the dark end and at the light end. */
export function clipPoints(histogram: ArrayLike<number>, fraction: number): [number, number] {
  let total = 0

  for (let v = 0; v < 256; v++) {
    total += histogram[v]
  }

  const limit = total * Math.max(0, Math.min(0.49, fraction))
  let low = 0
  let high = 255
  let seen = 0

  // The first value where more than the clipped share lies at or below it.
  for (; low < 255; low++) {
    seen += histogram[low]

    if (seen > limit) {
      break
    }
  }

  seen = 0

  for (; high > 0; high--) {
    seen += histogram[high]

    if (seen > limit) {
      break
    }
  }

  return [low, high]
}

/** A Levels range stretching `low`…`high` to black and white; null when there is too little range to stretch. */
function stretched(low: number, high: number, gamma = 1): LevelRange | null {
  if (high - low < 2) {
    return null
  }

  return { ...identityRange(), black: Math.max(0, Math.min(254, low)), white: Math.max(1, Math.min(255, high)), gamma: Math.round(Math.max(0.1, Math.min(9.99, gamma)) * 100) / 100 }
}

const isIdentity = (range: LevelRange): boolean => range.black === 0 && range.white === 255 && range.gamma === 1 && range.outputBlack === 0 && range.outputWhite === 255

/** The gamma that brings a normalised value `from` to `to` through Levels' midtone curve (t to the power of 1 / gamma). */
export function gammaFor(from: number, to: number): number {
  if (from <= 0.001 || from >= 0.999 || to <= 0.001 || to >= 0.999) {
    return 1
  }

  return Math.log(from) / Math.log(to)
}

/**
 * Levels settings for an automatic fix of straight RGBA pixels; null when the picture is a flat
 * tone with nothing to stretch, or already uses the whole range.
 */
export function autoLevels(rgba: ArrayLike<number>, mode: AutoMode, clip = DEFAULT_CLIP): LevelsSettings | null {
  const histograms = histogramsOf(rgba)

  if (!histograms.count) {
    return null
  }

  const levels = identityLevels()

  if (mode === 'contrast') {
    const pooled = new Float64Array(256)

    for (let v = 0; v < 256; v++) {
      pooled[v] = histograms.red[v] + histograms.green[v] + histograms.blue[v]
    }

    const range = stretched(...clipPoints(pooled, clip))

    if (!range) {
      return null
    }

    levels.ranges[0] = range
  } else if (mode === 'tone') {
    ;[histograms.red, histograms.green, histograms.blue].forEach((histogram, c) => {
      levels.ranges[c + 1] = stretched(...clipPoints(histogram, clip)) ?? identityRange()
    })
  } else {
    const [darkLimit, lightLimit] = clipPoints(histograms.luma, clip)
    const dark = [0, 0, 0, 0]
    const light = [0, 0, 0, 0]

    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i + 3] < MIN_ALPHA) {
        continue
      }

      const l = Math.round(lumaOf(rgba[i], rgba[i + 1], rgba[i + 2]))
      const into = l <= darkLimit ? dark : l >= lightLimit ? light : null

      if (into) {
        into[0] += rgba[i]
        into[1] += rgba[i + 1]
        into[2] += rgba[i + 2]
        into[3]++
      }
    }

    const ends = [0, 1, 2].map((c) => [dark[3] ? Math.round(dark[c] / dark[3]) : 0, light[3] ? Math.round(light[c] / light[3]) : 255] as [number, number])
    const ranges = ends.map(([low, high]) => stretched(low, high) ?? identityRange())
    const gammas = neutralGammas(rgba, ranges)
    ranges.forEach((range, c) => {
      levels.ranges[c + 1] = { ...range, gamma: Math.round(Math.max(0.5, Math.min(2, gammas[c])) * 100) / 100 }
    })
  }

  return levels.ranges.every(isIdentity) ? null : levels
}

/** Pixels must make up this share of the picture to count as its neutral midtones. */
const NEUTRAL_SHARE = 0.002

/**
 * Per-channel gammas that make the near-gray midtones neutral once the black and white points are
 * set: the average of those pixels' channels, each bent to their mean.
 */
function neutralGammas(rgba: ArrayLike<number>, ranges: LevelRange[]): [number, number, number] {
  const sums = [0, 0, 0]
  let count = 0
  let total = 0
  const mapped = [0, 0, 0]

  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < MIN_ALPHA) {
      continue
    }

    total++

    for (let c = 0; c < 3; c++) {
      const { black, white } = ranges[c]
      mapped[c] = Math.min(1, Math.max(0, (rgba[i + c] - black) / (white - black)))
    }

    const max = Math.max(mapped[0], mapped[1], mapped[2])
    const min = Math.min(mapped[0], mapped[1], mapped[2])
    const l = lumaOf(mapped[0], mapped[1], mapped[2])

    if (max - min < 0.12 && l > 0.2 && l < 0.8) {
      sums[0] += mapped[0]
      sums[1] += mapped[1]
      sums[2] += mapped[2]
      count++
    }
  }

  if (!count || count < total * NEUTRAL_SHARE) {
    return [1, 1, 1]
  }

  const means = sums.map((sum) => sum / count)
  const target = (means[0] + means[1] + means[2]) / 3

  return [gammaFor(means[0], target), gammaFor(means[1], target), gammaFor(means[2], target)]
}
