/*
 * Free Transform for Veritas Canvas. A frame (a placement box, like a layer's) goes around the
 * picked layers, with handles to scale it, a ring outside the corners to turn it, and the inside to
 * move it; the layers follow the frame through their transforms, so their pixels stay as they are.
 * A free distort pins the four corners anywhere: a perspective the format cannot hold, so it is
 * baked into new pixels when applied.
 */

import type { LayerTransform, Vec2 } from '../../../../shared/canvas/comp-format.ts'
import { apply, decompose, invert, type Mat, multiply, rotate, scale, translate, unitToDocument } from './geometry.ts'
import { Raster, type Rect } from './raster.ts'
import { sampleBilinear } from './sampling.ts'

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
export type FrameHit = Handle | 'rotate' | 'move'

/** Each handle's place on the frame's unit square. */
export const HANDLE_UNITS: Record<Handle, Vec2> = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] }

export const HANDLES = Object.keys(HANDLE_UNITS) as Handle[]

const isCorner = (handle: Handle): boolean => handle.length === 2

/** The handles in document pixels. */
export function handlePoints(frame: LayerTransform): Record<Handle, Vec2> {
  const m = unitToDocument(frame)

  return Object.fromEntries(HANDLES.map((handle) => [handle, apply(m, HANDLE_UNITS[handle])])) as Record<Handle, Vec2>
}

/**
 * What a document point is over: a handle (within `reach` document pixels), the ring outside a
 * corner where dragging turns the frame (`ring` wide), the inside, or nothing.
 */
export function hitFrame(frame: LayerTransform, point: Vec2, reach: number, ring = reach * 3): FrameHit | null {
  const points = handlePoints(frame)
  let nearest: Handle | null = null
  let distance = Infinity

  for (const handle of HANDLES) {
    const d = Math.hypot(point[0] - points[handle][0], point[1] - points[handle][1])

    if (d <= reach && d < distance) {
      nearest = handle
      distance = d
    }
  }

  if (nearest) {
    return nearest
  }

  const [u, v] = apply(invert(unitToDocument(frame)), point)

  if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
    return 'move'
  }

  for (const handle of HANDLES.filter(isCorner)) {
    if (Math.hypot(point[0] - points[handle][0], point[1] - points[handle][1]) <= reach + ring) {
      return 'rotate'
    }
  }

  return null
}

export interface FrameDrag {
  /** Shift: keep the proportions (scaling), or turn in 15° steps (rotating). */
  constrain?: boolean
  /** Alt: scale around the centre. */
  fromCentre?: boolean
}

/** The frame after dragging `hit` from one document point to another. */
export function dragFrame(frame: LayerTransform, hit: FrameHit, from: Vec2, to: Vec2, options: FrameDrag = {}): LayerTransform {
  const m = unitToDocument(frame)

  if (hit === 'move') {
    return decompose(multiply(translate(to[0] - from[0], to[1] - from[1]), m), frame)
  }

  if (hit === 'rotate') {
    const [cx, cy] = apply(m, [0.5, 0.5])
    const turned = ((Math.atan2(to[1] - cy, to[0] - cx) - Math.atan2(from[1] - cy, from[0] - cx)) * 180) / Math.PI
    let rotation = frame.rotation + turned

    if (options.constrain) {
      rotation = Math.round(rotation / 15) * 15
    }

    const turn = multiply(translate(cx, cy), multiply(rotate(rotation - frame.rotation), translate(-cx, -cy)))
    const out = decompose(multiply(turn, m), frame)

    return options.constrain ? { ...out, rotation: ((rotation % 360) + 540) % 360 - 180 } : out
  }

  // Scaling happens on the frame's own unit square: the handle follows the pointer there, and
  // the opposite side (or the centre) stays put.
  const [hu, hv] = HANDLE_UNITS[hit]
  const start = apply(invert(m), from)
  const now = apply(invert(m), to)
  let u1 = hu + (now[0] - start[0])
  let v1 = hv + (now[1] - start[1])
  const anchorU = options.fromCentre ? 0.5 : 1 - hu
  const anchorV = options.fromCentre ? 0.5 : 1 - hv
  const movesU = hit !== 'n' && hit !== 's'
  const movesV = hit !== 'e' && hit !== 'w'
  let su = movesU ? (u1 - anchorU) / (hu - anchorU) : 1
  let sv = movesV ? (v1 - anchorV) / (hv - anchorV) : 1

  if (options.constrain) {
    const size = movesU && movesV ? Math.max(Math.abs(su), Math.abs(sv)) : movesU ? Math.abs(su) : Math.abs(sv)
    su = (Math.sign(su) || 1) * size
    sv = (Math.sign(sv) || 1) * size
  }

  // The anchor of an edge's other direction is the middle, so a proportional edge drag grows both ways.
  const fixU = movesU ? anchorU : 0.5
  const fixV = movesV ? anchorV : 0.5
  u1 = fixU + (0 - fixU) * su
  v1 = fixV + (0 - fixV) * sv
  const local = multiply(translate(u1, v1), scale(su, sv))

  return decompose(multiply(m, local), frame)
}

/** The frame around several placements: their combined axis-aligned box. */
export function frameAround(transforms: readonly LayerTransform[]): LayerTransform | null {
  const points = transforms.flatMap((t) => {
    const m = unitToDocument(t)

    return [apply(m, [0, 0]), apply(m, [1, 0]), apply(m, [1, 1]), apply(m, [0, 1])]
  })

  if (!points.length) {
    return null
  }

  const xs = points.map((point) => point[0])
  const ys = points.map((point) => point[1])
  const x = Math.min(...xs)
  const y = Math.min(...ys)

  return { origin: [x, y], size: [Math.max(...xs) - x, Math.max(...ys) - y], rotation: 0, flipX: false, flipY: false, sampling: 'High quality' }
}

