/*
 * The Crop tool's geometry: boxes held to a ratio (1:1, 4:5, 16:9…), the angle a line drawn along
 * a horizon asks for, and the largest box that fits inside a canvas turned by that angle, so a
 * straightened picture shows no empty corners. Whole pixels throughout.
 */

import type { Vec2 } from '../../../../shared/canvas/comp-format.ts'
import type { FrameHit } from './transform.ts'
import type { Rect } from './raster.ts'

export const CROP_RATIOS = ['free', 'original', '1:1', '4:5', '3:2', '16:9', '9:16', 'custom'] as const
export type CropRatio = (typeof CROP_RATIOS)[number]

export const CROP_RATIO_LABELS: Record<CropRatio, string> = {
  free: 'Free',
  original: 'Original',
  '1:1': '1:1 (square)',
  '4:5': '4:5',
  '3:2': '3:2',
  '16:9': '16:9',
  '9:16': '9:16',
  custom: 'Custom'
}

export interface CropOptions {
  ratio: CropRatio
  /** Width and height of a custom ratio. */
  custom: Vec2
  /** Portrait for landscape and the other way round. */
  swapped: boolean
}

/** A crop option as width over height; null when the box is free. */
export function ratioOf(options: CropOptions, canvas: { width: number; height: number }): number | null {
  let ratio: number | null

  switch (options.ratio) {
    case 'free':
      return null
    case 'original':
      ratio = canvas.width / canvas.height
      break
    case 'custom':
      ratio = options.custom[0] > 0 && options.custom[1] > 0 ? options.custom[0] / options.custom[1] : null
      break
    default: {
      const [w, h] = options.ratio.split(':').map(Number)
      ratio = w / h
    }
  }

  return ratio && options.swapped ? 1 / ratio : ratio
}

/** The largest box of `ratio` (width over height) centred in a box, on whole pixels. */
export function fitRatio(box: Rect, ratio: number): Rect {
  let width = box.width
  let height = width / ratio

  if (height > box.height) {
    height = box.height
    width = height * ratio
  }

  width = Math.max(1, Math.round(width))
  height = Math.max(1, Math.round(height))

  return { x: Math.round(box.x + (box.width - width) / 2), y: Math.round(box.y + (box.height - height) / 2), width, height }
}

/** A box dragged from a point to another, held to `ratio` (the larger reach of the two decides its size). */
export function ratioBoxFrom(start: Vec2, to: Vec2, ratio: number): Rect {
  const dx = to[0] - start[0]
  const dy = to[1] - start[1]
  const width = Math.max(Math.abs(dx), Math.abs(dy) * ratio)
  const height = width / ratio
  const x = dx < 0 ? start[0] - width : start[0]
  const y = dy < 0 ? start[1] - height : start[1]

  return { x: Math.round(x), y: Math.round(y), width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) }
}

/**
 * A box from a handle drag set back to `ratio`: a top or bottom handle sets the height and the width
 * follows around the middle; a side handle sets the width and the height follows around the middle;
 * a corner keeps the opposite corner where it is.
 */
export function holdRatio(box: Rect, ratio: number, hit: FrameHit): Rect {
  if (hit === 'n' || hit === 's') {
    const width = Math.max(1, Math.round(box.height * ratio))

    return { ...box, x: Math.round(box.x + (box.width - width) / 2), width }
  }

  const height = Math.max(1, Math.round(box.width / ratio))

  if (hit === 'e' || hit === 'w') {
    return { ...box, y: Math.round(box.y + (box.height - height) / 2), height }
  }

  return { ...box, y: hit === 'nw' || hit === 'ne' ? box.y + box.height - height : box.y, height }
}

/**
 * How far to turn a picture so a line drawn along its horizon (or a wall) comes out level: the
 * line's angle from the horizontal, or from the vertical when it is closer to that, negated.
 * Degrees, clockwise positive, as layer rotations are.
 */
export function straightenAngle(from: Vec2, to: Vec2): number {
  const degrees = (Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI
  // Folded into −90…90 (a line drawn right to left means the same), then measured from the nearer axis.
  const folded = degrees > 90 ? degrees - 180 : degrees < -90 ? degrees + 180 : degrees
  const off = Math.abs(folded) > 45 ? folded - Math.sign(folded) * 90 : folded

  return Math.round(-off * 100) / 100 || 0
}

/**
 * The largest box of `ratio` (width over height) centred in a `width`×`height` canvas turned by
 * `degrees` around its centre: what a straightened picture can keep without empty corners.
 */
export function largestTurnedBox(width: number, height: number, degrees: number, ratio = width / height): Rect {
  const radians = (Math.abs(degrees % 180) * Math.PI) / 180
  const cos = Math.abs(Math.cos(radians))
  const sin = Math.abs(Math.sin(radians))
  // A turned layer's edge pixels are soft: a pixel in from each side keeps them out of the box.
  const inset = sin > 1e-9 ? 2 : 0
  // Each corner (±a, ±b) of the box, turned back, has to stay inside the canvas's half sizes.
  const b = Math.min((width - inset) / 2 / (ratio * cos + sin), (height - inset) / 2 / (ratio * sin + cos))
  const boxWidth = Math.max(1, Math.floor(2 * b * ratio))
  const boxHeight = Math.max(1, Math.floor(2 * b))

  return { x: Math.round((width - boxWidth) / 2), y: Math.round((height - boxHeight) / 2), width: boxWidth, height: boxHeight }
}

/** A ratio however it was written ("4:5", "16x9", "1.5", "square", "original"); null for none. */
export function ratioFrom(value: unknown, canvas: { width: number; height: number }): number | null {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()

  if (!text || text === 'free' || text === 'none') {
    return null
  }

  if (text === 'square') {
    return 1
  }

  if (text === 'original' || text === 'canvas') {
    return canvas.width / canvas.height
  }

  const pair = /^(\d+(?:\.\d+)?)\s*[:x×/]\s*(\d+(?:\.\d+)?)$/.exec(text)
  const ratio = pair ? Number(pair[1]) / Number(pair[2]) : Number(text)

  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 100 || ratio < 0.01) {
    throw new Error('ratio is width:height, like 1:1, 4:5, 3:2, 16:9 or 9:16, a number such as 1.5, or original')
  }

  return ratio
}
