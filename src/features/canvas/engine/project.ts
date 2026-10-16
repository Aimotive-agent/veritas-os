/*
 * Opening, saving and exporting Veritas Canvas documents. Layer images come from the main process
 * as exact pixels where it can decode them; anything else is decoded here through WebGL, which
 * (unlike a 2D canvas) keeps semi-transparent colours exact. Saves send only the images that
 * changed since the last save. Flattening and exports render in tiles, so neither the GPU's
 * largest texture nor one giant buffer limits them; a PNG export goes to disk a band at a time.
 */

import {
  type CompManifest,
  FORMAT_ID,
  FORMAT_VERSION,
  imageFileFor,
  type LayerRecord,
  type LayerTransform,
  maskFileFor,
  parseManifest,
  RANGES,
  tableFileFor
} from '../../../../shared/canvas/comp-format.ts'
import { baseName, isLayeredImage, PROJECT_EXTENSION } from '../../../../shared/canvas/files.ts'
import type { CanvasProject, CanvasRawImage } from '../../../../shared/ipc.ts'
import { type ColorTable, parseCube } from './color-table.ts'
import { blankLayer, CanvasDocument, type CanvasLayer, type DocState, pixelLayer } from './document.ts'
import { type Compositor, headlessCompositor, type RenderOptions } from './gpu/compositor.ts'
import { heraldOf, standInFor, tableSizeOf } from './herald-adjust.ts'
import { clipRect, Raster, type Rect } from './raster.ts'
import { frameSize, strips } from './tiles.ts'

const api = () => window.heraldOS.canvas

/** The name a project or image shows: its file name without the extension. */
export const projectName = (file: string): string => baseName(file)

// --- Decoding ----------------------------------------------------------------------------------

let decoder: { gl: WebGL2RenderingContext; texture: WebGLTexture; framebuffer: WebGLFramebuffer } | null = null

/** Straight-alpha pixels of a decoded image, read back through WebGL so nothing is rounded. */
function bitmapPixels(bitmap: ImageBitmap): Uint8ClampedArray {
  const { width, height } = bitmap

  if (!decoder) {
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2')

    if (gl) {
      decoder = { gl, texture: gl.createTexture()!, framebuffer: gl.createFramebuffer()! }
    }
  }

  if (decoder && !decoder.gl.isContextLost() && width <= decoder.gl.getParameter(decoder.gl.MAX_TEXTURE_SIZE) && height <= decoder.gl.getParameter(decoder.gl.MAX_TEXTURE_SIZE)) {
    const { gl, texture, framebuffer } = decoder
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
    const out = new Uint8ClampedArray(width * height * 4)
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, out)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    // A 1×1 placeholder frees the image's memory until the next decode.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)

    return out
  }

  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  context.drawImage(bitmap, 0, 0)

  return context.getImageData(0, 0, width, height).data
}

async function decodeBytes(bytes: Uint8Array, svg: boolean): Promise<Raster> {
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: svg ? 'image/svg+xml' : '' })
  let bitmap: ImageBitmap

  if (svg) {
    // SVG decodes only through an image element.
    const url = URL.createObjectURL(blob)

    try {
      const image = new Image()
      image.src = url
      await image.decode()
      bitmap = await createImageBitmap(image)
    } finally {
      URL.revokeObjectURL(url)
    }
  } else {
    bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
  }

  try {
    return new Raster(bitmap.width, bitmap.height, 4, bitmapPixels(bitmap))
  } finally {
    bitmap.close()
  }
}

/** RGBA to one channel (colour averaged, times alpha), or gray to RGBA. */
function convertChannels(raster: Raster, channels: 1 | 4): Raster {
  if (raster.channels === channels) {
    return raster
  }

  const out = new Raster(raster.width, raster.height, channels)
  const count = raster.width * raster.height

  for (let i = 0; i < count; i++) {
    if (channels === 1) {
      const s = i * 4
      out.data[i] = (((raster.data[s] + raster.data[s + 1] + raster.data[s + 2]) / 3) * raster.data[s + 3]) / 255
    } else {
      const v = raster.data[i]
      out.data.set([v, v, v, 255], i * 4)
    }
  }

  return out
}

