/*
 * What the Clone Stamp and the Healing Brush copy, and the Healing Brush's finish. A stroke copies
 * from a fixed distance away: from the layer painted on as it was before the stroke (so a stroke
 * never copies itself), or from a picture of every layer taken when it started.
 */

import type { Vec2 } from '../../../../shared/canvas/comp-format.ts'
import { invert, type Mat } from './geometry.ts'
import { heal } from './heal-blend.ts'
import type { PixelEdit } from './history.ts'
import type { Stroke } from './paint.ts'
import { clipRect, type Raster } from './raster.ts'
import { sampleBilinear } from './sampling.ts'

/** Writes the straight RGBA at a raster pixel into `out` (a mask's gray in the colour, 255 in alpha). */
export type PixelReader = (x: number, y: number, out: Uint8ClampedArray) => void

/** A raster's pixels as they were before an edit: the kept tile where there is one, the raster elsewhere. Outside is clear. */
export function beforeEdit(edit: PixelEdit, raster: Raster): PixelReader {
  const { width, height, channels, data } = raster

  return (x, y, out) => {
    if (x < 0 || y < 0 || x >= width || y >= height) {
      out.fill(0)

      return
    }

    const tile = edit.original(x, y)
    const pixels = tile ? tile.pixels : data
    const i = tile ? ((y - tile.rect.y) * tile.rect.width + (x - tile.rect.x)) * channels : (y * width + x) * channels

    if (channels === 1) {
      out[0] = out[1] = out[2] = pixels[i]
      out[3] = 255

      return
    }

    out[0] = pixels[i]
    out[1] = pixels[i + 1]
    out[2] = pixels[i + 2]
    out[3] = pixels[i + 3]
  }
}

/**
 * What a stroke copies onto each pixel of the raster placed by `toDocument`, from `offset` document
 * pixels away: the raster itself as it was before the edit (whole pixels, the distance turned into
 * the raster's own), or `picture`, every layer together at document size.
 */
export function copier(raster: Raster, toDocument: Mat, offset: Vec2, picture: Raster | null, edit: PixelEdit): PixelReader {
  const m = toDocument

  if (!picture) {
    const back = invert(m)
    const dx = Math.round(back.a * offset[0] + back.c * offset[1])
    const dy = Math.round(back.b * offset[0] + back.d * offset[1])
    const read = beforeEdit(edit, raster)

    return (x, y, out) => read(x + dx, y + dy, out)
  }

  return (x, y, out) => {
    const px = m.a * (x + 0.5) + m.c * (y + 0.5) + m.e + offset[0]
    const py = m.b * (x + 0.5) + m.d * (y + 0.5) + m.f + offset[1]
    sampleBilinear(picture, px - 0.5, py - 0.5, out)
  }
}

/** Heal a finished stroke whose ink came from `copy`: the copy takes on the colour and tone of the pixels just around the stroke. */
export function healStroke(stroke: Stroke, copy: PixelReader): void {
  const { raster, area } = stroke
  const rect = area && clipRect({ x: area.x - 2, y: area.y - 2, width: area.width + 4, height: area.height + 4 }, raster.width, raster.height)

  if (!rect || raster.channels !== 4) {
    return
  }

  const { width, height } = rect
  const before = beforeEdit(stroke.edit, raster)
  const destination = new Uint8ClampedArray(width * height * 4)
  const copied = new Uint8ClampedArray(width * height * 4)
  const pixel = new Uint8ClampedArray(4)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      before(rect.x + x, rect.y + y, pixel)
      destination.set(pixel, o)
      copy(rect.x + x, rect.y + y, pixel)
      copied.set(pixel, o)
    }
  }

  stroke.edit.prepare(rect)
  raster.write(rect, heal(destination, copied, stroke.coverage(rect), width, height))
  raster.touch(rect)
}
