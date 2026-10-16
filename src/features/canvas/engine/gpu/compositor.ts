/*
 * The Veritas Canvas compositor: a document's layers drawn bottom to top on the GPU. Folders are
 * pass-through: they draw nothing themselves, and their opacity and mask multiply into every layer
 * inside them. A clipped layer is multiplied by its base's coverage (the base's pixels, opacity and
 * mask, but not its visibility or its folders). Normal layers go straight onto the backdrop through
 * the fixed blender; other modes are blended in a shader, ping-ponging between two targets. A
 * render covers the whole frame (the document at a scale) or any area of it: the part of the view
 * on screen, or one tile of an export.
 */

import { LIMITS } from '../../../../../shared/canvas/comp-format.ts'
import { ancestorsOf, type CanvasLayer, type DocState, findLayer, isShown } from '../document.ts'
import { apply, invert, type Mat, multiply, pixelToDocument, scale as scaleMat, toMat3, translate, unitToDocument } from '../geometry.ts'
import { clipRect, Raster, type Rect } from '../raster.ts'
import { filterReach, frameSize, planTiles, TILE_ALIGN, tileSide } from '../tiles.ts'
import { AdjustmentPass } from './adjustments.ts'
import { EffectsPass } from './effects.ts'
import { Filters } from './filters.ts'
import { Gpu, type Piece, type Program, RasterTextures, type Sampling, type Target } from './gl.ts'
import { BLEND_FRAGMENT, blendModeIndex, COPY_FRAGMENT, COVERAGE_FRAGMENT, FULL_VERTEX, LAYER_FRAGMENT, PLACE_VERTEX, WHOLE } from './shaders.ts'

export interface RenderOptions {
  /** Target pixels per document pixel: below 1 for previews and thumbnails. */
  scale?: number
  /**
   * The part of the frame (the document at `scale`) to draw, in its pixels, at most the GPU's
   * largest texture a side; all of it by default, shrunk to fit the GPU when it is larger.
   */
  area?: Rect
  /** Quicker and rougher, while something moves: layers drawn small are not mipmapped. */
  draft?: boolean
  /** Draw only these layers. */
  only?: ReadonlySet<string>
  /** Changes to layers for this render only (a merge drawing a layer at full opacity). */
  overrides?: ReadonlyMap<string, Partial<CanvasLayer>>
  /** Ignore enclosing folders: their visibility, opacity and masks. */
  isolated?: boolean
  /** Draw hidden layers too. */
  includeHidden?: boolean
}

export interface Rendered {
  target: Target
  /** The size drawn, which the scale, the area and the GPU's largest texture decide. */
  width: number
  height: number
  scale: number
  /** The part of the frame it holds, in frame pixels. */
  area: Rect
}

/** Where a render is drawing: its size, and document pixels to target pixels. */
export interface FrameInfo {
  width: number
  height: number
  scale: number
  docToTarget: Mat
  /** Whether work targets of this size hold half floats (smaller renders) or bytes (huge ones, to save memory). */
  precise: boolean
  /** The document position of the target's pixel 0, for a target that holds only part of the frame. */
  docOffset?: [number, number]
  /** A draft: layers drawn small are not mipmapped. */
  draft?: boolean
}

/** What reaches a layer from outside it: its opacity (folders' included), its folders' masks and its clipping base. */
export interface LayerCoverage {
  opacity: number
  folderMask: Target | null
  clip: Target | null
}

/** Draws a layer kind the base compositor does not (adjustments, effects). */
export interface LayerPass {
  /**
   * Draw `layer` over `backdrop` into `into`. True only when every pixel of `into` was written (the
   * backdrop with this layer on it); false leaves the layer to the plain path.
   */
  draw(layer: CanvasLayer, backdrop: Target, into: Target, frame: FrameInfo, coverage: LayerCoverage): boolean
  dispose?(): void
}

interface FrameState extends FrameInfo {
  folders: Map<string, Target>
  clips: Map<string, Target | null>
  borrowed: Target[]
}

interface TargetSet {
  a: Target
  b: Target
  source: Target
  width: number
  height: number
}

/** Target sets kept between renders: the view's and an export's tiles take turns without making new ones each time. */
const KEPT_SETS = 2

const PRECISE_PIXELS = 16_777_216

/** GPU memory work targets kept between renders may take; past it the oldest go. */
const SPARE_BYTES = 384 * 1024 * 1024

const bytesOf = (target: Target): number => target.width * target.height * (target.format === 'bytes' ? 4 : 8)

