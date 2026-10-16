/*
 * Pixels for Veritas Canvas: RGBA layers in straight (not premultiplied) alpha, or one-channel masks
 * and selections, 8 bits a channel. Every change bumps `version` and is logged, so each GPU context
 * re-uploads only what changed since it last looked.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export const rectsIntersect = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

export function unionRect(a: Rect | null, b: Rect): Rect {
  if (!a) {
    return { ...b }
  }

  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)

  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y }
}

/** A rectangle cut to the bounds, rounded out to whole pixels; null when nothing is left. */
export function clipRect(rect: Rect, width: number, height: number): Rect | null {
  const x0 = Math.max(0, Math.floor(rect.x))
  const y0 = Math.max(0, Math.floor(rect.y))
  const x1 = Math.min(width, Math.ceil(rect.x + rect.width))
  const y1 = Math.min(height, Math.ceil(rect.y + rect.height))

  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null
}

let nextRasterId = 1
const LOG_LENGTH = 64

export class Raster {
  readonly id = nextRasterId++
  version = 1
  private log: { version: number; rect: Rect }[] = []

  constructor(
    readonly width: number,
    readonly height: number,
    readonly channels: 1 | 4 = 4,
    readonly data: Uint8ClampedArray = new Uint8ClampedArray(width * height * channels)
  ) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new Error(`A raster needs a whole size, got ${width}×${height}`)
    }

    if (data.length !== width * height * channels) {
      throw new Error(`A ${width}×${height} raster needs ${width * height * channels} values, got ${data.length}`)
    }
  }

  get bounds(): Rect {
    return { x: 0, y: 0, width: this.width, height: this.height }
  }

  /** Mark pixels changed (all of them by default). */
  touch(rect: Rect = this.bounds): void {
    const clipped = clipRect(rect, this.width, this.height)

    if (clipped) {
      this.version++
      this.log.push({ version: this.version, rect: clipped })

      if (this.log.length > LOG_LENGTH) {
        this.log.shift()
      }
    }
  }

  /** What changed after `version`: an area (empty when nothing did), or null when it may be all of it. */
  changedSince(version: number): Rect | null {
    if (version >= this.version) {
      return { x: 0, y: 0, width: 0, height: 0 }
    }

    if (!this.log.length || this.log[0].version > version + 1) {
      return null
    }

    let area: Rect | null = null

    for (const entry of this.log) {
      if (entry.version > version) {
        area = unionRect(area, entry.rect)
      }
    }

    return area
  }

  clone(): Raster {
    return new Raster(this.width, this.height, this.channels, new Uint8ClampedArray(this.data))
  }

  /** A filled raster: an RGBA colour for layers, or one value (0 to 255) for masks. */
  static filled(width: number, height: number, value: number | [number, number, number, number], channels: 1 | 4 = 4): Raster {
    const raster = new Raster(width, height, channels)

    if (channels === 1) {
      raster.data.fill(typeof value === 'number' ? value : value[3])
    } else {
      const [r, g, b, a] = typeof value === 'number' ? [value, value, value, 255] : value

      for (let i = 0; i < raster.data.length; i += 4) {
        raster.data[i] = r
        raster.data[i + 1] = g
        raster.data[i + 2] = b
        raster.data[i + 3] = a
      }
    }

    return raster
  }

  /** A copy of a rectangle's pixels (rows packed). */
  read(rect: Rect): Uint8ClampedArray {
    const { x, y, width, height } = rect
    const out = new Uint8ClampedArray(width * height * this.channels)
    const stride = this.width * this.channels

    for (let row = 0; row < height; row++) {
      const start = (y + row) * stride + x * this.channels
      out.set(this.data.subarray(start, start + width * this.channels), row * width * this.channels)
    }

    return out
  }

  /** Put packed pixels back into a rectangle (marks it changed). */
  write(rect: Rect, pixels: Uint8ClampedArray): void {
    const { x, y, width, height } = rect
    const stride = this.width * this.channels

    for (let row = 0; row < height; row++) {
      this.data.set(pixels.subarray(row * width * this.channels, (row + 1) * width * this.channels), (y + row) * stride + x * this.channels)
    }

    this.touch(rect)
  }

  crop(rect: Rect): Raster {
    const inside = clipRect(rect, this.width, this.height)
    const out = new Raster(Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height)), this.channels)

    if (inside) {
      const pixels = this.read(inside)
      const dx = inside.x - Math.round(rect.x)
      const dy = inside.y - Math.round(rect.y)

      for (let row = 0; row < inside.height; row++) {
        out.data.set(pixels.subarray(row * inside.width * this.channels, (row + 1) * inside.width * this.channels), ((dy + row) * out.width + dx) * this.channels)
      }
    }

    return out
  }

  /** Mirror in place. */
  flip(horizontal: boolean): void {
    const { width, height, channels, data } = this
    const pixel = new Uint8ClampedArray(channels)

    if (horizontal) {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width >> 1; x++) {
          const a = (y * width + x) * channels
          const b = (y * width + (width - 1 - x)) * channels
          pixel.set(data.subarray(a, a + channels))
          data.copyWithin(a, b, b + channels)
          data.set(pixel, b)
        }
      }
    } else {
      const stride = width * channels
      const row = new Uint8ClampedArray(stride)

      for (let y = 0; y < height >> 1; y++) {
        const a = y * stride
        const b = (height - 1 - y) * stride
        row.set(data.subarray(a, a + stride))
        data.copyWithin(a, b, b + stride)
        data.set(row, b)
      }
    }

    this.touch()
  }

  /** The smallest rectangle holding every pixel above `threshold` alpha (or mask value); null when empty. */
  opaqueBounds(threshold = 0): Rect | null {
    const { width, height, channels, data } = this
    const offset = channels === 4 ? 3 : 0
    let minX = width
    let minY = height
    let maxX = -1
    let maxY = -1

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * channels + offset] > threshold) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }

    return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
  }

  /** Is every value the same? (A uniform mask needs no full-size pixels.) */
  uniformValue(): number | null {
    if (this.channels !== 1) {
      return null
    }

    const first = this.data[0]

    for (let i = 1; i < this.data.length; i++) {
      if (this.data[i] !== first) {
        return null
      }
    }

    return first
  }
}

