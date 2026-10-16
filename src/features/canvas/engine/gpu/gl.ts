/*
 * Small WebGL2 helpers for Veritas Canvas: programs with cached uniforms, render targets, and a
 * texture cache that uploads a raster once and afterwards only the part that changed. A raster
 * larger than the GPU's largest texture is held in pieces, uploaded as they come into view, with a
 * reduced copy of the whole for drawing it small.
 */

import { clipRect, type Raster, type Rect } from '../raster.ts'

/** A WebGL renderer that runs on the processor rather than a graphics chip. */
export const isSoftwareRenderer = (name: string): boolean => /swiftshader|llvmpipe|softpipe|software rasterizer|basic render driver/i.test(name)

/** The renderer's name, unmasked where the browser allows it. */
export function rendererName(gl: WebGL2RenderingContext): string {
  const info = gl.getExtension('WEBGL_debug_renderer_info')

  return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '')
}

export interface Target {
  texture: WebGLTexture
  framebuffer: WebGLFramebuffer
  width: number
  height: number
  /** Mipmap levels allocated (1 for none). */
  levels: number
  /** What it holds: colour, or whole-number pixel positions (jump flooding's nearest seeds). */
  format: 'precise' | 'bytes' | 'seeds'
}

export class Program {
  private readonly locations = new Map<string, WebGLUniformLocation | null>()

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly handle: WebGLProgram
  ) {}

  private at(name: string): WebGLUniformLocation | null {
    if (!this.locations.has(name)) {
      this.locations.set(name, this.gl.getUniformLocation(this.handle, name))
    }

    return this.locations.get(name)!
  }

  use(): this {
    this.gl.useProgram(this.handle)

    return this
  }

  int(name: string, value: number | boolean): this {
    this.gl.uniform1i(this.at(name), Number(value))

    return this
  }

  float(name: string, value: number): this {
    this.gl.uniform1f(this.at(name), value)

    return this
  }

  /** A whole uniform array from its first element. */
  floats(name: string, values: Float32Array | number[]): this {
    this.gl.uniform1fv(this.at(name), values)

    return this
  }

  uint(name: string, value: number): this {
    this.gl.uniform1ui(this.at(name), value >>> 0)

    return this
  }

  ivec2(name: string, x: number, y: number): this {
    this.gl.uniform2i(this.at(name), x, y)

    return this
  }

  vec2(name: string, x: number, y: number): this {
    this.gl.uniform2f(this.at(name), x, y)

    return this
  }

  vec3(name: string, x: number, y: number, z: number): this {
    this.gl.uniform3f(this.at(name), x, y, z)

    return this
  }

  vec4(name: string, x: number, y: number, z: number, w: number): this {
    this.gl.uniform4f(this.at(name), x, y, z, w)

    return this
  }

  /** A whole uniform array of vec4s from its first element, four numbers each. */
  vec4s(name: string, values: Float32Array | number[]): this {
    this.gl.uniform4fv(this.at(name), values)

    return this
  }

  mat3(name: string, value: Float32Array): this {
    this.gl.uniformMatrix3fv(this.at(name), false, value)

    return this
  }

  /** Bind a texture to a unit and point the sampler at it. */
  texture(name: string, unit: number, texture: WebGLTexture | null): this {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit)
    this.gl.bindTexture(this.gl.TEXTURE_2D, texture)
    this.gl.uniform1i(this.at(name), unit)

    return this
  }

  /** A 3D texture (a colour table) on a unit of its own: a unit holds one sampler type for a draw. */
  texture3d(name: string, unit: number, texture: WebGLTexture | null): this {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit)
    this.gl.bindTexture(this.gl.TEXTURE_3D, texture)
    this.gl.uniform1i(this.at(name), unit)

    return this
  }
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!
  gl.shaderSource(shader, source)
  gl.compileShader(shader)

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const message = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`Veritas Canvas shader did not compile: ${message}`)
  }

  return shader
}

export type Sampling = 'linear' | 'nearest' | 'mipmap'

/** Uploads and texture settings happen on this unit, which no shader samples, so they never disturb a draw's bindings. */
const SCRATCH_UNIT = 15

export class Gpu {
  readonly maxTextureSize: number
  /** Can targets hold half floats (smoother blending), or only 8 bits? */
  readonly halfFloat: boolean
  /** Drawn by the processor (SwiftShader, llvmpipe): every pixel is dear, so the view draws less while things move. */
  readonly software: boolean
  readonly renderer: string
  private readonly quad: WebGLVertexArrayObject
  private readonly programs = new Map<string, Program>()