export class Compositor {
  readonly textures: RasterTextures
  readonly filters: Filters
  private sets: TargetSet[] = []
  private spares: Target[] = []
  private readonly white: WebGLTexture
  private readonly layerProgram: Program
  private readonly coverageProgram: Program
  private readonly blendProgram: Program
  private readonly copyProgram: Program
  /** Adjustment layers and layer effects plug in here. */
  readonly passes: LayerPass[] = []

  constructor(readonly gpu: Gpu) {
    const { gl } = gpu
    this.textures = new RasterTextures(gpu)
    this.white = gl.createTexture()!
    gpu.bindScratch(this.white)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]))
    gpu.setSampling(this.white, 'nearest')
    this.layerProgram = gpu.program(PLACE_VERTEX, LAYER_FRAGMENT)
    this.coverageProgram = gpu.program(PLACE_VERTEX, COVERAGE_FRAGMENT)
    this.blendProgram = gpu.program(FULL_VERTEX, BLEND_FRAGMENT)
    this.copyProgram = gpu.program(FULL_VERTEX, COPY_FRAGMENT)
    this.filters = new Filters(this)
    this.passes.push(new AdjustmentPass(this), new EffectsPass(this))
  }

  /** A 1×1 white texture, bound to samplers a draw does not use. */
  get blank(): WebGLTexture {
    return this.white
  }

  /** The program that draws a layer's pixels through its mask and coverage (premultiplied out). */
  get layerShader(): Program {
    return this.layerProgram
  }

  /** A cleared work target of any size, bound for drawing; give it back with `release` once done. */
  temporary(width: number, height: number, format: Target['format'] = 'precise'): Target {
    const wanted = format === 'precise' && !this.gpu.halfFloat ? 'bytes' : format
    const index = this.spares.findIndex((target) => target.width === width && target.height === height && target.format === wanted)
    const target = index >= 0 ? this.spares.splice(index, 1)[0] : this.gpu.createTarget(width, height, { precise: wanted === 'precise', seeds: wanted === 'seeds' })
    this.gpu.bindTarget(target, width, height)

    return target
  }

  release(...targets: (Target | null | undefined)[]): void {
    for (const target of targets) {
      if (target && !this.spares.includes(target)) {
        this.spares.push(target)
      }
    }

    let bytes = this.spares.reduce((sum, target) => sum + bytesOf(target), 0)

    while (bytes > SPARE_BYTES && this.spares.length) {
      const oldest = this.spares.shift()!
      bytes -= bytesOf(oldest)
      this.gpu.deleteTarget(oldest)
    }
  }

  private ensure(width: number, height: number): TargetSet {
    const index = this.sets.findIndex((set) => set.width === width && set.height === height)

    if (index >= 0) {
      const [set] = this.sets.splice(index, 1)
      this.sets.unshift(set)

      return set
    }

    const precise = width * height <= PRECISE_PIXELS
    const set = { a: this.gpu.createTarget(width, height, { precise }), b: this.gpu.createTarget(width, height, { precise }), source: this.gpu.createTarget(width, height, { precise }), width, height }
    this.sets.unshift(set)

    for (const old of this.sets.splice(KEPT_SETS)) {
      this.gpu.deleteTarget(old.a)
      this.gpu.deleteTarget(old.b)
      this.gpu.deleteTarget(old.source)
    }

    return set
  }

  private borrow(frame: FrameState): Target {
    const target = this.temporary(frame.width, frame.height, 'bytes')
    frame.borrowed.push(target)

    return target
  }

  /** Composite the document (or an area of its frame); the result stays valid until the next render. */
  render(state: DocState, options: RenderOptions = {}): Rendered {
    const limit = this.gpu.maxTextureSize
    let scale = options.scale ?? 1
    let area = options.area

    if (!area) {
      scale = Math.min(scale, limit / state.width, limit / state.height)
      area = { x: 0, y: 0, ...frameSize(state.width, state.height, scale) }
    }

    const { width, height } = area

    if (width < 1 || height < 1 || width > limit || height > limit || !Number.isInteger(width) || !Number.isInteger(height)) {
      throw new Error(`A render is 1 to ${limit} whole pixels a side, not ${width}×${height}`)
    }

    const targets = this.ensure(width, height)
    const frame: FrameState = {
      width,
      height,
      scale,
      docToTarget: multiply(translate(-area.x, -area.y), scaleMat(scale)),
      docOffset: [area.x / scale, area.y / scale],
      precise: width * height <= PRECISE_PIXELS,
      draft: options.draft,
      folders: new Map(),
      clips: new Map(),
      borrowed: []
    }
    const overrides = options.overrides
    const view: DocState = overrides?.size ? { ...state, layers: state.layers.map((layer) => (overrides.has(layer.id) ? { ...layer, ...overrides.get(layer.id) } : layer)) } : state
    let current = targets.a
    let other = targets.b

    this.textures.beginFrame()
    this.gpu.blendOver(false)
    this.gpu.bindTarget(current, width, height)

    for (const layer of view.layers) {
      if (layer.isGroup || (options.only && !options.only.has(layer.id))) {
        continue
      }

      if (!options.includeHidden && !(options.isolated ? layer.isVisible : isShown(view, layer))) {
        continue
      }

      if (!layer.pixels && !layer.adjustment && !layer.effects) {
        continue
      }

      const folders = options.isolated ? [] : ancestorsOf(view, layer)
      const opacity = (layer.opacity ?? 1) * folders.reduce((product, folder) => product * (folder.opacity ?? 1), 1)

      if (opacity <= 0) {
        continue
      }

      const folderMask = this.folderCoverage(folders, frame)
      const clip = layer.maskSourceID ? this.clipCoverage(view, layer.maskSourceID, frame, new Set([layer.id])) : null

      if (this.passes.length && (layer.adjustment || layer.effects)) {
        if (this.passes.some((pass) => pass.draw(layer, current, other, frame, { opacity, folderMask, clip }))) {
          ;[current, other] = [other, current]
          continue
        }
      }

      if (!layer.pixels) {
        continue
      }

      const mode = blendModeIndex(layer.blendMode)

      if (mode === 0) {
        this.gpu.bindTarget(current, width, height, false)
        this.gpu.blendOver(true)
        this.drawLayer(this.layerProgram, layer, frame, opacity, folderMask, clip)
        this.gpu.blendOver(false)
      } else {
        this.gpu.bindTarget(targets.source, width, height)
        this.drawLayer(this.layerProgram, layer, frame, opacity, folderMask, clip)
        this.blend(current, targets.source, other, mode, frame)
        ;[current, other] = [other, current]
      }
    }

    this.release(...frame.borrowed)
    this.textures.sweep()

    return { target: current, width, height, scale, area }
  }

  /**
   * Draw the frame (or an area of it) tile by tile at full quality, handing over each tile's pixels
   * (straight alpha, rows from the top, over `background` when given) and its place in the area.
   * Each tile is rendered with a border as wide as the blurs reach, then cut back.
   */
  renderTiles(state: DocState, options: RenderOptions & { background?: [number, number, number] | null; tile?: number }, onTile: (pixels: Raster, x: number, y: number) => void): void {
    const scale = options.scale ?? 1
    const frame = frameSize(state.width, state.height, scale)
    const area = options.area ?? { x: 0, y: 0, ...frame }
    const limit = this.gpu.maxTextureSize
    const pad = Math.min(filterReach(state, scale), Math.floor((limit - TILE_ALIGN * 3) / 2))
    const { background, tile: side, ...render } = options

    for (const tile of planTiles(frame, area, tileSide(limit, pad, side), pad)) {
      const rendered = this.render(state, { ...render, scale, area: tile.padded, draft: false })
      const inner = { x: tile.inner.x - tile.padded.x, y: tile.inner.y - tile.padded.y, width: tile.inner.width, height: tile.inner.height }
      onTile(this.read(rendered, background ?? null, inner), tile.inner.x - area.x, tile.inner.y - area.y)
    }
  }

  /** Blend `source` over `backdrop` with a mode (0 is Normal) into `into`. */
  blend(backdrop: Target, source: Target, into: Target, mode: number, frame: FrameInfo): void {
    this.gpu.bindTarget(into, frame.width, frame.height, false)
    this.blendProgram.use().texture('u_backdrop', 0, backdrop.texture).texture('u_source', 1, source.texture).int('u_mode', mode).vec2('u_size', frame.width, frame.height)
    this.gpu.drawQuad()
  }

  /**
   * Set the uniforms every placed draw shares, and draw the layer's quad: in one go, or a piece at a
   * time when its pixels (or its mask) are larger than the GPU's largest texture and drawn large
   * enough to need them at full size.
   */
  drawLayer(program: Program, layer: CanvasLayer, frame: FrameInfo, opacity: number, folderMask: Target | null, clip: Target | null): void {
    const place = multiply(frame.docToTarget, unitToDocument(layer.transform))
    const [offsetX, offsetY] = frame.docOffset ?? [0, 0]
    program.use().mat3('u_place', toMat3(place)).vec2('u_size', frame.width, frame.height).float('u_scale', frame.scale).vec2('u_docOffset', offsetX, offsetY).float('u_opacity', opacity)
    program.texture('u_folderMask', 2, folderMask?.texture ?? this.white).int('u_hasFolderMask', Boolean(folderMask))
    program.texture('u_clip', 3, clip?.texture ?? this.white).int('u_hasClip', Boolean(clip))

    const pixels = layer.pixels
    const mask = layer.mask && layer.maskEnabled !== false ? layer.mask : null
    const placement = mask && layer.maskLinked === false ? layer.maskPlacement : undefined
    const sampling = pixels ? this.samplingFor(layer, pixels, frame) : 'linear'
    // Pieces at full size only when the layer is drawn larger than its reduced copy would show it.
    const pieced = (raster: Raster | null, transform = layer.transform) => Boolean(raster && this.textures.tooBig(raster) && this.onTarget(transform, raster, frame) > 1 / this.textures.reduction(raster))
    const piecedPixels = pieced(pixels)
    const linkedMask = mask && !placement ? mask : null
    const primary = piecedPixels ? pixels : linkedMask && pieced(linkedMask) ? linkedMask : null

    if (mask) {
      program.int('u_maskMode', placement ? 2 : 1)

      if (placement) {
        program.mat3('u_docToMask', toMat3(invert(unitToDocument(placement))))
      }
    } else {
      program.texture('u_mask', 1, this.white).int('u_maskMode', 0).vec4('u_maskWindow', ...WHOLE)
    }

    if (!pixels) {
      program.texture('u_image', 0, this.white).int('u_hasImage', false).vec4('u_imageWindow', ...WHOLE)
    }

    const pieces: (Piece | null)[] = primary ? this.textures.pieces(primary, this.visiblePart(layer.transform, primary, frame), sampling === 'mipmap') : [null]

    for (const piece of pieces) {
      const unit = piece && primary ? ([piece.inner.x / primary.width, piece.inner.y / primary.height, piece.inner.width / primary.width, piece.inner.height / primary.height] as const) : WHOLE
      program.vec4('u_unitRect', ...unit)

      if (pixels) {
        const texture = piece && primary === pixels ? piece : this.wholePiece(pixels, sampling === 'mipmap')
        this.gpu.setSampling(texture.texture, sampling)
        program.texture('u_image', 0, texture.texture).int('u_hasImage', true).vec4('u_imageWindow', ...windowOf(texture, pixels))
      }

      if (mask) {
        // A mask the size of the pieced raster shares its pieces; any other is drawn from one texture.
        const sameGrid = piece && primary && !placement && mask.width === primary.width && mask.height === primary.height
        const texture = sameGrid ? (primary === mask ? piece : this.textures.pieces(mask, piece.inner)[0]) : this.wholePiece(mask, false)
        this.gpu.setSampling(texture.texture, 'linear')
        program.texture('u_mask', 1, texture.texture).vec4('u_maskWindow', ...windowOf(texture, mask))
      }

      this.gpu.drawQuad()
    }
  }

  /** Target pixels per raster pixel, along the layer's width. */
  private onTarget(transform: CanvasLayer['transform'], raster: Raster, frame: FrameInfo): number {
    return (Math.abs(transform.size[0]) * frame.scale) / raster.width
  }

  private samplingFor(layer: CanvasLayer, pixels: Raster, frame: FrameInfo): Sampling {
    if (layer.transform.sampling === 'Nearest') {
      return 'nearest'
    }

    return layer.transform.sampling === 'Smooth' || frame.draft || this.onTarget(layer.transform, pixels, frame) >= 1 ? 'linear' : 'mipmap'
  }

  /** A raster in one texture (reduced when it is too large), as a piece covering all of it. */
  private wholePiece(raster: Raster, mipmaps: boolean): Piece {
    return { texture: this.textures.get(raster, mipmaps), rect: raster.bounds, inner: raster.bounds }
  }

  /** The raster pixels of a placed layer that fall in the frame (with a pixel to spare). */
  private visiblePart(transform: CanvasLayer['transform'], raster: Raster, frame: FrameInfo): Rect | null {
    const toRaster = invert(multiply(frame.docToTarget, pixelToDocument(transform, raster.width, raster.height)))
    const corners = [apply(toRaster, [0, 0]), apply(toRaster, [frame.width, 0]), apply(toRaster, [frame.width, frame.height]), apply(toRaster, [0, frame.height])]
    const xs = corners.map((point) => point[0])
    const ys = corners.map((point) => point[1])
    const x = Math.floor(Math.min(...xs)) - 1
    const y = Math.floor(Math.min(...ys)) - 1

    return clipRect({ x, y, width: Math.ceil(Math.max(...xs)) + 1 - x, height: Math.ceil(Math.max(...ys)) + 1 - y }, raster.width, raster.height)
  }

  /** The enclosing folders' enabled masks multiplied together, or null when none has one. */
  private folderCoverage(folders: CanvasLayer[], frame: FrameState): Target | null {
    let coverage: Target | null = null

    // Outermost first: each folder's coverage includes the folders around it.
    for (const folder of [...folders].reverse()) {
      if (!folder.mask || folder.maskEnabled === false) {
        continue
      }

      const known = frame.folders.get(folder.id)

      if (known) {
        coverage = known
        continue
      }

      const target = this.borrow(frame)
      const placement = folder.maskLinked === false && folder.maskPlacement ? folder.maskPlacement : folder.transform
      this.gpu.bindTarget(target, frame.width, frame.height)
      this.drawLayer(this.coverageProgram, { ...folder, pixels: null, transform: placement, maskLinked: true, maskPlacement: undefined }, frame, 1, coverage, null)
      frame.folders.set(folder.id, target)
      coverage = target
    }

    return coverage
  }

  /** A clipping base's coverage: its pixels' alpha, opacity, mask and its own base's coverage. */
  private clipCoverage(state: DocState, baseId: string, frame: FrameState, visiting: Set<string>): Target | null {
    if (frame.clips.has(baseId)) {
      return frame.clips.get(baseId)!
    }

    const base = findLayer(state, baseId)

    if (!base || base.isGroup || visiting.has(baseId) || visiting.size > LIMITS.clipChain) {
      return null
    }

    visiting.add(baseId)
    const upstream = base.maskSourceID ? this.clipCoverage(state, base.maskSourceID, frame, visiting) : null
    const target = this.borrow(frame)
    this.gpu.bindTarget(target, frame.width, frame.height)

    if (base.pixels || base.adjustment) {
      this.drawLayer(this.coverageProgram, base, frame, base.opacity ?? 1, null, upstream)
    }

    frame.clips.set(baseId, target)

    return target
  }

  /** Copy a texture into the bound target as it is, or unpremultiplied over a background. */
  copy(texture: WebGLTexture, options: { unpremultiply?: boolean; background?: [number, number, number] | null; sampling?: Sampling } = {}): void {
    this.gpu.setSampling(texture, options.sampling ?? 'nearest')
    const [r, g, b] = options.background ?? [0, 0, 0]
    this.copyProgram
      .use()
      .texture('u_source', 0, texture)
      .int('u_unpremultiply', Boolean(options.unpremultiply))
      .vec4('u_background', r, g, b, options.background ? 1 : 0)
    this.gpu.drawQuad()
  }

  /** A render's pixels (or an `area` of them, in its own pixels): straight alpha, rows from the top; a background fills transparency (for JPEG). */
  read(rendered: Rendered, background: [number, number, number] | null = null, area?: Rect): Raster {
    const box = area ?? { x: 0, y: 0, width: rendered.width, height: rendered.height }
    const target = this.gpu.createTarget(box.width, box.height, { precise: false })

    try {
      this.gpu.bindTarget(target, box.width, box.height)
      // The whole render, offset so the area lands on the target.
      this.gpu.gl.viewport(-box.x, -box.y, rendered.width, rendered.height)
      this.copy(rendered.target.texture, { unpremultiply: true, background })

      return new Raster(box.width, box.height, 4, this.gpu.readPixels(target))
    } finally {
      this.gpu.deleteTarget(target)
    }
  }

  private disposeTargets(): void {
    for (const set of this.sets) {
      this.gpu.deleteTarget(set.a)
      this.gpu.deleteTarget(set.b)
      this.gpu.deleteTarget(set.source)
    }

    this.sets = []
    this.spares.forEach((target) => this.gpu.deleteTarget(target))
    this.spares = []
  }

  dispose(): void {
    this.disposeTargets()
    this.textures.clear()
    this.passes.forEach((pass) => pass.dispose?.())
    this.gpu.gl.deleteTexture(this.white)
  }
}

/** Where a raster's unit square lands in a texture holding part of it (or all of it): xy + unit × zw. */
export function windowOf(piece: Piece, raster: Raster): [number, number, number, number] {
  const { rect } = piece

  return [-rect.x / rect.width, -rect.y / rect.height, raster.width / rect.width, raster.height / rect.height]
}

/** A WebGL2 context of its own, for exports and previews made without a window on screen. */
export function headlessCompositor(): Compositor {
  const canvas = new OffscreenCanvas(1, 1)
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: false })

  if (!gl) {
    throw new Error('Veritas Canvas needs WebGL2, which this system does not provide')
  }

  return new Compositor(new Gpu(gl))
}
