/*
 * Running the Filter menu's filters on a layer: off the window's thread, a tile at a time, on the
 * part of the layer the selection reaches (with the border each filter reads), mixed in by the
 * selection's softness, as one undoable step. The dialog previews on the canvas first, on a reduced
 * copy when the layer is large.
 */

import type { Vec2 } from '../../../shared/canvas/comp-format.ts'
import type { CanvasDocument, DocState } from './engine/document.ts'
import { withLayer } from './engine/document.ts'
import { FILTER_NAMES, filterReach, type FilterSpec, type Pixels, scaledFilter } from './engine/filters.ts'
import { pixelToDocument } from './engine/geometry.ts'
import { PixelEdit } from './engine/history.ts'
import { clipRect, Raster, type Rect, resample } from './engine/raster.ts'
import { coverageReader, rasterArea } from './engine/sampling.ts'
import type { FilterReply, FilterRequest } from './filter-worker.ts'
import { commitPixels, type PaintTarget, paintTarget } from './tools/target.ts'

export interface FilterTask {
  done: Promise<Uint8ClampedArray>
  cancel(): void
}

/** Run a filter on pixels in a worker; `origin` is where they sit in the layer. */
export function runInWorker(pixels: Pixels, spec: FilterSpec, origin: Vec2 = [0, 0]): FilterTask {
  const worker = new Worker(new URL('./filter-worker.ts', import.meta.url), { type: 'module', name: 'herald-canvas-filter' })
  let fail: (error: Error) => void = () => {}
  const done = new Promise<Uint8ClampedArray>((resolve, reject) => {
    fail = reject
    worker.onmessage = (event: MessageEvent<FilterReply>) => {
      worker.terminate()

      if (event.data.ok) {
        resolve(event.data.data)
      } else {
        reject(new Error(event.data.error))
      }
    }
    worker.onerror = (event) => {
      event.preventDefault()
      worker.terminate()
      reject(new Error(event.message || 'The filter stopped'))
    }
  })
  const request: FilterRequest = { pixels, spec, origin: [origin[0], origin[1]] }
  worker.postMessage(request, [pixels.data.buffer])

  return {
    done,
    cancel: () => {
      worker.terminate()
      fail(new Error('cancelled'))
    }
  }
}

/** The side of the tiles a large layer is filtered in. */
const TILE = 1024

/** Tiles filtered at once, each in a worker of its own. */
const PARALLEL = Math.max(1, Math.min(4, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1))

/** Run a filter over an area of a raster in tiles (a few at once), each read with the border the filter needs; the pixels of `area` come back. */
export async function filterArea(raster: Raster, area: Rect, spec: FilterSpec, onTask?: (task: FilterTask) => void): Promise<Uint8ClampedArray> {
  const out = new Uint8ClampedArray(area.width * area.height * raster.channels)
  const reach = filterReach(spec)
  const c = raster.channels
  const tiles: Rect[] = []
  // A wide reach would make small tiles mostly border.
  const side = Math.max(TILE, reach * 4)

  for (let ty = area.y; ty < area.y + area.height; ty += side) {
    for (let tx = area.x; tx < area.x + area.width; tx += side) {
      tiles.push({ x: tx, y: ty, width: Math.min(side, area.x + area.width - tx), height: Math.min(side, area.y + area.height - ty) })
    }
  }

  let next = 0
  const running = new Set<FilterTask>()
  const runner = async () => {
    while (next < tiles.length) {
      const inner = tiles[next++]
      const read = clipRect({ x: inner.x - reach, y: inner.y - reach, width: inner.width + reach * 2, height: inner.height + reach * 2 }, raster.width, raster.height)!
      const task = runInWorker({ width: read.width, height: read.height, channels: c, data: raster.read(read) }, spec, [read.x, read.y])
      running.add(task)
      onTask?.({ done: task.done, cancel: () => running.forEach((entry) => entry.cancel()) })
      const filtered = await task.done
      running.delete(task)

      for (let y = 0; y < inner.height; y++) {
        const from = ((inner.y - read.y + y) * read.width + (inner.x - read.x)) * c
        out.set(filtered.subarray(from, from + inner.width * c), ((inner.y - area.y + y) * area.width + (inner.x - area.x)) * c)
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(PARALLEL, tiles.length) }, runner))
  } catch (error) {
    running.forEach((task) => task.cancel())
    throw error
  }

  return out
}

