/*
 * The Edit, Select and Image menus' work on a Veritas Canvas document: selections, fills, clearing,
 * copy and paste (within the app, and images from other apps through the system clipboard), and
 * the canvas's size, crop, trim, turns and flips. Each change is one undoable step.
 */

import { defaultTransform, type Vec2 } from '../../../shared/canvas/comp-format.ts'
import { type Anchor, anchorOffset, cropCanvas, flipCanvas, resizeCanvas, rotateCanvas, scaleImage, type TrimBy, trimRect } from './engine/canvas-size.ts'
import { type CanvasDocument, type CanvasLayer, insertLayer, nextName, pixelLayer, placementFor, withLayer } from './engine/document.ts'
import { eraseRaster, fillRaster, type RGBA } from './engine/fill.ts'
import { boundsOf, pixelToDocument } from './engine/geometry.ts'
import { PixelEdit } from './engine/history.ts'
import { toRaster } from './engine/project.ts'
import { Raster, type Rect } from './engine/raster.ts'
import { selectionFromRaster, toDocumentPixels } from './engine/sampling.ts'
import { contractSelection, expandSelection, featherSelection, invertSelection, selectAll, type SelectionMode } from './engine/selection.ts'
import { notify } from './store.ts'
import { compositeOf } from './tools/screen.ts'
import { applySelection } from './tools/select.ts'
import { commitPixels, paintTarget, selectionStrength, targetArea } from './tools/target.ts'

// Selections.

export function selectEverything(doc: CanvasDocument): void {
  doc.commit('Select All', { ...doc.state, selection: selectAll(doc.state.width, doc.state.height) })
}

export function deselect(doc: CanvasDocument): void {
  if (doc.state.selection) {
    doc.lastSelection = doc.state.selection
    doc.commit('Deselect', { ...doc.state, selection: null })
  }
}

export function reselect(doc: CanvasDocument): void {
  const last = doc.lastSelection

  if (last && last.width === doc.state.width && last.height === doc.state.height && !doc.state.selection) {
    doc.commit('Reselect', { ...doc.state, selection: last })
  }
}

export function invertSelected(doc: CanvasDocument): void {
  if (doc.state.selection) {
    doc.commit('Inverse', { ...doc.state, selection: invertSelection(doc.state.selection) })
  }
}

export type SelectionChange = 'feather' | 'expand' | 'contract'

export function modifySelection(doc: CanvasDocument, change: SelectionChange, radius: number): void {
  const selection = doc.state.selection

  if (!selection || radius <= 0) {
    return
  }

  const next = change === 'feather' ? featherSelection(selection, radius) : change === 'expand' ? expandSelection(selection, radius) : contractSelection(selection, radius)
  doc.commit(change === 'feather' ? 'Feather' : change === 'expand' ? 'Expand' : 'Contract', { ...doc.state, selection: next })
}

/** Select a layer's pixels (or its mask's light): Select > Layer Pixels, or ⌘-click on a thumbnail. */
export function selectLayerPixels(doc: CanvasDocument, layer: CanvasLayer | undefined = doc.active, mask = false, mode: SelectionMode = 'new'): void {
  const raster = mask ? layer?.mask : layer?.pixels

  if (!layer || !raster) {
    notify(mask ? 'That layer has no mask' : 'That layer has no pixels to select', 'error')

    return
  }

  const placement = mask && layer.maskLinked === false && layer.maskPlacement ? layer.maskPlacement : layer.transform
  // A 1×1 mask covers its layer's whole box.
  const shape = selectionFromRaster(raster, pixelToDocument(placement, raster.width, raster.height), doc.state.width, doc.state.height)
  applySelection(doc, shape, mode, 'Load Selection')
}

// Filling and clearing.

/** Fill the selection (or the whole layer) on the active layer or its mask with a colour, as Edit > Fill does. */
export function fillSelection(doc: CanvasDocument, colour: RGBA, opacity = 1): void {
  const target = paintTarget(doc)

  if (!target) {
    return
  }

  const before = doc.state
  const selection = doc.state.selection
  const area = targetArea(target, selection?.opaqueBounds() ?? null)

  if (!area) {
    notify('The selection does not reach this layer', 'error')

    return
  }

  const edit = new PixelEdit(target.raster)
  edit.prepare(area)
  fillRaster(target.raster, area, colour, selectionStrength(target, selection, opacity))
  commitPixels(doc, before, target, edit, 'Fill')
}

