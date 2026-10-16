/*
 * The composite at full size, for tools that look at all layers at once (the eyedropper, the magic
 * wand, the bucket with "all layers", the AI tools). It is rendered in tiles on the viewport's GPU
 * context, where the layers already are, and kept while the document stays as it is; without a
 * viewport the document is flattened offscreen instead.
 */

import type { CanvasDocument, DocState } from '../engine/document.ts'
import type { ScreenRenderer } from '../engine/gpu/view.ts'
import { flatten } from '../engine/project.ts'
import { clipRect, type Raster, type Rect } from '../engine/raster.ts'

let screen: ScreenRenderer | null = null

export function registerScreen(renderer: ScreenRenderer | null): void {
  screen = renderer
  kept = null
}

/** Does the processor draw the view (SwiftShader, llvmpipe)? Panels then redraw their previews less often. */
export const softwareRendering = (): boolean => Boolean(screen?.gpu.software)

/** The last whole composite, while its document is unchanged (large ones are not kept). */
let kept: { key: string; revision: number; raster: Raster } | null = null

const KEEP_PIXELS = 40_000_000

/** An area of the composite (all of it by default), document pixels, straight alpha, as the person sees it. */
export function compositeArea(doc: CanvasDocument, area?: Rect): Raster {
  const { width, height } = doc.state
  const box = area ? (clipRect(area, width, height) ?? { x: 0, y: 0, width: 1, height: 1 }) : { x: 0, y: 0, width, height }

  if (kept && kept.key === doc.key && kept.revision === doc.revision) {
    return box.width === width && box.height === height ? kept.raster : kept.raster.crop(box)
  }

  const small = screen?.readCached(doc, box)

  if (small) {
    return small
  }

  const raster = flatten(doc.state, 1, null, { area: box, compositor: screen?.compositor, overrides: screen?.overridesFor(doc) })
  // The screen's own composite was drawn over: it is made again on the next frame.
  screen?.borrowed()

  if (!area && width * height <= KEEP_PIXELS) {
    kept = { key: doc.key, revision: doc.revision, raster }
  }

  return raster
}

/** Every visible layer together, document sized, straight alpha. */
export const compositeOf = (doc: CanvasDocument): Raster => compositeArea(doc)

/** Some of a document's layers composited at a scale (1 is full size), drawn where the layers already are. */
export function renderLayers(state: DocState, only: ReadonlySet<string>, scale: number): Raster {
  const raster = flatten(state, scale, null, { only, compositor: screen?.compositor })
  screen?.borrowed()

  return raster
}

/** A small picture of the document as it is, at most `side` pixels on its long side. */
export function thumbnailOf(doc: CanvasDocument, side = 64): Raster {
  const scale = Math.min(1, side / Math.max(doc.state.width, doc.state.height))
  const raster = flatten(doc.state, scale, null, { compositor: screen?.compositor })
  screen?.borrowed()

  return raster
}

/** The composite's colour at a document pixel (straight RGBA), or null outside the canvas. */
export function compositeAt(doc: CanvasDocument, x: number, y: number): [number, number, number, number] | null {
  const px = Math.floor(x)
  const py = Math.floor(y)

  if (px < 0 || py < 0 || px >= doc.state.width || py >= doc.state.height) {
    return null
  }

  const raster = compositeArea(doc, { x: px, y: py, width: 1, height: 1 })

  return [raster.data[0], raster.data[1], raster.data[2], raster.data[3]]
}