/** The part of a raster a filter changes: what the selection reaches on it, or all of it. */
export function filterTargetArea(raster: Raster, toDocument: Parameters<typeof rasterArea>[1], selection: Raster | null): Rect | null {
  const bounds = selection?.opaqueBounds()

  if (selection && !bounds) {
    return null
  }

  return bounds ? rasterArea(bounds, toDocument, raster.width, raster.height) : raster.bounds
}

/** Filtered pixels of `area` put into a raster, each pixel by the selection's strength there (all of it without one). */
export function mixInto(raster: Raster, area: Rect, filtered: Uint8ClampedArray, strength: (x: number, y: number) => number): void {
  const c = raster.channels
  const { data } = raster

  for (let y = 0; y < area.height; y++) {
    for (let x = 0; x < area.width; x++) {
      const s = strength(area.x + x, area.y + y)

      if (s <= 0) {
        continue
      }

      const o = ((area.y + y) * raster.width + area.x + x) * c
      const f = (y * area.width + x) * c

      for (let k = 0; k < c; k++) {
        data[o + k] = s >= 1 ? filtered[f + k] : data[o + k] + (filtered[f + k] - data[o + k]) * s
      }
    }
  }

  raster.touch(area)
}

const strengthOf = (selection: Raster | null, toDocument: Parameters<typeof coverageReader>[1]) => {
  const read = coverageReader(selection, toDocument)

  return (x: number, y: number) => read(x, y) / 255
}

/** The filter last applied, for Filter > Last Filter. */
let last: FilterSpec | null = null

export const lastFilter = (): FilterSpec | null => last

/** Apply a filter to the active layer (or its mask) through the selection, as one step; false when nothing changed. */
export async function applyFilterToDocument(doc: CanvasDocument, spec: FilterSpec, onTask?: (task: FilterTask) => void): Promise<boolean> {
  const target = paintTarget(doc)

  if (!target) {
    return false
  }

  const before = doc.state
  const area = filterTargetArea(target.raster, target.toDocument, doc.state.selection)

  if (!area) {
    throw new Error('The selection does not reach this layer')
  }

  doc.interacting = true

  try {
    const filtered = await filterArea(target.raster, area, spec, onTask)

    // Something else changed the document while the filter ran (an undo, Hermes): it does not land on top.
    if (doc.state !== before) {
      throw new Error('The image changed while the filter ran, so it was not applied')
    }

    const edit = new PixelEdit(target.raster)
    edit.prepare(area)
    mixInto(target.raster, area, filtered, strengthOf(doc.state.selection, target.toDocument))
    last = spec

    return commitPixels(doc, before, target, edit, FILTER_NAMES[spec.kind])
  } finally {
    doc.interacting = false
  }
}

/** The most pixels a preview filters: a larger layer is previewed on a reduced copy. */
const PREVIEW_PIXELS = 3_000_000

/** What a filter dialog previews on: the target, and the copy of its pixels (reduced when large) it works on. */
export interface PreviewBase {
  before: DocState
  target: PaintTarget
  work: Raster
  /** Work pixels per target pixel. */
  scale: number
}

export function previewBase(doc: CanvasDocument): PreviewBase | null {
  const target = paintTarget(doc)

  if (!target) {
    return null
  }

  const { raster } = target
  const scale = Math.min(1, Math.sqrt(PREVIEW_PIXELS / (raster.width * raster.height)))
  const work = scale < 1 ? resample(raster, Math.max(1, Math.round(raster.width * scale)), Math.max(1, Math.round(raster.height * scale))) : raster

  return { before: doc.state, target, work, scale }
}

/** The document showing a filter on the preview base (its settings scaled to the copy); null when the selection misses the layer. */
export async function previewState(base: PreviewBase, spec: FilterSpec, onTask: (task: FilterTask) => void): Promise<DocState | null> {
  const { target, work, scale } = base
  const toDocument = pixelToDocument(target.layer.transform, work.width, work.height)
  const placement = target.mask && target.layer.maskLinked === false && target.layer.maskPlacement ? target.layer.maskPlacement : target.layer.transform
  const workToDocument = target.mask ? pixelToDocument(placement, work.width, work.height) : toDocument
  const area = filterTargetArea(work, workToDocument, base.before.selection)

  if (!area) {
    return null
  }

  const filtered = await filterArea(work, area, scale < 1 ? scaledFilter(spec, scale) : spec, onTask)
  const shown = work.clone()
  mixInto(shown, area, filtered, strengthOf(base.before.selection, workToDocument))

  return withLayer(target.state, target.layer.id, target.mask ? { mask: shown } : { pixels: shown })
}
