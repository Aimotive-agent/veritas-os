/*
 * Selections in Veritas Canvas: a one-channel raster the size of the document, 255 where selected
 * and in between on soft edges (null in the document state means nothing is selected). Shapes are
 * drawn with antialiased edges and put together with what was selected; feather, expand and
 * contract refine a selection; its outline is traced once per change for the marching ants.
 */

import type { Vec2 } from '../../../../shared/canvas/comp-format.ts'
import { Raster, type Rect } from './raster.ts'

export type SelectionMode = 'new' | 'add' | 'subtract' | 'intersect'

/** Rows sampled inside each pixel row, for antialiased edges. */
const SUBROWS = 4

interface Edge {
  top: number
  bottom: number
  x: number
  y: number
  slope: number
}

/** A closed outline (document points) as coverage, filled even-odd: a lasso that crosses itself leaves a hole. */
export function polygonMask(width: number, height: number, points: readonly Vec2[]): Raster {
  const out = new Raster(width, height, 1)

  if (points.length < 3) {
    return out
  }

  const edges: Edge[] = []

  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [x0, y0] = points[j]
    const [x1, y1] = points[i]

    if (y0 !== y1) {
      edges.push({ top: Math.min(y0, y1), bottom: Math.max(y0, y1), x: x0, y: y0, slope: (x1 - x0) / (y1 - y0) })
    }
  }

  if (!edges.length) {
    return out
  }

  edges.sort((a, b) => a.top - b.top)
  const first = Math.max(0, Math.floor(edges[0].top))
  const last = Math.min(height, Math.ceil(Math.max(...edges.map((edge) => edge.bottom))))
  const full = new Float32Array(width + 1)
  const partial = new Float32Array(width + 1)
  const crossings: number[] = []
  let active: Edge[] = []
  let next = 0

  for (let y = first; y < last; y++) {
    full.fill(0)
    partial.fill(0)

    for (let s = 0; s < SUBROWS; s++) {
      const sy = y + (s + 0.5) / SUBROWS

      while (next < edges.length && edges[next].top <= sy) {
        active.push(edges[next++])
      }

      active = active.filter((edge) => edge.bottom > sy)
      crossings.length = 0

      for (const edge of active) {
        if (edge.top <= sy) {
          crossings.push(edge.x + (sy - edge.y) * edge.slope)
        }
      }

      crossings.sort((a, b) => a - b)

      for (let k = 0; k + 1 < crossings.length; k += 2) {
        addSpan(full, partial, crossings[k], crossings[k + 1], width)
      }
    }

    let run = 0
    const row = y * width

    for (let x = 0; x < width; x++) {
      run += full[x]
      const cover = run + partial[x]

      if (cover > 0.001) {
        out.data[row + x] = (Math.min(SUBROWS, cover) / SUBROWS) * 255
      }
    }
  }

  return out
}

/** One sub-row's span [a, b) on a row: whole pixels through a running sum, the partly covered ends directly. */
function addSpan(full: Float32Array, partial: Float32Array, a: number, b: number, width: number): void {
  const from = Math.max(0, a)
  const to = Math.min(width, b)

  if (to <= from) {
    return
  }

  const start = Math.floor(from)
  const end = Math.floor(to)

  if (start === end) {
    partial[start] += to - from

    return
  }

  partial[start] += start + 1 - from
  full[start + 1] += 1
  full[end] -= 1

  if (end < width) {
    partial[end] += to - end
  }
}

export const rectPoints = (box: Rect): Vec2[] => [
  [box.x, box.y],
  [box.x + box.width, box.y],
  [box.x + box.width, box.y + box.height],
  [box.x, box.y + box.height]
]

/** An ellipse filling a box, as an outline fine enough (about a point a pixel) that its edge stays smooth. */
export function ellipsePoints(box: Rect): Vec2[] {
  const rx = box.width / 2
  const ry = box.height / 2
  const steps = Math.min(20_000, Math.max(32, Math.ceil(Math.PI * (rx + ry))))
  const points: Vec2[] = []

  for (let i = 0; i < steps; i++) {
    const angle = (i / steps) * Math.PI * 2
    points.push([box.x + rx + Math.cos(angle) * rx, box.y + ry + Math.sin(angle) * ry])
  }

  return points
}

/** True when nothing at all is selected. */
export function isEmptySelection(selection: Raster): boolean {
  const { data } = selection

  for (let i = 0; i < data.length; i++) {
    if (data[i]) {
      return false
    }
  }

  return true
}

const orNull = (selection: Raster): Raster | null => (isEmptySelection(selection) ? null : selection)

/**
 * A new shape put together with the selection there was: in its place, added, taken away or
 * intersected. Taking away from nothing leaves nothing; adding to or intersecting with nothing
 * starts afresh. Null when nothing is left selected.
 */
