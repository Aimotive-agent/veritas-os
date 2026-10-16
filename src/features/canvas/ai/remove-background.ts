/*
 * Remove Background and Select Subject: the salient-object model finds what a layer is of, at its
 * own resolution, and the answer becomes the layer's mask (nothing erased), a cut-out layer, or
 * the selection where the layer lands in the document. The model runs once per version of a
 * layer's pixels, so trying thresholds is quick.
 */

import { type CanvasDocument, type DocState, findLayer } from '../engine/document.ts'
import { pixelToDocument } from '../engine/geometry.ts'
import { Raster } from '../engine/raster.ts'
import { selectionFromRaster } from '../engine/sampling.ts'
import type { SelectionMode } from '../engine/selection.ts'
import { compositeOf } from '../tools/screen.ts'
import { applySelection } from '../tools/select.ts'
import * as ml from './ml.ts'
import type { MaskOptions } from './segment-math.ts'
import { type BackgroundOutput, cannotSegment, withSubject } from './subject.ts'

export { type BackgroundOutput, cannotSegment, withSubject } from './subject.ts'

export interface RemoveOptions extends Partial<MaskOptions> {
  output?: BackgroundOutput
}

/** What a run of the model is for: these pixels at this version. */
const tokenOf = (pixels: Raster): string => `${pixels.id}:${pixels.version}`

let analysed: string | null = null
let analysing: { token: string; done: Promise<'webgpu' | 'wasm'> } | null = null

/** Run the model on pixels unless it has already seen them as they are (or is looking now); answers with where it ran. */
export async function analyse(pixels: Raster): Promise<'webgpu' | 'wasm' | 'cached'> {
  const token = tokenOf(pixels)

  if (analysed === token) {
    return 'cached'
  }

  if (analysing?.token === token) {
    return analysing.done
  }

  if (analysed) {
    ml.forget(analysed)
  }

  analysed = null
  const run = { token, done: ml.segment(token, pixels) }
  analysing = run

  try {
    const backend = await run.done
    analysed = token

    return backend
  } finally {
    if (analysing === run) {
      analysing = null
    }
  }
}

/** The subject's mask over a raster that `analyse` has seen: its own size, or `width`×`height` for a preview. */
export async function subjectMask(pixels: Raster, options: Partial<MaskOptions>, width = pixels.width, height = pixels.height): Promise<Raster> {
  await analyse(pixels)
  const scale = width / pixels.width
  const values = await ml.salientMask(tokenOf(pixels), width, height, { ...options, feather: (options.feather ?? 0) * scale })

  return new Raster(width, height, 1, new Uint8ClampedArray(values.buffer, values.byteOffset, values.byteLength))
}

/** Remove a layer's background as one step (the model must be here: the window asks for it, commands check). */
export async function removeBackground(doc: CanvasDocument, layerId: string, options: RemoveOptions = {}): Promise<DocState> {
  const layer = findLayer(doc.state, layerId)
  const reason = cannotSegment(layer)

  if (reason || !layer?.pixels) {
    throw new Error(reason ?? 'Pick a layer with a picture')
  }

  const mask = await subjectMask(layer.pixels, options)

  return withSubject(doc.state, layer, mask, options.output ?? 'mask')
}

/** Select > Subject: the active layer's subject (or, without one, the whole picture's), where it lands in the document. */
export async function selectSubject(doc: CanvasDocument, mode: SelectionMode = 'new'): Promise<void> {
  const layer = doc.active
  const own = layer && !cannotSegment(layer) && layer.pixels ? layer : null
  const pixels = own?.pixels ?? compositeOf(doc)
  const mask = await subjectMask(pixels, {})
  const placed = own ? pixelToDocument(own.transform, pixels.width, pixels.height) : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  const shape = selectionFromRaster(mask, placed, doc.state.width, doc.state.height)

  if (!shape) {
    throw new Error('No subject stands out in this picture')
  }

  applySelection(doc, shape, mode, 'Select Subject')
}
