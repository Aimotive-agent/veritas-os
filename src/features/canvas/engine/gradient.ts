/*
 * Gradients for Veritas Canvas: colour stops and opacity stops from 0 to 1, each with a midpoint
 * towards the next (where their mix is half way), laid from a dragged line in one of five styles:
 * linear, radial, angle (a sweep around the start), reflected (linear both ways from the start)
 * and diamond (the end of the line is a corner). Colour and opacity are mixed apart, so a fade to
 * transparency keeps its colour. Painting looks colours up in a table of even steps.
 */

import type { Vec2 } from '../../../../shared/canvas/comp-format.ts'

export type RGB = [number, number, number]

export interface ColourStop {
  /** 0 to 1 along the gradient. */
  at: number
  /** A colour, or the foreground or background colour of the moment. */
  colour: RGB | 'foreground' | 'background'
  /** Where the mix towards the next stop is half way, as a fraction of the gap between them. */
  mid: number
}

export interface OpacityStop {
  at: number
  /** 0 to 1. */
  opacity: number
  mid: number
}

export interface Gradient {
  name: string
  colours: ColourStop[]
  opacities: OpacityStop[]
}

export const GRADIENT_STYLES = ['linear', 'radial', 'angle', 'reflected', 'diamond'] as const
export type GradientStyle = (typeof GRADIENT_STYLES)[number]

export const GRADIENT_STYLE_LABELS: Record<GradientStyle, string> = { linear: 'Linear', radial: 'Radial', angle: 'Angle', reflected: 'Reflected', diamond: 'Diamond' }

/** How close a midpoint may come to either of its stops. */
export const MID_LIMITS: [number, number] = [0.05, 0.95]

/** Entries in a gradient's colour table. */
export const TABLE_SIZE = 1024

const stop = (at: number, colour: ColourStop['colour']): ColourStop => ({ at, colour, mid: 0.5 })
const opaque: OpacityStop[] = [
  { at: 0, opacity: 1, mid: 0.5 },
  { at: 1, opacity: 1, mid: 0.5 }
]
const even = (colours: RGB[]): ColourStop[] => colours.map((colour, i) => stop(i / (colours.length - 1), colour))

/** The gradients the editor offers first; the first two follow the foreground and background colours. */
export const GRADIENT_PRESETS: readonly Gradient[] = [
  { name: 'Foreground to Background', colours: [stop(0, 'foreground'), stop(1, 'background')], opacities: opaque },
  {
    name: 'Foreground to Transparent',
    colours: [stop(0, 'foreground'), stop(1, 'foreground')],
    opacities: [
      { at: 0, opacity: 1, mid: 0.5 },
      { at: 1, opacity: 0, mid: 0.5 }
    ]
  },
  { name: 'Black to White', colours: even([[0, 0, 0], [255, 255, 255]]), opacities: opaque },
  {
    name: 'Fade to Black',
    colours: even([[0, 0, 0], [0, 0, 0]]),
    opacities: [
      { at: 0, opacity: 0, mid: 0.5 },
      { at: 1, opacity: 0.9, mid: 0.6 }
    ]
  },
  { name: 'Spectrum', colours: even([[255, 0, 0], [255, 255, 0], [0, 255, 0], [0, 255, 255], [0, 0, 255], [255, 0, 255], [255, 0, 0]]), opacities: opaque },
  { name: 'Sunset', colours: even([[45, 20, 80], [170, 40, 110], [245, 110, 60], [255, 210, 110]]), opacities: opaque },
  { name: 'Ocean', colours: even([[8, 24, 64], [16, 98, 140], [60, 190, 200], [200, 245, 240]]), opacities: opaque },
  { name: 'Copper', colours: even([[60, 30, 15], [190, 110, 60], [250, 205, 160], [150, 80, 40]]), opacities: opaque },
  { name: 'Steel', colours: even([[40, 46, 54], [200, 208, 216], [90, 98, 108], [235, 240, 245]]), opacities: opaque },
  { name: 'Violet to Orange', colours: even([[110, 50, 220], [255, 140, 40]]), opacities: opaque }
]

/** How far the mix between two stops has gone at `t` (0 to 1 between them): half way at `mid`, smoothly either side. */
export function midpointMix(t: number, mid: number): number {
  if (t <= 0) {
    return 0
  }

  if (t >= 1) {
    return 1
  }

  return Math.abs(mid - 0.5) < 1e-6 ? t : t ** (Math.LN2 / -Math.log(mid))
}

/** Stops in order along the gradient, positions and midpoints kept in range. */
export function sortedStops<T extends { at: number; mid: number }>(stops: readonly T[]): T[] {
  return stops.map((entry) => ({ ...entry, at: Math.max(0, Math.min(1, entry.at)), mid: Math.max(MID_LIMITS[0], Math.min(MID_LIMITS[1], entry.mid)) })).sort((a, b) => a.at - b.at)
}