/** A placement carried along when its frame moves from `before` to `after`. */
export function follow(transform: LayerTransform, before: LayerTransform, after: LayerTransform): LayerTransform {
  const change = multiply(unitToDocument(after), invert(unitToDocument(before)))

  return decompose(multiply(change, unitToDocument(transform)), transform)
}

/** The CSS cursor for a handle, pointing the way it drags once the frame's turn is applied. */
export function handleCursor(frame: LayerTransform, handle: Handle): string {
  const [u, v] = HANDLE_UNITS[handle]
  const m = unitToDocument(frame)
  const centre = apply(m, [0.5, 0.5])
  const at = apply(m, [u, v])
  const angle = ((Math.atan2(at[1] - centre[1], at[0] - centre[0]) * 180) / Math.PI + 360) % 180
  const cursors = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize']

  return cursors[Math.round(angle / 45) % 4]
}

// Perspective.

/** Four corners in document pixels: top-left, top-right, bottom-right, bottom-left of the layer. */
export type Quad = [Vec2, Vec2, Vec2, Vec2]

/** A 3×3 projective map, row-major: x' = (m0 x + m1 y + m2) / (m6 x + m7 y + m8), and so on. */
export type Projective = [number, number, number, number, number, number, number, number, number]

/** The perspective map taking the unit square's corners to a quad's (Heckbert's square-to-quad). */
export function squareToQuad(quad: Quad): Projective {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = quad
  const sx = x0 - x1 + x2 - x3
  const sy = y0 - y1 + y2 - y3

  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    return [x1 - x0, x3 - x0, x0, y1 - y0, y3 - y0, y0, 0, 0, 1]
  }

  const dx1 = x1 - x2
  const dx2 = x3 - x2
  const dy1 = y1 - y2
  const dy2 = y3 - y2
  const det = dx1 * dy2 - dx2 * dy1
  const g = (sx * dy2 - dx2 * sy) / det
  const h = (dx1 * sy - sx * dy1) / det

  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1]
}

export function invertProjective(m: Projective): Projective {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C

  if (!det) {
    return [0, 0, 0, 0, 0, 0, 0, 0, 1]
  }

  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det]
}

export function project(m: Projective, x: number, y: number): Vec2 {
  const w = m[6] * x + m[7] * y + m[8]

  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w]
}

/** True when the quad is convex, its corners all turning the same way (as a perspective needs). */
export function isConvex(quad: Quad): boolean {
  let sign = 0

  for (let i = 0; i < 4; i++) {
    const [ax, ay] = quad[i]
    const [bx, by] = quad[(i + 1) % 4]
    const [cx, cy] = quad[(i + 2) % 4]
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx)

    if (Math.abs(cross) < 1e-9) {
      return false
    }

    if (sign && Math.sign(cross) !== sign) {
      return false
    }

    sign = Math.sign(cross)
  }

  return true
}

export const quadOf = (transform: LayerTransform): Quad => {
  const m = unitToDocument(transform)

  return [apply(m, [0, 0]), apply(m, [1, 0]), apply(m, [1, 1]), apply(m, [0, 1])]
}

/** The document pixels a quad covers, rounded out. */
export function quadBounds(quad: Quad): Rect {
  const xs = quad.map((point) => point[0])
  const ys = quad.map((point) => point[1])
  const x = Math.floor(Math.min(...xs))
  const y = Math.floor(Math.min(...ys))

  return { x, y, width: Math.max(1, Math.ceil(Math.max(...xs)) - x), height: Math.max(1, Math.ceil(Math.max(...ys)) - y) }
}

/**
 * A layer's pixels (its whole unit square) warped onto a quad: new pixels covering the quad's
 * bounds at `density` pixels a document pixel (below 1 for a quick preview while dragging).
 */
export function warpRaster(source: Raster, quad: Quad, density = 1): { raster: Raster; bounds: Rect } {
  const bounds = quadBounds(quad)
  const width = Math.max(1, Math.round(bounds.width * density))
  const height = Math.max(1, Math.round(bounds.height * density))
  const out = new Raster(width, height, source.channels)
  const back = invertProjective(squareToQuad(quad))
  const sample = new Uint8ClampedArray(4)
  const margin = 1 / Math.min(source.width, source.height)

  for (let y = 0; y < height; y++) {
    const dy = bounds.y + ((y + 0.5) * bounds.height) / height

    for (let x = 0; x < width; x++) {
      const dx = bounds.x + ((x + 0.5) * bounds.width) / width
      const [u, v] = project(back, dx, dy)

      if (!(u >= -margin && v >= -margin && u <= 1 + margin && v <= 1 + margin)) {
        continue
      }

      sampleBilinear(source, u * source.width - 0.5, v * source.height - 0.5, sample)
      const o = (y * width + x) * source.channels

      for (let c = 0; c < source.channels; c++) {
        out.data[o + c] = sample[c]
      }
    }
  }

  return { raster: out, bounds }
}

/** A placement for warped pixels: their bounds, unturned. */
export const boundsPlacement = (bounds: Rect): LayerTransform => ({ origin: [bounds.x, bounds.y], size: [bounds.width, bounds.height], rotation: 0, flipX: false, flipY: false, sampling: 'High quality' })

/** The matrix taking a frame's unit square to document pixels (for drawing handles). */
export const frameMatrix = (frame: LayerTransform): Mat => unitToDocument(frame)
