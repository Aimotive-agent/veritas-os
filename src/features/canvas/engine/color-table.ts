/*
 * Colour lookup tables for the Color Lookup adjustment: 3D tables read from `.cube` files (the
 * text format most grading tools write), and a colour looked up in one between its eight nearest
 * entries. The project keeps the file as it was read, beside the layer's images.
 */

import { HERALD_RANGES } from '../../../../shared/canvas/comp-format.ts'
import type { RGB3 } from './adjust-math.ts'

export interface ColorTable {
  /** Entries along each side. */
  size: number
  /** size³ colours, red, green and blue in turn: red changes fastest, then green, then blue, as `.cube` files list them. */
  data: Float32Array
  /** The input colours the table spans; colours outside are held to it. */
  domainMin: RGB3
  domainMax: RGB3
  title: string
  /** The file as it was read, which the project keeps. */
  bytes: Uint8Array
}

/** The largest `.cube` file read: a 65-entry table written with plenty of digits. */
export const TABLE_FILE_BYTES = 64 * 1024 * 1024

const triple = (words: string[], line: number, what: string): RGB3 => {
  const values = words.map(Number)

  if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) {
    throw new Error(`Line ${line} of the table should hold three numbers for ${what}`)
  }

  return values as RGB3
}

/** A `.cube` file's 3D table; throws with what is wrong when the file is not one Veritas reads. */
export function parseCube(bytes: Uint8Array): ColorTable {
  if (bytes.byteLength > TABLE_FILE_BYTES) {
    throw new Error(`The table file is larger than ${TABLE_FILE_BYTES / 1024 / 1024} MB`)
  }

  const text = new TextDecoder().decode(bytes)
  let size = 0
  let title = ''
  let domainMin: RGB3 = [0, 0, 0]
  let domainMax: RGB3 = [1, 1, 1]
  let data: Float32Array | null = null
  let count = 0
  const lines = text.split(/\r\n|\r|\n/)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()

    if (!line || line.startsWith('#')) {
      continue
    }

    const words = line.split(/\s+/)
    const keyword = words[0].toUpperCase()

    if (/^[-+.\d]/.test(keyword)) {
      if (!data) {
        throw new Error('The table lists colours before its LUT_3D_SIZE')
      }

      if (count >= size ** 3) {
        throw new Error(`The table holds more than the ${size}×${size}×${size} colours its LUT_3D_SIZE gives`)
      }

      data.set(triple(words, i + 1, 'a colour'), count * 3)
      count++
    } else if (keyword === 'TITLE') {
      title = line
        .slice(5)
        .trim()
        .replace(/^"(.*)"$/, '$1')
    } else if (keyword === 'LUT_3D_SIZE') {
      size = Number(words[1])
      const [least, most] = HERALD_RANGES.tableSize

      if (!Number.isInteger(size) || size < least || size > most) {
        throw new Error(`Color Lookup takes tables of ${least} to ${most} entries a side, not ${words[1] ?? 'none'}`)
      }

      data = new Float32Array(size ** 3 * 3)
    } else if (keyword === 'LUT_1D_SIZE') {
      throw new Error('This file holds a 1D table (one curve a channel); Color Lookup takes 3D tables')
    } else if (keyword === 'DOMAIN_MIN') {
      domainMin = triple(words.slice(1), i + 1, 'DOMAIN_MIN')
    } else if (keyword === 'DOMAIN_MAX') {
      domainMax = triple(words.slice(1), i + 1, 'DOMAIN_MAX')
    } else if (keyword === 'LUT_3D_INPUT_RANGE') {
      const [low, high] = words.slice(1).map(Number)

      if (!Number.isFinite(low) || !Number.isFinite(high)) {
        throw new Error(`Line ${i + 1}: LUT_3D_INPUT_RANGE needs two numbers`)
      }

      domainMin = [low, low, low]
      domainMax = [high, high, high]
    }
    // Other keywords (LUT_IN_VIDEO_RANGE and the like) leave the colours as they are.
  }

  if (!data) {
    throw new Error('This is not a 3D .cube table: it has no LUT_3D_SIZE line')
  }

  if (count !== size ** 3) {
    throw new Error(`The table holds ${count.toLocaleString('en')} colours where its LUT_3D_SIZE of ${size} needs ${(size ** 3).toLocaleString('en')}`)
  }

  if (domainMin.some((low, i) => !(domainMax[i] > low))) {
    throw new Error('The table’s DOMAIN_MAX must be above its DOMAIN_MIN on every channel')
  }

  return { size, data, domainMin, domainMax, title, bytes }
}

/** Where a colour falls in the table, 0 to 1 a channel (the domain stretched to it, and held inside). */
export function tablePosition(c: RGB3, table: ColorTable): RGB3 {
  return c.map((value, i) => Math.min(1, Math.max(0, (value - table.domainMin[i]) / (table.domainMax[i] - table.domainMin[i])))) as RGB3
}

/** A colour looked up in a table, mixed from its eight nearest entries; what the table gives is held to 0 to 1. */
export function lookUp(c: RGB3, table: ColorTable): RGB3 {
  const { size, data } = table
  const last = size - 1
  const [x, y, z] = tablePosition(c, table).map((value) => value * last)
  const x0 = Math.min(last - 1, Math.floor(x))
  const y0 = Math.min(last - 1, Math.floor(y))
  const z0 = Math.min(last - 1, Math.floor(z))
  const [tx, ty, tz] = [x - x0, y - y0, z - z0]
  const at = (i: number, j: number, k: number, channel: number) => data[((k * size + j) * size + i) * 3 + channel]
  const out: RGB3 = [0, 0, 0]

  for (let channel = 0; channel < 3; channel++) {
    const c00 = at(x0, y0, z0, channel) * (1 - tx) + at(x0 + 1, y0, z0, channel) * tx
    const c10 = at(x0, y0 + 1, z0, channel) * (1 - tx) + at(x0 + 1, y0 + 1, z0, channel) * tx
    const c01 = at(x0, y0, z0 + 1, channel) * (1 - tx) + at(x0 + 1, y0, z0 + 1, channel) * tx
    const c11 = at(x0, y0 + 1, z0 + 1, channel) * (1 - tx) + at(x0 + 1, y0 + 1, z0 + 1, channel) * tx
    const value = (c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz
    out[channel] = Math.min(1, Math.max(0, value))
  }

  return out
}

/** A table written out as a `.cube` file (for tables made here, such as tests and an identity table). */
export function cubeText(size: number, colour: (r: number, g: number, b: number) => RGB3, title = 'Veritas Canvas'): string {
  const rows = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`]

  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        rows.push(
          colour(r / (size - 1), g / (size - 1), b / (size - 1))
            .map((value) => value.toFixed(6))
            .join(' ')
        )
      }
    }
  }

  return `${rows.join('\n')}\n`
}