  constructor(readonly gl: WebGL2RenderingContext) {
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE)
    this.renderer = rendererName(gl)
    this.software = isSoftwareRenderer(this.renderer)
    // Half floats are emulated on the processor, at twice the memory traffic: 8 bits are much quicker there.
    this.halfFloat = !this.software && Boolean(gl.getExtension('EXT_color_buffer_float'))
    gl.getExtension('OES_texture_float_linear')

    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
    this.quad = gl.createVertexArray()!
    gl.bindVertexArray(this.quad)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)
  }

  program(vertex: string, fragment: string): Program {
    const key = `${vertex}\n---\n${fragment}`
    let program = this.programs.get(key)

    if (!program) {
      const { gl } = this
      const handle = gl.createProgram()!
      gl.attachShader(handle, compile(gl, gl.VERTEX_SHADER, vertex))
      gl.attachShader(handle, compile(gl, gl.FRAGMENT_SHADER, fragment))
      gl.bindAttribLocation(handle, 0, 'a_unit')
      gl.linkProgram(handle)

      if (!gl.getProgramParameter(handle, gl.LINK_STATUS) && !gl.isContextLost()) {
        throw new Error(`Veritas Canvas shaders did not link: ${gl.getProgramInfoLog(handle)}`)
      }

      program = new Program(gl, handle)
      this.programs.set(key, program)
    }

    return program
  }

  drawQuad(): void {
    const { gl } = this
    gl.bindVertexArray(this.quad)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindVertexArray(null)
  }

  /** Bind a texture to change or fill it, away from the units draws sample. */
  bindScratch(texture: WebGLTexture | null): void {
    const { gl } = this
    gl.activeTexture(gl.TEXTURE0 + SCRATCH_UNIT)
    gl.bindTexture(gl.TEXTURE_2D, texture)
  }

  setSampling(texture: WebGLTexture, sampling: Sampling): void {
    const { gl } = this
    this.bindScratch(texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, sampling === 'nearest' ? gl.NEAREST : sampling === 'mipmap' ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, sampling === 'nearest' ? gl.NEAREST : gl.LINEAR)
  }

  /**
   * A texture to render into, transparent; `mipmaps` allocates levels for zoomed-out drawing. `seeds`
   * holds whole numbers (four 16-bit channels) rather than colour, and is only read with texelFetch.
   */
  createTarget(width: number, height: number, options: { mipmaps?: boolean; precise?: boolean; seeds?: boolean } = {}): Target {
    const { gl } = this
    const levels = options.mipmaps ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1
    const format: Target['format'] = options.seeds ? 'seeds' : options.precise !== false && this.halfFloat ? 'precise' : 'bytes'
    const texture = gl.createTexture()!
    this.bindScratch(texture)
    gl.texStorage2D(gl.TEXTURE_2D, levels, format === 'seeds' ? gl.RGBA16UI : format === 'precise' ? gl.RGBA16F : gl.RGBA8, width, height)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    // Whole-number textures cannot be filtered: anything but nearest leaves them unreadable.
    this.setSampling(texture, format === 'seeds' ? 'nearest' : 'linear')

    const framebuffer = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
    const target: Target = { texture, framebuffer, width, height, levels, format }
    this.clearBound(target)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    return target
  }

  private clearBound(target: Target | null): void {
    const { gl } = this

    if (target?.format === 'seeds') {
      gl.clearBufferuiv(gl.COLOR, 0, new Uint32Array(4))
    } else {
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
    }
  }

  /** A one-channel float texture of exact values (lookup tables), read with texelFetch. */
  floatTexture(width: number, height: number, data: Float32Array, reuse?: WebGLTexture | null): WebGLTexture {
    const { gl } = this
    const texture = reuse ?? gl.createTexture()!
    this.bindScratch(texture)

    if (!reuse) {
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, width, height)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      this.setSampling(texture, 'nearest')
    }

    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED, gl.FLOAT, data)

    return texture
  }

  /**
   * A colour table as a 3D texture, `size` entries a side of red, green and blue (red fastest), in
   * half floats so the hardware mixes the eight entries around a colour as the CPU reference does.
   */
  colourTable(size: number, data: Float32Array): WebGLTexture {
    const { gl } = this
    const texture = gl.createTexture()!
    gl.activeTexture(gl.TEXTURE0 + SCRATCH_UNIT)
    gl.bindTexture(gl.TEXTURE_3D, texture)
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, size, size, size, 0, gl.RGB, gl.FLOAT, data)

    for (const wrap of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) {
      gl.texParameteri(gl.TEXTURE_3D, wrap, gl.CLAMP_TO_EDGE)
    }

    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.bindTexture(gl.TEXTURE_3D, null)

    return texture
  }

  /** Limit drawing to a rectangle of the bound target (in its pixels, rows from the top), or lift the limit. */
  scissor(rect: Rect | null): void {
    const { gl } = this

    if (!rect) {
      gl.disable(gl.SCISSOR_TEST)

      return
    }

    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(rect.x, rect.y, rect.width, rect.height)
  }

  deleteTarget(target: Target | null | undefined): void {
    if (target) {
      this.gl.deleteFramebuffer(target.framebuffer)
      this.gl.deleteTexture(target.texture)
    }
  }

  /** Draw into a target (or the screen when null), clearing it first unless told otherwise; any scissor limit is lifted. */
  bindTarget(target: Target | null, width: number, height: number, clear = true): void {
    const { gl } = this
    gl.disable(gl.SCISSOR_TEST)
    gl.bindFramebuffer(gl.FRAMEBUFFER, target?.framebuffer ?? null)
    gl.viewport(0, 0, width, height)

    if (clear) {
      this.clearBound(target)
    }
  }

  /** Premultiplied source-over through the fixed blender (the fast path for Normal layers). */
  blendOver(on: boolean): void {
    const { gl } = this

    if (on) {
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    } else {
      gl.disable(gl.BLEND)
    }
  }

  /** Read a target's pixels (RGBA, 8 bits, rows from the top). */
  readPixels(target: Target, x = 0, y = 0, width = target.width, height = target.height): Uint8ClampedArray {
    const { gl } = this
    const out = new Uint8ClampedArray(width * height * 4)
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer)
    gl.readPixels(x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, out)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    return out
  }
}

