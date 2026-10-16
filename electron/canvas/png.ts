import fs from 'node:fs/promises'
import zlib from 'node:zlib'

/*
 * PNG for Veritas Canvas projects: layers are 8-bit RGBA and masks 8-bit grayscale, exactly as the
 * format asks (a browser canvas can only write RGBA, and may drop alpha from opaque images). The
 * decoder covers what this encoder writes plus the common 8-bit kinds; anything else is decoded by
 * the renderer, which reads every PNG Chromium does.
 */

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)

  for (let n = 0; n < 256; n++) {
    let c = n

    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }

    table[n] = c >>> 0
  }

  return table
})()

function crc32(buffers: Buffer[]): number {
  let crc = 0xffffffff

  for (const buffer of buffers) {
    for (let i = 0; i < buffer.length; i++) {
      crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
    }
  }

  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32([head.subarray(4), data]), 0)

  return Buffer.concat([head, data, tail])
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)

  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Images up to this many bytes pick each row's filter; larger ones use Paeth throughout. */
const ADAPTIVE_BYTES = 4_000_000

/**
 * Filtered scanlines. Each row takes the filter that leaves the smallest absolute sum (the usual
 * heuristic); large images use Paeth throughout, which is nearly as small at a fifth of the work.
 * `above` is the row before the first one, for an image filtered a band at a time.
 */
function filterRows(data: ArrayLike<number>, width: number, height: number, channels: number, above: ArrayLike<number> | null = null, adaptive = width * channels * height <= ADAPTIVE_BYTES): Buffer {
  const stride = width * channels
  const out = Buffer.alloc((stride + 1) * height)
  const candidates = Array.from({ length: 5 }, () => Buffer.alloc(stride))
  const upAt = (y: number, i: number) => (y > 0 ? data[(y - 1) * stride + i] : above ? above[i] : 0)
  const first = above ? 4 : 1

  for (let y = 0; y < height; y++) {
    const row = y * stride
    const hasUp = y > 0 || Boolean(above)
    let best = adaptive ? 0 : y === 0 ? first : 4
    let bestSum = Infinity

    for (let filter = 0; adaptive && filter < 5; filter++) {
      const line = candidates[filter]
      let sum = 0

      for (let i = 0; i < stride; i++) {
        const value = data[row + i]
        const left = i >= channels ? data[row + i - channels] : 0
        const up = hasUp ? upAt(y, i) : 0
        const upLeft = hasUp && i >= channels ? upAt(y, i - channels) : 0
        const predicted = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, upLeft)
        const residual = (value - predicted) & 0xff
        line[i] = residual
        sum += residual < 128 ? residual : 256 - residual

        if (sum >= bestSum) {
          break
        }
      }

      if (sum < bestSum) {
        bestSum = sum
        best = filter
      }
    }

    out[y * (stride + 1)] = best
    // Recompute the winner in full: the loop above may have stopped early once it lost.
    const line = candidates[best]

    for (let i = 0; i < stride; i++) {
      const value = data[row + i]
      const left = i >= channels ? data[row + i - channels] : 0
      const up = hasUp ? upAt(y, i) : 0
      const upLeft = hasUp && i >= channels ? upAt(y, i - channels) : 0
      const predicted = best === 0 ? 0 : best === 1 ? left : best === 2 ? up : best === 3 ? (left + up) >> 1 : paeth(left, up, upLeft)
      line[i] = (value - predicted) & 0xff
    }

    line.copy(out, y * (stride + 1) + 1)
  }

  return out
}

export interface PngImage {
  width: number
  height: number
  /** 1 (grayscale), 2 (grayscale and alpha), 3 (RGB) or 4 (RGBA). */
  channels: 1 | 2 | 3 | 4
  data: Uint8Array
}

/** The signature and header chunks of an 8-bit PNG: RGBA for 4 channels, grayscale for 1; `ppi` adds the resolution (pHYs). */
function pngHead(width: number, height: number, channels: 1 | 4, ppi?: number): Buffer[] {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = channels === 4 ? 6 : 0
  const chunks = [SIGNATURE, chunk('IHDR', header)]

  if (ppi && Number.isFinite(ppi) && ppi > 0) {
    const physical = Buffer.alloc(9)
    const perMetre = Math.round(ppi / 0.0254)
    physical.writeUInt32BE(perMetre, 0)
    physical.writeUInt32BE(perMetre, 4)
    physical[8] = 1
    chunks.push(chunk('pHYs', physical))
  }

  return chunks
}

/** An 8-bit PNG: RGBA for 4 channels, grayscale for 1; `ppi` adds the resolution (pHYs). */
export function encodePng(image: { width: number; height: number; channels: 1 | 4; data: ArrayLike<number> }, ppi?: number): Buffer {
  const { width, height, channels, data } = image

  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || data.length !== width * height * channels) {
    throw new Error(`a ${width}×${height} PNG needs ${width * height * channels} bytes, got ${data.length}`)
  }

  return Buffer.concat([...pngHead(width, height, channels, ppi), chunk('IDAT', zlib.deflateSync(filterRows(data, width, height, channels), { level: 6 })), chunk('IEND', Buffer.alloc(0))])
}

/**
 * A PNG written to a file a band of rows at a time, so an export as large as the format allows
 * never sits whole in memory: rows are filtered, run through one deflate stream, and written as
 * IDAT chunks as the compressed data comes out.
 */
export class PngStream {
  private readonly deflate = zlib.createDeflate({ level: 6 })
  private readonly compressed: Buffer[] = []
  private above: Buffer | null = null
  private rows = 0
  private failure: Error | null = null
  private readonly ended: Promise<void>