export function combineSelection(current: Raster | null, shape: Raster, mode: SelectionMode): Raster | null {
  if (mode === 'new' || !current) {
    return mode === 'subtract' && !current ? null : orNull(shape)
  }

  const out = new Raster(shape.width, shape.height, 1)
  const a = current.data
  const b = shape.data
  const o = out.data

  if (mode === 'add') {
    for (let i = 0; i < o.length; i++) {
      o[i] = a[i] > b[i] ? a[i] : b[i]
    }
  } else if (mode === 'subtract') {
    for (let i = 0; i < o.length; i++) {
      o[i] = (a[i] * (255 - b[i]) + 127) / 255
    }
  } else {
    for (let i = 0; i < o.length; i++) {
      o[i] = (a[i] * b[i] + 127) / 255
    }
  }

  return orNull(out)
}

export const selectAll = (width: number, height: number): Raster => Raster.filled(width, height, 255, 1)

/** Everything that was not selected; null when everything was. */
export function invertSelection(selection: Raster): Raster | null {
  const out = new Raster(selection.width, selection.height, 1)

  for (let i = 0; i < out.data.length; i++) {
    out.data[i] = 255 - selection.data[i]
  }

  return orNull(out)
}

/** The selection moved by whole pixels (what falls off the canvas is lost); null when nothing is left. */
export function shiftSelection(selection: Raster, dx: number, dy: number): Raster | null {
  const { width, height } = selection

  return orNull(selection.crop({ x: -Math.round(dx), y: -Math.round(dy), width, height }))
}

/** Box sizes whose three passes approximate a gaussian of `sigma`. */
export function boxSizes(sigma: number, passes = 3): number[] {
  const ideal = Math.sqrt((12 * sigma * sigma) / passes + 1)
  let lower = Math.floor(ideal)

  if (lower % 2 === 0) {
    lower--
  }

  const upper = lower + 2
  const small = Math.round((12 * sigma * sigma - passes * lower * lower - 4 * passes * lower - 3 * passes) / (-4 * lower - 4))

  return Array.from({ length: passes }, (_, i) => (i < small ? lower : upper))
}

/** A box blur along rows (stride 1) or columns (stride `width`), edges extended. */
export function boxPass(source: Float32Array, target: Float32Array, width: number, height: number, radius: number, vertical: boolean): void {
  const lines = vertical ? width : height
  const length = vertical ? height : width
  const step = vertical ? width : 1
  const scale = 1 / (radius * 2 + 1)

  for (let line = 0; line < lines; line++) {
    const base = vertical ? line : line * width
    const first = source[base]
    const last = source[base + (length - 1) * step]
    let sum = first * (radius + 1)

    for (let i = 0; i < radius; i++) {
      sum += i < length ? source[base + i * step] : last
    }

    for (let i = 0; i < length; i++) {
      const enter = i + radius < length ? source[base + (i + radius) * step] : last
      const leave = i - radius - 1 >= 0 ? source[base + (i - radius - 1) * step] : first
      sum += enter - leave
      target[base + i * step] = sum * scale
    }
  }
}

/** Soft edges: a gaussian blur `radius` pixels wide (three box blurs), the canvas edge extended so a full selection stays full. */
export function featherSelection(selection: Raster, radius: number): Raster | null {
  if (radius <= 0) {
    return orNull(selection)
  }

  const { width, height } = selection
  const a = Float32Array.from(selection.data)
  const b = new Float32Array(a.length)

  for (const size of boxSizes(radius / 2)) {
    const r = (size - 1) / 2
    boxPass(a, b, width, height, r, false)
    boxPass(b, a, width, height, r, true)
  }

  const out = new Raster(width, height, 1)

  for (let i = 0; i < a.length; i++) {
    out.data[i] = a[i]
  }

  return orNull(out)
}

const FAR = 1e20

/** The squared distance transform of one line (Felzenszwalb and Huttenlocher). */
function distanceLine(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0
  v[0] = 0
  z[0] = -Infinity
  z[1] = Infinity

  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])

    while (s <= z[k]) {
      k--
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }

    k++
    v[k] = q
    z[k] = s
    z[k + 1] = Infinity
  }

  k = 0

  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) {
      k++
    }

    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]
  }
}

/** Each pixel's squared distance to the nearest pixel where `feature` holds; exact, whatever the distance. */
export function distanceField(width: number, height: number, feature: (i: number) => boolean): Float32Array {
  const grid = new Float32Array(width * height)
  const n = Math.max(width, height)
  const f = new Float64Array(n)
  const d = new Float64Array(n)
  const v = new Int32Array(n)
  const z = new Float64Array(n + 1)

  for (let i = 0; i < grid.length; i++) {
    grid[i] = feature(i) ? 0 : FAR
  }

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      f[y] = grid[y * width + x]
    }

    distanceLine(f, height, d, v, z)

    for (let y = 0; y < height; y++) {
      grid[y * width + x] = d[y]
    }
  }

  for (let y = 0; y < height; y++) {
    const row = y * width

    for (let x = 0; x < width; x++) {
      f[x] = grid[row + x]
    }

    distanceLine(f, width, d, v, z)

    for (let x = 0; x < width; x++) {
      grid[row + x] = d[x]
    }
  }

  return grid
}

