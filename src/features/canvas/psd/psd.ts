/*
 * Photoshop documents in Veritas Canvas. Opening one reads the file in parts, parses and maps it in
 * a worker, and then sets each text layer into the box Veritas lays its text out in, so editing it
 * later keeps it in place (Photoshop's own pixels stay until then). Exporting prepares every layer
 * in the document's pixel grid here, where the GPU is, and has the worker write the file.
 */

import { defaultTransform, type LayerRecord } from '../../../../shared/canvas/comp-format.ts'
import { baseName } from '../../../../shared/canvas/files.ts'
import { parseCube } from '../engine/color-table.ts'
import { CanvasDocument, type CanvasLayer, type DocState } from '../engine/document.ts'
import { heraldOf, standInFor } from '../engine/herald-adjust.ts'
import { apply, boundsOf, isPixelAligned, tidy } from '../engine/geometry.ts'
import { flatten } from '../engine/project.ts'
import { clipRect, Raster, resample } from '../engine/raster.ts'
import { layoutText, loadFont, measureFor, originForAnchor } from '../engine/text.ts'
import { layoutToDocument } from '../text-layers.ts'
import type { ImportedPsd, PixelData, PsdSource, PsdSourceLayer } from './psd-map.ts'
import type { PsdReply, PsdRequest } from './psd-worker.ts'

const api = () => window.heraldOS.canvas

/** Bytes read from or written to the main process at a time. */
const PART_BYTES = 48 * 1024 * 1024

/** A layered file's bytes, read in parts. */
async function readBytes(file: string): Promise<ArrayBuffer> {
  const first = await api().readPart(file, 0, PART_BYTES)
  const buffer = new ArrayBuffer(first.size)
  const bytes = new Uint8Array(buffer)
  bytes.set(first.bytes, 0)
  let offset = first.bytes.byteLength

  while (offset < first.size) {
    const part = await api().readPart(file, offset, PART_BYTES)

    if (!part.bytes.byteLength || part.size !== first.size) {
      throw new Error(`${baseName(file)} changed while it was being read`)
    }

    bytes.set(part.bytes, offset)
    offset += part.bytes.byteLength
  }

  return buffer
}

function inWorker<T extends PsdReply & { ok: true }>(request: PsdRequest, transfer: Transferable[]): Promise<T> {
  const worker = new Worker(new URL('./psd-worker.ts', import.meta.url), { type: 'module', name: 'herald-canvas-psd' })

  return new Promise<T>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<PsdReply>) => {
      worker.terminate()

      if (event.data.ok) {
        resolve(event.data as T)
      } else {
        reject(new Error(event.data.error))
      }
    }
    worker.onerror = (event) => {
      worker.terminate()
      reject(new Error(event.message || 'The Photoshop reader stopped'))
    }
    worker.postMessage(request, transfer)
  })
}

const rasterOf = (pixels: PixelData): Raster => new Raster(pixels.width, pixels.height, pixels.channels, pixels.data)

const pixelsOf = (raster: Raster): PixelData => ({ width: raster.width, height: raster.height, channels: raster.channels, data: raster.data })

/** A Photoshop document's layers and notes, read and mapped. */
export async function readPsd(file: string): Promise<ImportedPsd> {
  const buffer = await readBytes(file)
  const reply = await inWorker<{ ok: true; read: ImportedPsd }>({ read: buffer }, [buffer])

  return reply.read
}

/**
 * A text layer from Photoshop moved into the box Veritas sets its text in: the box is laid out
 * around the anchor, and Photoshop's pixels copied into it. When they do not fit (Veritas would set
 * the text differently, often for want of the font) the layer stays a picture.
 */
async function settleText(layer: CanvasLayer, anchor: [number, number], notes: string[]): Promise<CanvasLayer> {
  const style = layer.text!
  const pixels = layer.pixels!
  await loadFont(style)
  const layout = layoutText(style, measureFor(style))
  const [ox, oy] = style.boxSize ? anchor : originForAnchor(layout, anchor[0], anchor[1])
  const x = Math.round(ox)
  const y = Math.round(oy)
  const [left, top] = layer.transform.origin
  const fits = left >= x && top >= y && left + pixels.width <= x + layout.width && top + pixels.height <= y + layout.height

  if (!fits) {
    notes.push(`Text “${layer.name}” is set wider or taller here than in Photoshop (a font this computer lacks, perhaps), so it was kept as a picture`)

    return { ...layer, text: undefined }
  }

  const box = new Raster(Math.max(1, Math.round(layout.width)), Math.max(1, Math.round(layout.height)))
  box.write({ x: Math.round(left - x), y: Math.round(top - y), width: pixels.width, height: pixels.height }, pixels.data)

  return { ...layer, pixels: box, transform: defaultTransform(box.width, box.height, x, y) }
}

/** A Photoshop document opened with its layers, and what was approximated on the way. */
export async function documentFromPsd(file: string): Promise<{ doc: CanvasDocument; notes: string[] }> {
  const imported = await readPsd(file)
  const notes = [...imported.notes]
  const layers: CanvasLayer[] = []

  for (const entry of imported.layers) {
    const herald = heraldOf(entry.record)
    let layer: CanvasLayer = {
      ...entry.record,
      ...(herald ? { adjustment: standInFor(herald) } : {}),
      pixels: entry.pixels ? rasterOf(entry.pixels) : null,
      mask: entry.mask ? rasterOf(entry.mask) : null,
      ...(entry.table ? { table: parseCube(entry.table) } : {})
    }

    if (layer.text && layer.pixels && entry.textAnchor) {
      layer = await settleText(layer, entry.textAnchor, notes)
    }

    layers.push(layer)
  }

  const active = [...layers].reverse().find((layer) => !layer.isGroup) ?? layers.at(-1)
  const doc = new CanvasDocument({
    state: { width: imported.width, height: imported.height, resolution: imported.resolution, layers, activeLayerId: active?.id ?? null, guides: [], selection: null },
    name: baseName(file)
  })

  return { doc, notes }
}