/** Pixels from the main process, or encoded bytes decoded here. */
export async function toRaster(source: CanvasRawImage | Uint8Array, channels: 1 | 4, svg = false): Promise<Raster> {
  if (source instanceof Uint8Array) {
    return convertChannels(await decodeBytes(source, svg), channels)
  }

  const data = new Uint8ClampedArray(source.data.buffer, source.data.byteOffset, source.data.byteLength)

  return convertChannels(new Raster(source.width, source.height, source.channels, data), channels)
}

const bytesOf = (raster: Raster): Uint8Array => new Uint8Array(raster.data.buffer, raster.data.byteOffset, raster.data.byteLength)

const rawOf = (raster: Raster): CanvasRawImage => ({ width: raster.width, height: raster.height, channels: raster.channels, data: bytesOf(raster) })

/** Run `work` over items with at most `limit` at a time. */
async function inBatches<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      out[index] = await work(items[index])
    }
  })
  await Promise.all(runners)

  return out
}

// --- Opening -----------------------------------------------------------------------------------

/** A Color Lookup layer's table from its project file. */
async function readTable(project: string, record: LayerRecord): Promise<ColorTable> {
  const bytes = await api().readAsset(project, tableFileFor(record.id))

  try {
    if (!(bytes instanceof Uint8Array)) {
      throw new Error('it is not a text file')
    }

    return parseCube(bytes)
  } catch (error) {
    throw new Error(`${record.name}: its colour table cannot be read (${error instanceof Error ? error.message : String(error)})`)
  }
}

interface Loaded {
  state: DocState
  documentId: string
  extra: Record<string, unknown>
}

async function loadProject(project: CanvasProject): Promise<Loaded> {
  const manifest = parseManifest(project.manifest)
  const layers = await inBatches(manifest.layers, 6, async (record): Promise<CanvasLayer> => {
    const { imageFile, maskFile, ...rest } = record
    const pixels = imageFile ? await toRaster(await api().readAsset(project.path, imageFile), 4) : null
    const mask = maskFile ? await toRaster(await api().readAsset(project.path, maskFile), 1) : null
    const table = tableSizeOf(record) ? await readTable(project.path, record) : null
    const herald = heraldOf(record)

    // The stand-in is made again from the Veritas settings, so the two always agree.
    return { ...rest, ...(herald ? { adjustment: standInFor(herald) } : {}), pixels, mask, ...(table ? { table } : {}) }
  })
  const { format: _format, version: _version, colorSpace: _colorSpace, resolution, documentID, width, height, activeLayerID, layers: _layers, guides, ...extra } = manifest
  const active = activeLayerID && layers.some((layer) => layer.id === activeLayerID) ? activeLayerID : (layers.at(-1)?.id ?? null)

  return { state: { width, height, resolution, layers, activeLayerId: active, guides, selection: null }, documentId: documentID, extra }
}

function rememberAssets(doc: CanvasDocument, layers: readonly CanvasLayer[], versions?: Map<Raster, number>): void {
  doc.savedAssets.clear()
  doc.savedTables.clear()

  for (const layer of layers) {
    if (layer.table && tableSizeOf(layer)) {
      doc.savedTables.set(tableFileFor(layer.id), layer.table.bytes)
    }

    if (layer.pixels) {
      doc.savedAssets.set(imageFileFor(layer.id), { raster: layer.pixels, version: versions?.get(layer.pixels) ?? layer.pixels.version })
    }

    if (layer.mask) {
      doc.savedAssets.set(maskFileFor(layer.id), { raster: layer.mask, version: versions?.get(layer.mask) ?? layer.mask.version })
    }
  }
}

