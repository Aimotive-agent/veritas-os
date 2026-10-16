/*
 * Brush strokes for Veritas Canvas. Pointer points are smoothed into a curve, dabs are placed along
 * it every `spacing` of the brush's size, and each dab is stamped into the raster on the CPU inside
 * the area it touches only, so a 4K layer uploads just that part. Flow builds up within a stroke
 * while opacity caps it: a stroke never gets darker than its opacity however often it crosses itself.
 */

import { invert, type Mat } from './geometry.ts'
import { type HistoryEntry, PixelEdit, TILE } from './history.ts'
import { clipRect, type Raster, type Rect, unionRect } from './raster.ts'
import { coverageReader } from './sampling.ts'

export interface BrushSettings {
  /** Diameter in document pixels. */
  size: number
  /** 0 (soft) to 1 (hard). */
  hardness: number
  opacity: number
  flow: number
  /** Distance between dabs, as a fraction of the size. */
  spacing: number
}

export interface Dab {
  x: number
  y: number
  pressure: number
}

/** How much of a dab lands at a distance from its centre: an antialiased rim, and a smooth falloff inside for soft brushes. */
export function dabAlpha(distance: number, radius: number, hardness: number): number {
  const rim = Math.min(1, radius + 0.5 - distance)

  if (rim <= 0) {
    return 0
  }

  const inner = radius * hardness

  if (distance <= inner || hardness >= 1) {
    return rim
  }

  const t = (distance - inner) / (radius - inner)

  return rim * (1 - t * t * (3 - 2 * t))
}

/** Places dabs along a path at even spacing, carrying the distance left over from one piece to the next. */
export class DabPlacer {
  private last: Dab | null = null
  private travelled = 0

  constructor(private readonly gap: (pressure: number) => number) {}

  /** The dabs on the way to a point; the first point is a dab itself. */
  to(x: number, y: number, pressure = 1): Dab[] {
    const from = this.last

    if (!from) {
      this.last = { x, y, pressure }

      return [this.last]
    }

    const dx = x - from.x
    const dy = y - from.y
    const length = Math.hypot(dx, dy)

    if (!length) {
      return []
    }

    const dabs: Dab[] = []
    let at = 0

    for (;;) {
      const gap = Math.max(0.5, this.gap(from.pressure + ((pressure - from.pressure) * at) / length))
      const next = gap - this.travelled

      if (at + next > length) {
        break
      }

      at += next
      this.travelled = 0
      const t = at / length
      dabs.push({ x: from.x + dx * t, y: from.y + dy * t, pressure: from.pressure + (pressure - from.pressure) * t })
    }

    this.travelled += length - at
    this.last = { x, y, pressure }

    return dabs
  }
}

/**
 * Smooths pointer points into a curve through the midpoints between them (each point pulls the
 * path towards it), handed on as short straight pieces. The last stretch waits for `end`.
 */
export class Smoother {
  private previous: Dab | null = null
  private middle: Dab | null = null

  add(point: Dab): Dab[] {
    const previous = this.previous

    if (!previous) {
      this.previous = point
      this.middle = point

      return [point]
    }

    const start = this.middle!
    const middle = { x: (previous.x + point.x) / 2, y: (previous.y + point.y) / 2, pressure: (previous.pressure + point.pressure) / 2 }
    const length = Math.hypot(previous.x - start.x, previous.y - start.y) + Math.hypot(middle.x - previous.x, middle.y - previous.y)
    const pieces = Math.max(1, Math.ceil(length / 2))
    const out: Dab[] = []

    for (let i = 1; i <= pieces; i++) {
      const t = i / pieces
      const u = 1 - t
      out.push({
        x: u * u * start.x + 2 * u * t * previous.x + t * t * middle.x,
        y: u * u * start.y + 2 * u * t * previous.y + t * t * middle.y,
        pressure: u * start.pressure + t * middle.pressure
      })
    }

    this.previous = point
    this.middle = middle

    return out
  }

  end(): Dab[] {
    const last = this.previous
    const start = this.middle

    this.previous = null
    this.middle = null

    return last && start && (last.x !== start.x || last.y !== start.y) ? [last] : []
  }
}

/** What a stroke lays down: a colour (gray on a mask) over the pixels, or transparency. */
export interface StrokeInk {
  colour: [number, number, number]
  erase: boolean
  /**
   * What to lay at each raster pixel instead of one colour (the Clone Stamp's copy), as straight
   * RGBA, or gray in the first channel and 255 in the last on a mask. A pixel must get the same
   * value all stroke long, as each dab redraws from the pixels as they were. A clear copy lays nothing.
   */
  sample?: (x: number, y: number, out: Uint8ClampedArray) => void
}

/**
 * One brush stroke on a raster placed in the document by `toDocument`. Feed it document points
 * with `to`, call `end` when the pointer lifts, then `finish` for the undo step.
 */
export class Stroke {
  readonly edit: PixelEdit
  private readonly placer: DabPlacer
  private readonly smoother = new Smoother()
  private readonly toRaster: Mat
  /** Raster pixels per document pixel. */
  private readonly density: number
  private readonly selected: (px: number, py: number) => number
  private readonly cover = new Map<number, Float32Array>()
  private readonly columns: number
  private readonly gray: number
  private readonly copied = new Uint8ClampedArray(4)
  /** Where the stroke changed pixels so far (raster pixels). */
  area: Rect | null = null