/** Delete: the selected pixels go (hidden, on a mask); with nothing selected the layer goes, as before. */
export function clearSelection(doc: CanvasDocument, label = 'Clear'): boolean {
  const selection = doc.state.selection

  if (!selection) {
    return false
  }

  const target = paintTarget(doc)

  if (!target) {
    return true
  }

  const area = targetArea(target, selection.opaqueBounds())

  if (!area) {
    return true
  }

  const before = doc.state
  const edit = new PixelEdit(target.raster)
  edit.prepare(area)
  eraseRaster(target.raster, area, selectionStrength(target, selection))
  commitPixels(doc, before, target, edit, label)

  return true
}

// Copy and paste.

interface Clip {
  pixels: Raster
  /** Where it was in the document, so a paste lands in the same place. */
  x: number
  y: number
}

let clip: Clip | null = null

/** The selected pixels of the active layer (or of everything, `merged`), document-aligned, soft edges as alpha. */
function copiedPixels(doc: CanvasDocument, merged: boolean): Clip | null {
  const { selection, width, height } = doc.state
  let bounds: Rect | null = selection?.opaqueBounds() ?? (merged ? { x: 0, y: 0, width, height } : null)
  let pixels: Raster

  if (merged) {
    pixels = compositeOf(doc).crop(bounds!)
  } else {
    const layer = doc.active

    if (!layer?.pixels) {
      notify(layer ? `${layer.name} has no pixels to copy` : 'Pick a layer to copy from', 'error')

      return null
    }

    if (!bounds) {
      const box = boundsOf(layer.transform)
      bounds = { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.ceil(box.x + box.width) - Math.floor(box.x), height: Math.ceil(box.y + box.height) - Math.floor(box.y) }
    }

    pixels = toDocumentPixels(layer.pixels, pixelToDocument(layer.transform, layer.pixels.width, layer.pixels.height), bounds)
  }

  if (!bounds) {
    return null
  }

  if (selection) {
    for (let y = 0; y < bounds.height; y++) {
      for (let x = 0; x < bounds.width; x++) {
        const sx = bounds.x + x
        const sy = bounds.y + y
        const keep = sx >= 0 && sy >= 0 && sx < width && sy < height ? selection.data[sy * width + sx] : 0
        const o = (y * bounds.width + x) * 4 + 3
        pixels.data[o] = (pixels.data[o] * keep) / 255
      }
    }
  }

  return { pixels, x: bounds.x, y: bounds.y }
}

const rawOf = (raster: Raster) => ({ width: raster.width, height: raster.height, channels: raster.channels, data: new Uint8Array(raster.data.buffer, raster.data.byteOffset, raster.data.byteLength) })

/** Copy (⌘C), or Copy Merged (⇧⌘C): kept here for pasting in place, and put on the system clipboard as an image. */
export function copySelection(doc: CanvasDocument, merged = false): boolean {
  const copied = copiedPixels(doc, merged)

  if (!copied) {
    return false
  }

  clip = copied
  // Other apps get it too; very large copies stay in Veritas only.
  if (copied.pixels.width * copied.pixels.height <= 40_000_000) {
    window.heraldOS.canvas.copyImage(rawOf(copied.pixels)).catch(() => {})
  }

  return true
}

export function cutSelection(doc: CanvasDocument): void {
  if (!doc.state.selection) {
    notify('Select something to cut', 'error')

    return
  }

  if (copySelection(doc)) {
    clearSelection(doc, 'Cut')
  }
}

function pasteLayer(doc: CanvasDocument, pixels: Raster, at: Vec2, label: string): void {
  const layer = pixelLayer(nextName(doc.state), pixels, defaultTransform(pixels.width, pixels.height, at[0], at[1]))
  doc.commit(label, { ...insertLayer(doc.state, layer, placementFor(doc.state)), selection: null })
}