export async function openProject(file: string): Promise<CanvasDocument> {
  const project = await api().read(file)
  const loaded = await loadProject(project)
  const doc = new CanvasDocument({ ...loaded, name: projectName(project.path), path: project.path, digest: project.digest })
  rememberAssets(doc, doc.state.layers)

  return doc
}

/** Take a project's state from disk into an open document, as one undoable step. */
export async function reloadProject(doc: CanvasDocument, project: CanvasProject, label = 'Changed outside Veritas Canvas'): Promise<void> {
  const loaded = await loadProject(project)
  const keep = loaded.state.layers.some((layer) => layer.id === doc.state.activeLayerId) ? doc.state.activeLayerId : loaded.state.activeLayerId
  doc.extra = loaded.extra
  doc.commit(label, { ...loaded.state, activeLayerId: keep })
  doc.history.tagLast('outside')
  rememberAssets(doc, doc.state.layers)
  doc.markSaved(project.digest)
}

/** An image file as one picture: decoded, converted by the system, or a Photoshop document flattened. */
export async function readPicture(file: string, channels: 1 | 4 = 4): Promise<Raster> {
  if (isLayeredImage(file)) {
    const { psdPicture } = await import('../psd/psd.ts')

    return convertChannels(await psdPicture(file), channels)
  }

  return toRaster(await api().readImage(file), channels, /\.svg$/i.test(file))
}

export async function documentFromImage(file: string): Promise<CanvasDocument> {
  const raster = await readPicture(file)
  const layer = pixelLayer('Background', raster)

  return new CanvasDocument({
    state: { width: raster.width, height: raster.height, resolution: 72, layers: [layer], activeLayerId: layer.id, guides: [], selection: null },
    name: baseName(file)
  })
}

export type Background = 'white' | 'black' | 'transparent'

export function newDocument(width: number, height: number, background: Background = 'white', resolution = 72): CanvasDocument {
  const layer =
    background === 'transparent'
      ? blankLayer('Layer 1', width, height)
      : pixelLayer('Background', Raster.filled(width, height, background === 'white' ? [255, 255, 255, 255] : [0, 0, 0, 255]))

  return new CanvasDocument({
    state: { width, height, resolution, layers: [layer], activeLayerId: layer.id, guides: [], selection: null },
    name: 'Untitled'
  })
}

// --- Saving ------------------------------------------------------------------------------------

/** A placement within the sizes Compositor reads: a layer scaled down to nothing keeps a pixel. */
function readableBox(transform: LayerTransform): LayerTransform {
  const [least, most] = RANGES.layerSize
  const side = (value: number) => Math.min(most, Math.max(least, value))

  return transform.size[0] >= least && transform.size[1] >= least && transform.size[0] <= most && transform.size[1] <= most ? transform : { ...transform, size: [side(transform.size[0]), side(transform.size[1])] }
}

function layerRecord(layer: CanvasLayer): LayerRecord {
  const { pixels, mask, table: _table, imageFile: _image, maskFile: _mask, ...rest } = layer
  const record: LayerRecord = { ...rest, transform: readableBox(layer.transform), ...(layer.maskPlacement ? { maskPlacement: readableBox(layer.maskPlacement) } : {}) }

  if (pixels) {
    record.imageFile = imageFileFor(layer.id)
  }

  if (mask) {
    record.maskFile = maskFileFor(layer.id)
    record.maskEnabled = layer.maskEnabled ?? true
  } else {
    delete record.maskEnabled
    delete record.maskPlacement
    delete record.maskLinked
  }

  for (const key of Object.keys(record)) {
    if (record[key] === undefined) {
      delete record[key]
    }
  }

  return record
}

export function manifestOf(doc: Pick<CanvasDocument, 'extra' | 'documentId'>, state: DocState): CompManifest {
  return {
    ...doc.extra,
    format: FORMAT_ID,
    version: FORMAT_VERSION,
    colorSpace: 'sRGB',
    resolution: state.resolution,
    documentID: doc.documentId,
    width: state.width,
    height: state.height,
    activeLayerID: state.activeLayerId,
    layers: state.layers.map(layerRecord),
    guides: [...state.guides]
  }
}