  constructor(
    readonly raster: Raster,
    toDocument: Mat,
    readonly settings: BrushSettings,
    readonly ink: StrokeInk,
    selection: Raster | null
  ) {
    this.edit = new PixelEdit(raster)
    this.toRaster = invert(toDocument)
    this.density = Math.sqrt(Math.abs(this.toRaster.a * this.toRaster.d - this.toRaster.b * this.toRaster.c)) || 1
    this.selected = coverageReader(selection, toDocument)
    this.columns = Math.ceil(raster.width / TILE)
    this.gray = 0.299 * ink.colour[0] + 0.587 * ink.colour[1] + 0.114 * ink.colour[2]
    this.placer = new DabPlacer((pressure) => Math.max(1, this.diameter(pressure)) * settings.spacing)
  }

  /** The brush's diameter in raster pixels at a pressure. */
  private diameter(pressure: number): number {
    return Math.max(1, this.settings.size * pressure) * this.density
  }

  /** Continue the stroke to a document point; returns the raster area it changed, or null. */
  to(x: number, y: number, pressure = 1): Rect | null {
    const m = this.toRaster
    let changed: Rect | null = null

    for (const point of this.smoother.add({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f, pressure })) {
      changed = this.along(point, changed)
    }

    return this.touch(changed)
  }

  /** The end of the stroke's path, which the smoothing holds back until the pointer lifts. */
  end(): Rect | null {
    let changed: Rect | null = null

    for (const point of this.smoother.end()) {
      changed = this.along(point, changed)
    }

    return this.touch(changed)
  }

  /** The undo step for the stroke, or null when it changed nothing. */
  finish(label: string): HistoryEntry | null {
    return this.edit.finish(label)
  }

  /** How much the stroke laid over a raster area, 0 to 1 a pixel (opacity and the selection included). */
  coverage(rect: Rect): Float32Array {
    const out = new Float32Array(rect.width * rect.height)

    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) {
        const cover = this.cover.get(Math.floor(y / TILE) * this.columns + Math.floor(x / TILE))
        const built = cover ? cover[(y % TILE) * TILE + (x % TILE)] : 0

        if (built > 0) {
          out[(y - rect.y) * rect.width + (x - rect.x)] = built * this.settings.opacity * (this.selected(x, y) / 255)
        }
      }
    }

    return out
  }

  private along(point: Dab, changed: Rect | null): Rect | null {
    let area = changed

    for (const dab of this.placer.to(point.x, point.y, point.pressure)) {
      const rect = this.stamp(dab)

      if (rect) {
        area = unionRect(area, rect)
      }
    }

    return area
  }

  private touch(rect: Rect | null): Rect | null {
    if (rect) {
      this.raster.touch(rect)
      this.area = unionRect(this.area, rect)
    }

    return rect
  }

  /** Stamp one dab (raster coordinates); returns the pixels it could change. */
  private stamp(dab: Dab): Rect | null {
    const { raster, settings, ink } = this
    const radius = this.diameter(dab.pressure) / 2
    const reach = radius + 1
    const rect = clipRect({ x: dab.x - reach, y: dab.y - reach, width: reach * 2, height: reach * 2 }, raster.width, raster.height)

    if (!rect) {
      return null
    }

    this.edit.prepare(rect)
    const { data, width, channels } = raster
    const { sample } = ink
    const copied = this.copied
    let [r, g, b] = ink.colour
    let gray = this.gray

    for (let ty = Math.floor(rect.y / TILE); ty <= Math.floor((rect.y + rect.height - 1) / TILE); ty++) {
      for (let tx = Math.floor(rect.x / TILE); tx <= Math.floor((rect.x + rect.width - 1) / TILE); tx++) {
        const original = this.edit.original(tx * TILE, ty * TILE)!
        const key = ty * this.columns + tx
        let cover = this.cover.get(key)

        if (!cover) {
          cover = new Float32Array(TILE * TILE)
          this.cover.set(key, cover)
        }

        const x0 = Math.max(rect.x, tx * TILE)
        const x1 = Math.min(rect.x + rect.width, tx * TILE + original.rect.width)
        const y0 = Math.max(rect.y, ty * TILE)
        const y1 = Math.min(rect.y + rect.height, ty * TILE + original.rect.height)

        for (let y = y0; y < y1; y++) {
          const dy = y + 0.5 - dab.y

          for (let x = x0; x < x1; x++) {
            const dx = x + 0.5 - dab.x
            const alpha = dabAlpha(Math.sqrt(dx * dx + dy * dy), radius, settings.hardness) * settings.flow

            if (alpha <= 0) {
              continue
            }

            const local = (y - ty * TILE) * TILE + (x - tx * TILE)
            const built = cover[local] + alpha * (1 - cover[local])
            cover[local] = built
            let amount = built * settings.opacity * (this.selected(x, y) / 255)
            const o = (y * width + x) * channels
            const s = ((y - original.rect.y) * original.rect.width + (x - original.rect.x)) * channels

            if (sample) {
              sample(x, y, copied)
              amount *= copied[3] / 255
              r = copied[0]
              g = copied[1]
              b = copied[2]
              gray = copied[0]
            }

            if (channels === 1) {
              data[o] = original.pixels[s] + (gray - original.pixels[s]) * amount
            } else if (ink.erase) {
              data[o + 3] = original.pixels[s + 3] * (1 - amount)
            } else {
              const da = original.pixels[s + 3] / 255
              const outA = amount + da * (1 - amount)

              if (outA <= 0) {
                continue
              }

              const keep = da * (1 - amount)
              data[o] = (r * amount + original.pixels[s] * keep) / outA
              data[o + 1] = (g * amount + original.pixels[s + 1] * keep) / outA
              data[o + 2] = (b * amount + original.pixels[s + 2] * keep) / outA
              data[o + 3] = outA * 255
            }
          }
        }
      }
    }

    return rect
  }
}