/** A texture holding a raster, or one piece of a raster too large for a single texture. */
export interface Piece {
  texture: WebGLTexture
  /** The raster pixels the texture holds: the piece and a pixel of its neighbours on each side, so filtering shows no seams. */
  rect: Rect
  /** The pixels the piece stands for; pieces tile the raster without overlapping. */
  inner: Rect
}

interface Uploaded {
  texture: WebGLTexture
  version: number
  /** The raster pixels it holds: all of them, or one piece with its border. */
  rect: Rect
  /** Its own size: smaller than `rect` for the reduced copy of a raster past the GPU's largest texture. */
  width: number
  height: number
  levels: number
  /** The version its mipmaps were made from. */
  mipVersion: number
  usedAt: number
}

interface Held {
  /** The whole raster in one texture, reduced when it is too large for one. */
  whole?: Uploaded
  /** Full-size pieces of a raster too large for one texture, by row and column. */
  pieces: Map<number, Uploaded>
}

/** Side of the pieces a raster past the GPU's limit is held in. */
export const PIECE_SIZE = 2048

const intersect = (a: Rect, b: Rect): Rect | null => clipRect({ x: a.x - b.x, y: a.y - b.y, width: a.width, height: a.height }, b.width, b.height)

/** Textures for rasters: RGBA premultiplied on the way up, masks as one channel. */
export class RasterTextures {
  private readonly entries = new Map<Raster, Held>()
  private staging = new Uint8Array(0)
  private frame = 0

  constructor(private readonly gpu: Gpu) {}

  /** Start a frame: textures not used since the previous one can go at `sweep`. */
  beginFrame(): void {
    this.frame++
  }

  /** Is the raster past the GPU's largest texture (held in pieces at full size)? */
  tooBig(raster: Raster): boolean {
    return raster.width > this.gpu.maxTextureSize || raster.height > this.gpu.maxTextureSize
  }

  /** Raster pixels per pixel of its reduced copy: 1 for a raster that fits in one texture. */
  reduction(raster: Raster): number {
    return this.tooBig(raster) ? Math.max(raster.width, raster.height) / this.gpu.maxTextureSize : 1
  }

  /** The whole raster in one texture (a reduced copy when it is too large for one); mipmaps are made when asked for. */
  get(raster: Raster, mipmaps = false): WebGLTexture {
    const held = this.held(raster)
    const ratio = 1 / this.reduction(raster)
    const width = Math.max(1, Math.floor(raster.width * ratio))
    const height = Math.max(1, Math.floor(raster.height * ratio))
    held.whole = this.ensure(held.whole, raster.channels, raster.bounds, width, height, mipmaps)
    this.sync(raster, held.whole, mipmaps)

    return held.whole.texture
  }