  private constructor(
    private readonly file: fs.FileHandle,
    readonly width: number,
    readonly height: number,
    private readonly channels: 1 | 4
  ) {
    this.deflate.on('data', (data: Buffer) => this.compressed.push(data))
    this.deflate.on('error', (error: Error) => (this.failure = error))
    this.ended = new Promise((resolve) => this.deflate.once('end', resolve))
  }

  static async open(target: string, width: number, height: number, channels: 1 | 4, ppi?: number): Promise<PngStream> {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new Error(`a PNG is a whole number of pixels a side, not ${width}×${height}`)
    }

    const file = await fs.open(target, 'w')
    const stream = new PngStream(file, width, height, channels)
    await file.write(Buffer.concat(pngHead(width, height, channels, ppi)))

    return stream
  }

  /** The next whole rows, top to bottom. */
  async write(data: Uint8Array): Promise<void> {
    const stride = this.width * this.channels

    if (data.length % stride || this.rows + data.length / stride > this.height) {
      throw new Error(`rows of a ${this.width}-pixel-wide PNG come ${stride} bytes each, and it has ${this.height - this.rows} left`)
    }

    const count = data.length / stride
    const filtered = filterRows(data, this.width, count, this.channels, this.above, this.width * this.channels * this.height <= ADAPTIVE_BYTES)
    this.above = Buffer.from(data.subarray(data.length - stride))
    this.rows += count
    await new Promise<void>((resolve, reject) => this.deflate.write(filtered, (error) => (error ? reject(error) : resolve())))
    await this.flush()
  }

  /** Write what has been compressed so far as IDAT chunks. */
  private async flush(): Promise<void> {
    if (this.failure) {
      throw this.failure
    }

    if (this.compressed.length) {
      const data = Buffer.concat(this.compressed.splice(0))
      await this.file.write(chunk('IDAT', data))
    }
  }

  /** Finish the file once every row is in. */
  async finish(): Promise<void> {
    if (this.rows !== this.height) {
      throw new Error(`the PNG has ${this.rows} of its ${this.height} rows`)
    }

    this.deflate.end()
    await this.ended
    await this.flush()
    await this.file.write(chunk('IEND', Buffer.alloc(0)))
    await this.file.close()
  }

  async abort(): Promise<void> {
    this.deflate.destroy()
    await this.file.close().catch(() => {})
  }
}

/** Decoded pixels as RGBA (4) or one gray value a pixel (1, for masks: colour averaged, times alpha). */
export function toChannels(image: PngImage, channels: 1 | 4): Uint8Array {
  const { width, height, data } = image
  const from = image.channels

  if (from === channels) {
    return data
  }

  const count = width * height
  const out = new Uint8Array(count * channels)

  for (let i = 0; i < count; i++) {
    const s = i * from
    const gray = from < 3
    const r = data[s]
    const g = gray ? r : data[s + 1]
    const b = gray ? r : data[s + 2]
    const a = from === 2 ? data[s + 1] : from === 4 ? data[s + 3] : 255

    if (channels === 4) {
      out[i * 4] = r
      out[i * 4 + 1] = g
      out[i * 4 + 2] = b
      out[i * 4 + 3] = a
    } else {
      out[i] = Math.round((((r + g + b) / 3) * a) / 255)
    }
  }

  return out
}

/** Decode an 8-bit, non-interlaced PNG (grayscale, gray+alpha, RGB, RGBA or palette). */
export function decodePng(buffer: Uint8Array): PngImage {
  const bytes = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)

  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('not a PNG')
  }

  let offset = 8
  let width = 0
  let height = 0
  let colorType = -1
  let palette: Buffer | null = null
  let transparency: Buffer | null = null
  const idat: Buffer[] = []

  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length

    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      colorType = data[9]

      if (data[8] !== 8 || data[12] !== 0) {
        throw new Error('only 8-bit, non-interlaced PNGs decode here')
      }
    } else if (type === 'PLTE') {
      palette = data
    } else if (type === 'tRNS') {
      transparency = data
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
  }

  const sourceChannels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0

  if (!sourceChannels || !width || !height) {
    throw new Error('unsupported PNG')
  }

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * sourceChannels
  const pixels = new Uint8Array(stride * height)

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = y * (stride + 1) + 1

    for (let i = 0; i < stride; i++) {
      const left = i >= sourceChannels ? pixels[y * stride + i - sourceChannels] : 0
      const up = y > 0 ? pixels[(y - 1) * stride + i] : 0
      const upLeft = y > 0 && i >= sourceChannels ? pixels[(y - 1) * stride + i - sourceChannels] : 0
      const predicted = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, upLeft)
      pixels[y * stride + i] = (raw[line + i] + predicted) & 0xff
    }
  }

  if (colorType !== 3) {
    return { width, height, channels: sourceChannels as PngImage['channels'], data: pixels }
  }

  if (!palette) {
    throw new Error('palette PNG without a palette')
  }

  const rgba = new Uint8Array(width * height * 4)

  for (let i = 0; i < width * height; i++) {
    const index = pixels[i]
    rgba[i * 4] = palette[index * 3]
    rgba[i * 4 + 1] = palette[index * 3 + 1]
    rgba[i * 4 + 2] = palette[index * 3 + 2]
    rgba[i * 4 + 3] = transparency && index < transparency.length ? transparency[index] : 255
  }

  return { width, height, channels: 4, data: rgba }
}

/** Pixel size of a PNG from its header, without decoding it. */
export function pngSize(buffer: Uint8Array): { width: number; height: number } | null {
  const bytes = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)

  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(SIGNATURE) || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    return null
  }

  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}