let shared: Compositor | null = null

/** A compositor with its own GL context, for exports and previews. */
export function offscreen(): Compositor {
  if (!shared || shared.gpu.gl.isContextLost()) {
    shared = headlessCompositor()
  }

  return shared
}

/** Let go of the offscreen compositor's textures once an export is done. */
const relax = (): void => shared?.textures.clear()

export interface FlattenOptions extends Pick<RenderOptions, 'only' | 'overrides' | 'isolated' | 'includeHidden'> {
  /** The part of the frame (the document at the scale) to flatten, in its pixels; all of it by default. */
  area?: Rect
  /** A compositor that has the layers on its GPU already (the view's); the shared offscreen one otherwise. */
  compositor?: Compositor
}

/** The flattened document (or an area of it) as straight-alpha pixels, at a scale (1 is full size), rendered in tiles. */
export function flatten(state: DocState, scale = 1, background: [number, number, number] | null = null, options: FlattenOptions = {}): Raster {
  const { compositor: given, area: wanted, ...render } = options
  const compositor = given ?? offscreen()
  const frame = frameSize(state.width, state.height, scale)
  const area = clipRect(wanted ?? { x: 0, y: 0, ...frame }, frame.width, frame.height) ?? { x: 0, y: 0, width: 1, height: 1 }
  const out = new Raster(area.width, area.height)

  try {
    compositor.renderTiles(state, { ...render, scale, area, background }, (tile, x, y) => out.write({ x, y, width: tile.width, height: tile.height }, tile.data))
  } finally {
    if (!given) {
      relax()
    }
  }

  return out
}

async function encode(raster: Raster, type: 'image/jpeg' | 'image/webp', quality: number): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(raster.width, raster.height)
  const context = canvas.getContext('2d')!
  context.putImageData(new ImageData(raster.data as Uint8ClampedArray<ArrayBuffer>, raster.width, raster.height), 0, 0)
  const blob = await canvas.convertToBlob({ type, quality })

  return new Uint8Array(await blob.arrayBuffer())
}

const PREVIEW_SIDE = 512

/** QuickLook/Preview.jpg: the picture Finder shows for the project. */
async function previewOf(state: DocState): Promise<Uint8Array | undefined> {
  try {
    const scale = Math.min(1, PREVIEW_SIDE / Math.max(state.width, state.height))

    return await encode(flatten(state, scale, [1, 1, 1]), 'image/jpeg', 0.8)
  } catch {
    return undefined
  }
}

/** Save a document as a project (to its own path unless given another); resolves with the path. */
export async function saveProject(doc: CanvasDocument, file = doc.path): Promise<string> {
  if (!file) {
    throw new Error('Choose where to save the project first')
  }

  const target = file.toLowerCase().endsWith(PROJECT_EXTENSION) ? file : `${file}${PROJECT_EXTENSION}`
  const sameProject = target === doc.path
  const state = doc.state
  const position = doc.history.position
  const versions = new Map<Raster, number>()
  const assets: Record<string, CanvasRawImage | Uint8Array> = {}

  for (const layer of state.layers) {
    const table = layer.table && tableSizeOf(layer) ? layer.table : null

    if (table && (!sameProject || doc.savedTables.get(tableFileFor(layer.id)) !== table.bytes)) {
      assets[tableFileFor(layer.id)] = table.bytes
    }

    for (const [name, raster] of [
      [imageFileFor(layer.id), layer.pixels],
      [maskFileFor(layer.id), layer.mask]
    ] as const) {
      if (!raster) {
        continue
      }

      versions.set(raster, raster.version)
      const saved = sameProject ? doc.savedAssets.get(name) : undefined

      if (!saved || saved.raster !== raster || saved.version !== raster.version) {
        // A copy: painting may go on while the save is under way.
        assets[name] = rawOf(raster.clone())
      }
    }
  }

  const manifest = manifestOf(doc, state)
  const digest = await api().write(target, { manifest, assets, preview: await previewOf(state) })

  rememberAssets(doc, state.layers, versions)
  doc.path = target
  doc.name = projectName(target)
  doc.digest = digest
  doc.savedPosition = position
  doc.changed()

  return target
}