/** The stops either side of `t` (sorted stops) and how far the mix between them has gone. */
function around<T extends { at: number; mid: number }>(stops: T[], t: number): [T, T, number] {
  const last = stops[stops.length - 1]

  if (t <= stops[0].at) {
    return [stops[0], stops[0], 0]
  }

  if (t >= last.at) {
    return [last, last, 0]
  }

  let i = 0

  while (stops[i + 1].at < t) {
    i++
  }

  const a = stops[i]
  const b = stops[i + 1]
  const gap = b.at - a.at

  return [a, b, gap > 0 ? midpointMix((t - a.at) / gap, a.mid) : 1]
}

export const colourOf = (colour: ColourStop['colour'], foreground: RGB, background: RGB): RGB => (colour === 'foreground' ? foreground : colour === 'background' ? background : colour)

/** The gradient's straight colour and opacity at `t`, 0 to 255 (not rounded). */
export function gradientAt(gradient: Gradient, t: number, foreground: RGB, background: RGB): [number, number, number, number] {
  const [a, b, k] = around(sortedStops(gradient.colours), t)
  const from = colourOf(a.colour, foreground, background)
  const to = colourOf(b.colour, foreground, background)
  const [p, q, m] = around(sortedStops(gradient.opacities), t)

  return [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k, from[2] + (to[2] - from[2]) * k, (p.opacity + (q.opacity - p.opacity) * m) * 255]
}

/** The gradient at TABLE_SIZE even steps from start to end (or end to start), straight RGBA from 0 to 255. */
export function gradientTable(gradient: Gradient, foreground: RGB, background: RGB, reverse = false): Float32Array {
  const colours = sortedStops(gradient.colours)
  const opacities = sortedStops(gradient.opacities)
  const out = new Float32Array(TABLE_SIZE * 4)

  for (let i = 0; i < TABLE_SIZE; i++) {
    const t = reverse ? 1 - i / (TABLE_SIZE - 1) : i / (TABLE_SIZE - 1)
    const [a, b, k] = around(colours, t)
    const from = colourOf(a.colour, foreground, background)
    const to = colourOf(b.colour, foreground, background)
    const [p, q, m] = around(opacities, t)
    out.set([from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k, from[2] + (to[2] - from[2]) * k, (p.opacity + (q.opacity - p.opacity) * m) * 255], i * 4)
  }

  return out
}

export interface GradientLine {
  style: GradientStyle
  /** Document points: where the gradient starts, and where it ends (or, for a diamond, a corner). */
  from: Vec2
  to: Vec2
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))

/** Where a document point falls along a gradient, 0 to 1. */
export function gradientPosition(line: GradientLine, x: number, y: number): number {
  const dx = line.to[0] - line.from[0]
  const dy = line.to[1] - line.from[1]
  const length = dx * dx + dy * dy

  if (!length) {
    return 1
  }

  const px = x - line.from[0]
  const py = y - line.from[1]
  const along = (px * dx + py * dy) / length

  switch (line.style) {
    case 'linear':
      return clamp01(along)
    case 'reflected':
      return clamp01(Math.abs(along))
    case 'radial':
      return clamp01(Math.sqrt((px * px + py * py) / length))
    case 'diamond':
      return clamp01(Math.abs(along) + Math.abs((py * dx - px * dy) / length))
    case 'angle': {
      // A sweep from the line round counterclockwise on screen (y runs down).
      const turn = (Math.atan2(dy, dx) - Math.atan2(py, px)) / (Math.PI * 2)

      return ((turn % 1) + 1) % 1
    }
  }
}

/**
 * The line that lays a gradient over a box in a style, at an angle (degrees; 0 runs left to right,
 * 90 top to bottom): from the centre, reaching the box's far corners, and for linear from side to side.
 */
export function lineAcross(style: GradientStyle, box: { x: number; y: number; width: number; height: number }, angle: number): GradientLine {
  const r = (angle * Math.PI) / 180
  const [ux, uy] = [Math.cos(r), Math.sin(r)]
  const centre: Vec2 = [box.x + box.width / 2, box.y + box.height / 2]
  const corners = [
    [-box.width / 2, -box.height / 2],
    [box.width / 2, -box.height / 2],
    [box.width / 2, box.height / 2],
    [-box.width / 2, box.height / 2]
  ]
  const along = (cx: number, cy: number) => Math.abs(cx * ux + cy * uy)
  const across = (cx: number, cy: number) => Math.abs(cy * ux - cx * uy)
  const metric = style === 'radial' ? (cx: number, cy: number) => Math.hypot(cx, cy) : style === 'diamond' ? (cx: number, cy: number) => along(cx, cy) + across(cx, cy) : along
  const reach = Math.max(1e-6, ...corners.map(([cx, cy]) => metric(cx, cy)))
  const end: Vec2 = [centre[0] + ux * reach, centre[1] + uy * reach]

  return style === 'linear' ? { style, from: [centre[0] - ux * reach, centre[1] - uy * reach], to: end } : { style, from: centre, to: end }
}