/** Resample to a new size: area averaging when shrinking, bilinear when enlarging. */
export function resample(source: Raster, width: number, height: number): Raster {
  const out = new Raster(width, height, source.channels)
  const { channels } = source
  const scaleX = source.width / width
  const scaleY = source.height / height

  if (scaleX >= 1 && scaleY >= 1) {
    // Box filter: each output pixel averages the source pixels it covers, weighted by coverage,
    // with colour weighted by alpha so transparent pixels do not darken edges.
    for (let y = 0; y < height; y++) {
      const sy0 = y * scaleY
      const sy1 = sy0 + scaleY

      for (let x = 0; x < width; x++) {
        const sx0 = x * scaleX
        const sx1 = sx0 + scaleX
        const sums = [0, 0, 0, 0]
        let total = 0

        for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy++) {
          const wy = Math.min(sy + 1, sy1) - Math.max(sy, sy0)

          for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx++) {
            const w = (Math.min(sx + 1, sx1) - Math.max(sx, sx0)) * wy
            const i = (Math.min(source.height - 1, sy) * source.width + Math.min(source.width - 1, sx)) * channels

            if (channels === 1) {
              sums[0] += source.data[i] * w
            } else {
              const a = source.data[i + 3] * w
              sums[0] += source.data[i] * a
              sums[1] += source.data[i + 1] * a
              sums[2] += source.data[i + 2] * a
              sums[3] += a
            }

            total += w
          }
        }

        const o = (y * width + x) * channels

        if (channels === 1) {
          out.data[o] = sums[0] / total
        } else {
          out.data[o + 3] = sums[3] / total
          out.data[o] = sums[3] ? sums[0] / sums[3] : 0
          out.data[o + 1] = sums[3] ? sums[1] / sums[3] : 0
          out.data[o + 2] = sums[3] ? sums[2] / sums[3] : 0
        }
      }
    }

    return out
  }

  for (let y = 0; y < height; y++) {
    const fy = Math.max(0, Math.min(source.height - 1, (y + 0.5) * scaleY - 0.5))
    const y0 = Math.floor(fy)
    const y1 = Math.min(source.height - 1, y0 + 1)
    const ty = fy - y0

    for (let x = 0; x < width; x++) {
      const fx = Math.max(0, Math.min(source.width - 1, (x + 0.5) * scaleX - 0.5))
      const x0 = Math.floor(fx)
      const x1 = Math.min(source.width - 1, x0 + 1)
      const tx = fx - x0
      const corners = [
        [(y0 * source.width + x0) * channels, (1 - tx) * (1 - ty)],
        [(y0 * source.width + x1) * channels, tx * (1 - ty)],
        [(y1 * source.width + x0) * channels, (1 - tx) * ty],
        [(y1 * source.width + x1) * channels, tx * ty]
      ] as const
      const o = (y * width + x) * channels

      if (channels === 1) {
        out.data[o] = corners.reduce((sum, [i, w]) => sum + source.data[i] * w, 0)
      } else {
        let alpha = 0
        const colour = [0, 0, 0]

        for (const [i, w] of corners) {
          const a = source.data[i + 3] * w
          alpha += a
          colour[0] += source.data[i] * a
          colour[1] += source.data[i + 1] * a
          colour[2] += source.data[i + 2] * a
        }

        out.data[o + 3] = alpha
        out.data[o] = alpha ? colour[0] / alpha : 0
        out.data[o + 1] = alpha ? colour[1] / alpha : 0
        out.data[o + 2] = alpha ? colour[2] / alpha : 0
      }
    }
  }

  return out
}