export type ExportKind = 'png' | 'jpeg' | 'webp'

/** The largest side a WebP image can have. */
export const WEBP_SIDE = 16_383

/** Pixels in a band of a PNG export: what is rendered and sent to be written at a time. */
const BAND_PIXELS = 16_000_000

const nextFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** Write the flattened document as an image; resolves with the file written. */
export async function exportImage(state: DocState, file: string, kind: ExportKind, options: { quality?: number; scale?: number } = {}): Promise<string> {
  const scale = options.scale ?? 1
  const frame = frameSize(state.width, state.height, scale)

  if (kind === 'png') {
    return exportPng(state, file, scale, Math.round(state.resolution * scale))
  }

  if (kind === 'webp' && Math.max(frame.width, frame.height) > WEBP_SIDE) {
    throw new Error(`A WebP image is at most ${WEBP_SIDE.toLocaleString('en')} pixels a side, and this one would be ${frame.width.toLocaleString('en')}×${frame.height.toLocaleString('en')}: export a PNG or a JPEG, or at a smaller scale`)
  }

  // The encoder takes a canvas, which is filled a tile at a time rather than from one copy of the whole image.
  const canvas = new OffscreenCanvas(frame.width, frame.height)
  const context = canvas.getContext('2d')!
  const background: [number, number, number] | null = kind === 'jpeg' ? [1, 1, 1] : null
  const compositor = offscreen()

  try {
    compositor.renderTiles(state, { scale, background }, (tile, x, y) => context.putImageData(new ImageData(tile.data as Uint8ClampedArray<ArrayBuffer>, tile.width, tile.height), x, y))
  } finally {
    relax()
  }

  const blob = await canvas.convertToBlob({ type: kind === 'jpeg' ? 'image/jpeg' : 'image/webp', quality: options.quality ?? 0.9 })

  return api().writeFile(file, new Uint8Array(await blob.arrayBuffer()))
}

/** A PNG written a band of rows at a time: rendered here, compressed and written by main. */
async function exportPng(state: DocState, file: string, scale: number, ppi: number): Promise<string> {
  const frame = frameSize(state.width, state.height, scale)
  const rows = Math.max(64, Math.floor(BAND_PIXELS / frame.width))
  const stream = await api().streamBegin(file, { kind: 'png', width: frame.width, height: frame.height, ppi })

  try {
    for (const band of strips(frame.height, rows)) {
      const raster = flatten(state, scale, null, { area: { x: 0, y: band.y, width: frame.width, height: band.height } })
      await api().streamWrite(stream, bytesOf(raster))
      // Let the window breathe between bands of a large export.
      await nextFrame()
    }

    return await api().streamEnd(stream)
  } catch (error) {
    void api().streamAbort(stream).catch(() => {})
    throw error
  }
}

/** Follow a project on disk: `onChange` hears about saves made by anyone else. */
export function watchProject(doc: CanvasDocument, onChange: (project: CanvasProject) => void): () => void {
  const file = doc.path

  if (!file) {
    return () => {}
  }

  let watchId: string | null = null
  let stopped = false
  void api()
    .watch(file, doc.digest)
    .then((id) => {
      if (stopped) {
        void api().unwatch(id)
      } else {
        watchId = id
      }
    })
    .catch(() => {})
  const off = api().onChanged((event) => {
    if (event.watchId === watchId && event.project.digest !== doc.digest) {
      onChange(event.project)
    }
  })

  return () => {
    stopped = true
    off()

    if (watchId) {
      void api().unwatch(watchId)
    }
  }
}