/** A Photoshop document as one picture: its layers flattened (for placing it in another image). */
export async function psdPicture(file: string): Promise<Raster> {
  const { doc } = await documentFromPsd(file)

  return flatten(doc.state, 1)
}

// --- Exporting ---------------------------------------------------------------------------------

const recordOf = (layer: CanvasLayer): LayerRecord => {
  const { pixels: _pixels, mask: _mask, table: _table, ...record } = layer

  return record
}

/** A layer alone, drawn into the document's pixel grid over the part of the canvas it covers (its mask applied). */
function drawnAlone(state: DocState, layer: CanvasLayer): PsdSourceLayer['pixels'] {
  const area = clipRect(boundsOf(layer.transform), state.width, state.height)

  if (!area) {
    return null
  }

  const alone = new Map([[layer.id, { opacity: 1, blendMode: 'Normal' as const, effects: undefined, maskSourceID: undefined, isVisible: true }]])
  const raster = flatten(state, 1, null, { area, only: new Set([layer.id]), isolated: true, includeHidden: true, overrides: alone })

  return { left: area.x, top: area.y, image: pixelsOf(raster) }
}

/** A mask in the document: linked masks over the layer's box, placed ones over their own; a one-value mask is just that value. */
function placedMask(layer: CanvasLayer): PsdSourceLayer['mask'] {
  const mask = layer.mask

  if (!mask) {
    return null
  }

  const uniform = mask.width * mask.height === 1 ? mask.data[0] : null
  const placement = layer.maskLinked === false && layer.maskPlacement ? layer.maskPlacement : layer.transform
  const linked = placement === layer.transform

  if (uniform !== null && linked) {
    return { left: 0, top: 0, image: { width: 1, height: 1, channels: 1, data: new Uint8ClampedArray([uniform]) }, outside: uniform >= 128 ? 255 : 0 }
  }

  const [width, height] = [Math.max(1, Math.round(placement.size[0])), Math.max(1, Math.round(placement.size[1]))]
  const image = mask.width === width && mask.height === height ? mask : resample(mask, width, height)

  return { left: Math.round(placement.origin[0]), top: Math.round(placement.origin[1]), image: pixelsOf(image), outside: 0 }
}

/** Layout pixels to the document for a text layer, as Photoshop's text transform (with the anchor's place). */
function textTransformOf(layer: CanvasLayer): PsdSourceLayer['textTransform'] {
  const style = layer.text!
  const layout = layoutText(style, measureFor(style))
  const m = layoutToDocument(layer.transform, layout)
  const [ax, ay] = apply(m, layout.anchor)

  return [tidy(m.a, 6), tidy(m.b, 6), tidy(m.c, 6), tidy(m.d, 6), tidy(ax), tidy(ay)]
}

/** The document as a Photoshop file: written by the worker and sent to disk in parts. Resolves with what was approximated. */
export async function exportPsd(state: DocState, file: string): Promise<{ file: string; notes: string[] }> {
  const notes: string[] = []
  const layers: PsdSourceLayer[] = []
  const turned: string[] = []

  for (const layer of state.layers) {
    const entry: PsdSourceLayer = { record: recordOf(layer), pixels: null, mask: null, ...(layer.table ? { table: layer.table.bytes } : {}) }
    const aligned = layer.pixels ? isPixelAligned(layer.transform, layer.pixels.width, layer.pixels.height) : true

    if (layer.pixels && aligned) {
      entry.pixels = { left: layer.transform.origin[0], top: layer.transform.origin[1], image: pixelsOf(layer.pixels) }
      entry.mask = placedMask(layer)
    } else if (layer.pixels) {
      // Photoshop places pixels on its grid unturned: the layer is drawn there, its mask applied.
      entry.pixels = drawnAlone(state, layer)
      turned.push(layer.name)
    } else {
      entry.mask = placedMask(layer)
    }

    if (layer.text && layer.pixels) {
      entry.textTransform = textTransformOf(layer)
    }

    layers.push(entry)
  }

  if (turned.length) {
    notes.push(`Turned, flipped or scaled layers were drawn into the document’s pixel grid, with their masks applied (${turned.slice(0, 3).map((name) => `“${name}”`).join(', ')}${turned.length > 3 ? ` and ${turned.length - 3} more` : ''})`)
  }

  const source: PsdSource = { width: state.width, height: state.height, resolution: state.resolution, layers, composite: pixelsOf(flatten(state, 1)) }
  const reply = await inWorker<{ ok: true; written: Uint8Array; notes: string[] }>({ write: source }, [])
  const stream = await api().streamBegin(file, { kind: 'bytes' })

  try {
    for (let offset = 0; offset < reply.written.byteLength; offset += PART_BYTES) {
      await api().streamWrite(stream, reply.written.subarray(offset, offset + PART_BYTES))
    }

    return { file: await api().streamEnd(stream), notes: [...reply.notes, ...notes] }
  } catch (error) {
    void api().streamAbort(stream).catch(() => {})
    throw error
  }
}