  /**
   * What draws the raster at full size, covering at least `need` (raster pixels; all of it when
   * null): one texture when it fits, else the pieces that reach into `need`.
   */
  pieces(raster: Raster, need: Rect | null, mipmaps = false): Piece[] {
    if (!this.tooBig(raster)) {
      return [{ texture: this.get(raster, mipmaps), rect: raster.bounds, inner: raster.bounds }]
    }

    const held = this.held(raster)
    const area = need ? clipRect(need, raster.width, raster.height) : raster.bounds
    const out: Piece[] = []

    if (!area) {
      return out
    }

    const columns = Math.ceil(raster.width / PIECE_SIZE)

    for (let row = Math.floor(area.y / PIECE_SIZE); row * PIECE_SIZE < area.y + area.height; row++) {
      for (let column = Math.floor(area.x / PIECE_SIZE); column * PIECE_SIZE < area.x + area.width; column++) {
        const x = column * PIECE_SIZE
        const y = row * PIECE_SIZE
        const inner = { x, y, width: Math.min(PIECE_SIZE, raster.width - x), height: Math.min(PIECE_SIZE, raster.height - y) }
        const rect = clipRect({ x: x - 1, y: y - 1, width: inner.width + 2, height: inner.height + 2 }, raster.width, raster.height)!
        const key = row * columns + column
        const entry = this.ensure(held.pieces.get(key), raster.channels, rect, rect.width, rect.height, mipmaps)
        held.pieces.set(key, entry)
        this.sync(raster, entry, mipmaps)
        out.push({ texture: entry.texture, rect, inner })
      }
    }

    return out
  }

  private held(raster: Raster): Held {
    let held = this.entries.get(raster)

    if (!held) {
      held = { pieces: new Map() }
      this.entries.set(raster, held)
    }

    return held
  }

  /** An entry of this size, made (or made again with mipmap levels) when it has to be. */
  private ensure(entry: Uploaded | undefined, channels: 1 | 4, rect: Rect, width: number, height: number, mipmaps: boolean): Uploaded {
    if (entry && entry.width === width && entry.height === height && (!mipmaps || entry.levels > 1)) {
      return entry
    }

    if (entry) {
      this.gpu.gl.deleteTexture(entry.texture)
    }

    const { gl } = this.gpu
    const texture = gl.createTexture()!
    this.gpu.bindScratch(texture)
    const levels = mipmaps ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1
    gl.texStorage2D(gl.TEXTURE_2D, levels, channels === 4 ? gl.RGBA8 : gl.R8, width, height)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    this.gpu.setSampling(texture, 'linear')

    return { texture, version: -1, rect, width, height, levels, mipVersion: -1, usedAt: this.frame }
  }

  /** Bring an entry up to the raster's version (only what changed is uploaded), and its mipmaps when they are wanted. */
  private sync(raster: Raster, entry: Uploaded, mipmaps: boolean): void {
    entry.usedAt = this.frame

    if (entry.version !== raster.version) {
      const changed = entry.version < 0 ? null : raster.changedSince(entry.version)
      const area = intersect(changed ?? raster.bounds, entry.rect)

      if (area) {
        this.upload(raster, entry, { ...area, x: area.x + entry.rect.x, y: area.y + entry.rect.y })
      }

      entry.version = raster.version
    }

    if (mipmaps && entry.levels > 1 && entry.mipVersion !== raster.version) {
      this.gpu.bindScratch(entry.texture)
      this.gpu.gl.generateMipmap(this.gpu.gl.TEXTURE_2D)
      entry.mipVersion = raster.version
    }
  }

  /** Upload an area of the raster (raster pixels, inside the entry's rect). */
  private upload(raster: Raster, entry: Uploaded, area: Rect): void {
    const { gl } = this.gpu
    this.gpu.bindScratch(entry.texture)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)

    if (entry.width !== entry.rect.width || entry.height !== entry.rect.height) {
      this.uploadReduced(raster, entry, area)

      return
    }

    const x = area.x - entry.rect.x
    const y = area.y - entry.rect.y