/** Paste (⌘V): what was copied here goes back where it was; an image from another app comes in centred (shrunk to fit). */
export async function paste(doc: CanvasDocument): Promise<void> {
  let pasted: Awaited<ReturnType<typeof window.heraldOS.canvas.pasteImage>> = null

  try {
    pasted = await window.heraldOS.canvas.pasteImage()
  } catch {
    pasted = null
  }

  if (clip && (!pasted || pasted.own)) {
    pasteLayer(doc, clip.pixels.clone(), [clip.x, clip.y], 'Paste')

    return
  }

  if (!pasted) {
    notify('There is no image on the clipboard to paste', 'error')

    return
  }

  const raster = await toRaster(pasted.image, 4)
  const { width, height } = doc.state
  const fit = Math.min(1, width / raster.width, height / raster.height)
  const w = Math.max(1, Math.round(raster.width * fit))
  const h = Math.max(1, Math.round(raster.height * fit))
  const layer = pixelLayer(nextName(doc.state), raster, defaultTransform(w, h, Math.round((width - w) / 2), Math.round((height - h) / 2)))
  doc.commit('Paste', { ...insertLayer(doc.state, layer, placementFor(doc.state)), selection: null })
}

/** ⌘J with a selection: its pixels as a new layer in the same place (⇧⌘J cuts them out). */
export function layerViaCopy(doc: CanvasDocument, cut = false): void {
  const copied = copiedPixels(doc, false)

  if (!copied) {
    return
  }

  const source = doc.active!
  const before = doc.state
  let state = doc.state

  if (cut) {
    const target = paintTarget(doc)
    const area = target && targetArea(target, doc.state.selection?.opaqueBounds() ?? null)

    if (target && area) {
      const edit = new PixelEdit(target.raster)
      edit.prepare(area)
      eraseRaster(target.raster, area, selectionStrength(target, doc.state.selection))
      const entry = edit.finish('Layer via Cut')
      const layer = pixelLayer(nextName(target.state), copied.pixels, defaultTransform(copied.pixels.width, copied.pixels.height, copied.x, copied.y))
      state = insertLayer(target.state, layer, { above: source.id })
      doc.commitFrom('Layer via Cut', before, entry ? [entry] : [], { ...state, selection: null })

      return
    }
  }

  const layer = pixelLayer(nextName(state), copied.pixels, defaultTransform(copied.pixels.width, copied.pixels.height, copied.x, copied.y))
  doc.commit('Layer via Copy', { ...insertLayer(state, layer, { above: source.id }), selection: null })
}

/** A text or shape layer as plain pixels (its text or shape details go). */
export function rasterize(doc: CanvasDocument): void {
  const layer = doc.active

  if (layer && (layer.text || layer.shape)) {
    doc.commit('Rasterize Layer', withLayer(doc.state, layer.id, { text: undefined, shape: undefined }))
  }
}

// The Image menu.

export function canvasSize(doc: CanvasDocument, width: number, height: number, anchor: Anchor): void {
  const { state } = doc

  if (width !== state.width || height !== state.height) {
    doc.commit('Canvas Size', resizeCanvas(state, width, height, anchorOffset(state, { width, height }, anchor)))
  }
}

export function imageSize(doc: CanvasDocument, width: number, height: number, resamplePixels: boolean): void {
  if (width !== doc.state.width || height !== doc.state.height) {
    doc.commit('Image Size', scaleImage(doc.state, width, height, resamplePixels))
  }
}

/** Image > Crop: the canvas cut to the selection's bounds. */
export function cropToSelection(doc: CanvasDocument): void {
  const bounds = doc.state.selection?.opaqueBounds()

  if (bounds) {
    doc.commit('Crop', { ...cropCanvas(doc.state, bounds), selection: null })
  }
}

export function trim(doc: CanvasDocument, by: TrimBy): void {
  const rect = trimRect(compositeOf(doc), by)

  if (!rect) {
    notify('Trimming would leave nothing', 'error')

    return
  }

  if (rect.width !== doc.state.width || rect.height !== doc.state.height) {
    doc.commit('Trim', cropCanvas(doc.state, rect))
  }
}

export function rotateCanvasBy(doc: CanvasDocument, turns: 1 | 2 | 3): void {
  doc.commit(turns === 2 ? 'Rotate Canvas 180°' : turns === 1 ? 'Rotate Canvas 90° Clockwise' : 'Rotate Canvas 90° Counter Clockwise', rotateCanvas(doc.state, turns))
}

export function flipCanvasWay(doc: CanvasDocument, horizontal: boolean): void {
  doc.commit(horizontal ? 'Flip Canvas Horizontal' : 'Flip Canvas Vertical', flipCanvas(doc.state, horizontal))
}
