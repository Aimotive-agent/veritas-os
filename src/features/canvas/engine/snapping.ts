/*
 * Snapping and smart guides, as pure maths over lines and boxes. A point or a moving box is pulled
 * onto the nearest candidate line within reach (each way on its own): guides, the canvas's edges
 * and centre, other layers' edges and centres. Smart guides are what a moving box lines up with
 * while it moves (edges and centres of other boxes) and how far it sits from its neighbours.
 */

import type { Vec2 } from '../../../../shared/canvas/comp-format.ts'
import type { Rect } from './raster.ts'

export type SnapKind = 'guide' | 'canvas' | 'layer'

/** A line things snap to: x = value for `x` (vertical), y = value for `y` (horizontal). */
export interface SnapLine {
  axis: 'x' | 'y'
  value: number
  kind: SnapKind
}

export interface Snapped {
  /** What to add to the position (or the offset) to land on the line, each way. */
  delta: Vec2
  /** The lines landed on, for drawing them. */
  lines: SnapLine[]
}

/** The nearest line to any of `values` within `reach`: how far to move, and the line. */
export function nearest(values: readonly number[], lines: readonly SnapLine[], reach: number): { delta: number; line: SnapLine } | null {
  let best: { delta: number; line: SnapLine } | null = null

  for (const line of lines) {
    for (const value of values) {
      const delta = line.value - value

      // Guides win a tie: they are put down on purpose.
      if (Math.abs(delta) <= reach && (!best || Math.abs(delta) < Math.abs(best.delta) - 1e-9 || (Math.abs(delta) <= Math.abs(best.delta) + 1e-9 && line.kind === 'guide' && best.line.kind !== 'guide'))) {
        best = { delta, line }
      }
    }
  }

  return best
}

/** A point pulled onto the nearest vertical and horizontal lines within reach. */
export function snapToLines(point: Vec2, lines: readonly SnapLine[], reach: number): Snapped {
  const x = nearest(
    [point[0]],
    lines.filter((line) => line.axis === 'x'),
    reach
  )
  const y = nearest(
    [point[1]],
    lines.filter((line) => line.axis === 'y'),
    reach
  )

  return { delta: [x?.delta ?? 0, y?.delta ?? 0], lines: [x?.line, y?.line].filter((line): line is SnapLine => Boolean(line)) }
}

/** A box's left, centre and right (or top, middle and bottom). */
export const spanOf = (box: Rect, axis: 'x' | 'y'): number[] => (axis === 'x' ? [box.x, box.x + box.width / 2, box.x + box.width] : [box.y, box.y + box.height / 2, box.y + box.height])

/** A moving box pulled so one of its edges or its centre lands on a line within reach, each way. */
export function snapBox(box: Rect, lines: readonly SnapLine[], reach: number): Snapped {
  const x = nearest(
    spanOf(box, 'x'),
    lines.filter((line) => line.axis === 'x'),
    reach
  )
  const y = nearest(
    spanOf(box, 'y'),
    lines.filter((line) => line.axis === 'y'),
    reach
  )

  return { delta: [x?.delta ?? 0, y?.delta ?? 0], lines: [x?.line, y?.line].filter((line): line is SnapLine => Boolean(line)) }
}

/** The lines a document offers: the canvas's edges and centre, guides, and boxes' edges and centres. */
export function linesOf(canvas: { width: number; height: number } | null, guides: readonly { axis: 'horizontal' | 'vertical'; position: number }[], boxes: readonly Rect[]): SnapLine[] {
  const lines: SnapLine[] = []

  if (canvas) {
    for (const value of [0, canvas.width / 2, canvas.width]) {
      lines.push({ axis: 'x', value, kind: 'canvas' })
    }

    for (const value of [0, canvas.height / 2, canvas.height]) {
      lines.push({ axis: 'y', value, kind: 'canvas' })
    }
  }

  for (const guide of guides) {
    lines.push({ axis: guide.axis === 'vertical' ? 'x' : 'y', value: guide.position, kind: 'guide' })
  }

  for (const box of boxes) {
    for (const value of spanOf(box, 'x')) {
      lines.push({ axis: 'x', value, kind: 'layer' })
    }

    for (const value of spanOf(box, 'y')) {
      lines.push({ axis: 'y', value, kind: 'layer' })
    }
  }

  return lines
}