    if (raster.channels === 1) {
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, raster.width)
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, area.x)
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, area.y)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, area.width, area.height, gl.RED, gl.UNSIGNED_BYTE, raster.data)
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0)
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0)
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0)

      return
    }

    const staging = this.stage(area.width * area.height * 4)

    for (let row = 0; row < area.height; row++) {
      const start = ((area.y + row) * raster.width + area.x) * 4
      staging.set(raster.data.subarray(start, start + area.width * 4), row * area.width * 4)
    }

    premultiplyInPlace(staging)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, area.width, area.height, gl.RGBA, gl.UNSIGNED_BYTE, staging)
  }

  /** The reduced copy over a changed area: each of its pixels the average of four raster pixels in its footprint. */
  private uploadReduced(raster: Raster, entry: Uploaded, area: Rect): void {
    const { gl } = this.gpu
    const fx = raster.width / entry.width
    const fy = raster.height / entry.height
    const x0 = Math.max(0, Math.floor(area.x / fx))
    const y0 = Math.max(0, Math.floor(area.y / fy))
    const x1 = Math.min(entry.width, Math.ceil((area.x + area.width) / fx))
    const y1 = Math.min(entry.height, Math.ceil((area.y + area.height) / fy))
    const width = x1 - x0
    const height = y1 - y0

    if (width <= 0 || height <= 0) {
      return
    }

    const { channels, data } = raster
    const staging = this.stage(width * height * channels)
    const sampleAt = (value: number, factor: number, limit: number, quarter: number) => Math.min(limit - 1, Math.floor((value + quarter) * factor))

    for (let y = 0; y < height; y++) {
      const ya = sampleAt(y0 + y, fy, raster.height, 0.25)
      const yb = sampleAt(y0 + y, fy, raster.height, 0.75)

      for (let x = 0; x < width; x++) {
        const xa = sampleAt(x0 + x, fx, raster.width, 0.25)
        const xb = sampleAt(x0 + x, fx, raster.width, 0.75)
        const d = (y * width + x) * channels
        const samples = [(ya * raster.width + xa) * channels, (ya * raster.width + xb) * channels, (yb * raster.width + xa) * channels, (yb * raster.width + xb) * channels]

        if (channels === 1) {
          staging[d] = (data[samples[0]] + data[samples[1]] + data[samples[2]] + data[samples[3]] + 2) >> 2
          continue
        }

        // Premultiplied while averaging, so transparent pixels add no colour.
        let r = 0
        let g = 0
        let b = 0
        let a = 0

        for (const s of samples) {
          const alpha = data[s + 3]
          r += data[s] * alpha
          g += data[s + 1] * alpha
          b += data[s + 2] * alpha
          a += alpha
        }

        staging[d] = Math.round(r / 1020)
        staging[d + 1] = Math.round(g / 1020)
        staging[d + 2] = Math.round(b / 1020)
        staging[d + 3] = Math.round(a / 4)
      }
    }

    gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, width, height, channels === 4 ? gl.RGBA : gl.RED, gl.UNSIGNED_BYTE, staging)
  }

  private stage(size: number): Uint8Array {
    if (this.staging.length < size) {
      this.staging = new Uint8Array(size)
    }

    return this.staging.subarray(0, size)
  }

  /** Free textures of rasters (and pieces) no frame has used lately. */
  sweep(keepFrames = 2): void {
    for (const [raster, held] of this.entries) {
      if (held.whole && this.frame - held.whole.usedAt >= keepFrames) {
        this.gpu.gl.deleteTexture(held.whole.texture)
        held.whole = undefined
      }

      for (const [key, entry] of held.pieces) {
        if (this.frame - entry.usedAt >= keepFrames) {
          this.gpu.gl.deleteTexture(entry.texture)
          held.pieces.delete(key)
        }
      }

      if (!held.whole && !held.pieces.size) {
        this.entries.delete(raster)
      }
    }
  }

  clear(): void {
    for (const held of this.entries.values()) {
      if (held.whole) {
        this.gpu.gl.deleteTexture(held.whole.texture)
      }

      held.pieces.forEach((entry) => this.gpu.gl.deleteTexture(entry.texture))
    }

    this.entries.clear()
  }
}

/** Straight to premultiplied alpha, rounding to nearest. */
export function premultiplyInPlace(data: Uint8Array | Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]

    if (a === 255) {
      continue
    }

    if (a === 0) {
      data[i] = data[i + 1] = data[i + 2] = 0
      continue
    }

    data[i] = (data[i] * a + 127) / 255
    data[i + 1] = (data[i + 1] * a + 127) / 255
    data[i + 2] = (data[i + 2] * a + 127) / 255
  }
}