/** The selection grown by `radius` pixels with round corners. */
export function expandSelection(selection: Raster, radius: number): Raster | null {
  const { width, height, data } = selection
  const field = distanceField(width, height, (i) => data[i] >= 128)
  const out = new Raster(width, height, 1)

  for (let i = 0; i < data.length; i++) {
    const reach = Math.max(0, Math.min(1, radius + 1 - Math.sqrt(field[i]))) * 255
    out.data[i] = data[i] >= 128 ? 255 : Math.max(data[i], reach)
  }

  return orNull(out)
}

/** The selection shrunk by `radius` pixels; the canvas edge does not count as an edge of the selection. */
export function contractSelection(selection: Raster, radius: number): Raster | null {
  const { width, height, data } = selection
  const field = distanceField(width, height, (i) => data[i] < 128)
  const out = new Raster(width, height, 1)

  for (let i = 0; i < data.length; i++) {
    const kept = Math.max(0, Math.min(1, Math.sqrt(field[i]) - radius)) * 255
    out.data[i] = data[i] < 128 ? 0 : Math.min(data[i], kept)
  }

  return orNull(out)
}

const EAST = 1
const SOUTH = 2
const WEST = 4
const NORTH = 8
const RIGHT_OF: Record<number, number> = { [EAST]: SOUTH, [SOUTH]: WEST, [WEST]: NORTH, [NORTH]: EAST }
const LEFT_OF: Record<number, number> = { [EAST]: NORTH, [NORTH]: WEST, [WEST]: SOUTH, [SOUTH]: EAST }

/**
 * The selection's edge, between pixels at least half selected and the rest, as closed loops of
 * document points (corners only), each with the selection on its right. A very busy edge (a magic
 * wand on noise) is traced on a coarser grid so drawing it stays quick.
 */
export function traceOutline(selection: Raster, maxEdges = 400_000): Float32Array[] {
  const { width, height, data } = selection
  let edges = 0

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = data[y * width + x] >= 128

      if (inside !== (x + 1 < width && data[y * width + x + 1] >= 128)) edges++
      if (inside !== (y + 1 < height && data[(y + 1) * width + x] >= 128)) edges++
      if (inside && x === 0) edges++
      if (inside && y === 0) edges++
    }
  }

  let step = 1

  while (edges / step > maxEdges && step < 64) {
    step *= 2
  }

  const columns = Math.ceil(width / step)
  const rows = Math.ceil(height / step)
  const cells = new Uint8Array(columns * rows)

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      if (step === 1) {
        cells[y * columns + x] = data[y * width + x] >= 128 ? 1 : 0
        continue
      }

      let sum = 0
      let count = 0

      for (let sy = y * step; sy < Math.min(height, (y + 1) * step); sy++) {
        for (let sx = x * step; sx < Math.min(width, (x + 1) * step); sx++) {
          sum += data[sy * width + sx]
          count++
        }
      }

      cells[y * columns + x] = sum >= count * 128 ? 1 : 0
    }
  }

  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < columns && y < rows && cells[y * columns + x] === 1
  const stride = columns + 1
  const exits = new Uint8Array(stride * (rows + 1))

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      if (!inside(x, y)) {
        continue
      }

      if (!inside(x, y - 1)) exits[y * stride + x] |= EAST
      if (!inside(x + 1, y)) exits[y * stride + x + 1] |= SOUTH
      if (!inside(x, y + 1)) exits[(y + 1) * stride + x + 1] |= WEST
      if (!inside(x - 1, y)) exits[(y + 1) * stride + x] |= NORTH
    }
  }

  const loops: Float32Array[] = []
  const points: number[] = []

  for (let start = 0; start < exits.length; start++) {
    // A vertex where two loops touch starts (or is passed by) both.
    while (exits[start]) {
      points.length = 0
      let at = start
      let heading = exits[at] & -exits[at]
      points.push((at % stride) * step, Math.floor(at / stride) * step)

      for (;;) {
        exits[at] &= ~heading
        at += heading === EAST ? 1 : heading === WEST ? -1 : heading === SOUTH ? stride : -stride

        if (at === start) {
          break
        }

        // Where two pixels meet only at a corner, turn right, so they stay apart.
        const ways = exits[at]

        if (!ways) {
          break
        }

        const next = ways & RIGHT_OF[heading] ? RIGHT_OF[heading] : ways & heading ? heading : LEFT_OF[heading]

        if (next !== heading) {
          points.push((at % stride) * step, Math.floor(at / stride) * step)
        }

        heading = next
      }

      loops.push(Float32Array.from(points))
    }
  }

  return loops
}