/** A line a smart guide draws: at `at` along its axis, from `from` to `to` across it. */
export interface GuideLine {
  axis: 'x' | 'y'
  at: number
  from: number
  to: number
}

/** A gap between the moving box and a neighbour: along `axis` from `from` to `to`, drawn at `across`. */
export interface Gap {
  axis: 'x' | 'y'
  from: number
  to: number
  across: number
  distance: number
}

const overlaps = (a0: number, a1: number, b0: number, b1: number): boolean => a0 < b1 && b0 < a1

/**
 * Smart guides for a moving box: a line wherever one of its edges or its centre lines up (within
 * `tolerance`) with another box's or the canvas's, spanning both; and the gap to the nearest
 * neighbour on each side that it faces.
 */
export function smartGuides(moving: Rect, others: readonly Rect[], canvas: Rect, tolerance = 0.5): { lines: GuideLine[]; gaps: Gap[] } {
  const lines: GuideLine[] = []

  for (const axis of ['x', 'y'] as const) {
    const mine = spanOf(moving, axis)

    for (const other of [...others, canvas]) {
      const theirs = spanOf(other, axis)

      for (const value of mine) {
        if (theirs.some((candidate) => Math.abs(candidate - value) <= tolerance)) {
          const span = axis === 'x' ? [moving.y, moving.y + moving.height, other.y, other.y + other.height] : [moving.x, moving.x + moving.width, other.x, other.x + other.width]
          const line = { axis, at: value, from: Math.min(...span), to: Math.max(...span) }

          if (!lines.some((known) => known.axis === line.axis && Math.abs(known.at - line.at) <= tolerance)) {
            lines.push(line)
          } else {
            const known = lines.find((entry) => entry.axis === line.axis && Math.abs(entry.at - line.at) <= tolerance)!
            known.from = Math.min(known.from, line.from)
            known.to = Math.max(known.to, line.to)
          }
        }
      }
    }
  }

  const gaps: Gap[] = []
  const right = moving.x + moving.width
  const bottom = moving.y + moving.height
  const facing = (side: 'left' | 'right' | 'up' | 'down') =>
    others
      .filter((other) => (side === 'left' || side === 'right' ? overlaps(moving.y, bottom, other.y, other.y + other.height) : overlaps(moving.x, right, other.x, other.x + other.width)))
      .map((other) => ({ other, distance: side === 'left' ? moving.x - (other.x + other.width) : side === 'right' ? other.x - right : side === 'up' ? moving.y - (other.y + other.height) : other.y - bottom }))
      .filter((entry) => entry.distance > 0)
      .sort((a, b) => a.distance - b.distance)[0]

  for (const side of ['left', 'right', 'up', 'down'] as const) {
    const found = facing(side)

    if (!found) {
      continue
    }

    const { other, distance } = found

    if (side === 'left' || side === 'right') {
      const top = Math.max(moving.y, other.y)
      const low = Math.min(bottom, other.y + other.height)
      gaps.push({ axis: 'x', from: side === 'left' ? other.x + other.width : right, to: side === 'left' ? moving.x : other.x, across: (top + low) / 2, distance })
    } else {
      const left = Math.max(moving.x, other.x)
      const far = Math.min(right, other.x + other.width)
      gaps.push({ axis: 'y', from: side === 'up' ? other.y + other.height : bottom, to: side === 'up' ? moving.y : other.y, across: (left + far) / 2, distance })
    }
  }

  return { lines, gaps }
}

/** Ruler ticks for a zoom: the labelled step (in document pixels) and how many parts it splits into. */
export function rulerSteps(zoom: number, minLabelGap = 56): { step: number; parts: number } {
  let step = 1

  for (let scale = 1; step * zoom < minLabelGap; scale *= 10) {
    step = [1, 2, 5, 10].map((factor) => factor * scale).find((candidate) => candidate * zoom >= minLabelGap) ?? scale * 10
  }

  const parts = [10, 5, 2].find((count) => (step * zoom) / count >= 5) ?? 1

  return { step, parts }
}
