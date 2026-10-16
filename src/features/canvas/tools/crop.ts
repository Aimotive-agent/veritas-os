/*
 * The Crop tool: a box over the canvas (all of it at first) with handles to size it; drag outside
 * it for a new box, inside to move it. A ratio from the options bar holds the box to its shape.
 * Straighten turns the picture level along a line drawn on its horizon (or a wall), and the box
 * shrinks to what the turned picture fills. Enter crops the canvas to the box, the way Canvas Size
 * does: layers keep their pixels. Escape lets it go, turn included.
 */

import { atom } from 'nanostores'
import type { LayerTransform, Vec2 } from '../../../../shared/canvas/comp-format.ts'
import { cropCanvas, rotateLayers } from '../engine/canvas-size.ts'
import { type CropOptions, fitRatio, holdRatio, largestTurnedBox, ratioBoxFrom, ratioOf, straightenAngle } from '../engine/crop.ts'
import type { CanvasDocument, DocState } from '../engine/document.ts'
import type { View } from '../engine/gpu/view.ts'
import type { Rect } from '../engine/raster.ts'
import { dragFrame, handleCursor, hitFrame, quadOf } from '../engine/transform.ts'
import { notify } from '../store.ts'
import { snapPoint } from './snap.ts'
import { drawFrame } from './transform.ts'
import { redraw, type ToolHandler } from './types.ts'

export interface CropSession {
  docKey: string
  doc: CanvasDocument
  rect: Rect
  /** Degrees the picture is turned on screen (Straighten), applied with the crop. */
  angle: number
  /** The document before the turn, and the turned one on screen; null when nothing is turned. */
  start: DocState | null
  shown: DocState | null
}

export const $crop = atom<CropSession | null>(null)
export const $cropOptions = atom<CropOptions>({ ratio: 'free', custom: [4, 5], swapped: false })
/** The next drag draws a straighten line instead of a box. */
export const $straighten = atom(false)

const REACH = 6

/** The straighten line being drawn. */
let line: { docKey: string; from: Vec2; to: Vec2 } | null = null

const fullCanvas = (doc: CanvasDocument): Rect => ({ x: 0, y: 0, width: doc.state.width, height: doc.state.height })

const sessionOf = (doc: CanvasDocument): CropSession | null => {
  const crop = $crop.get()

  return crop?.docKey === doc.key ? crop : null
}

/** The crop box on a document: the one being set, or the whole canvas. */
export const cropRect = (doc: CanvasDocument): Rect => sessionOf(doc)?.rect ?? fullCanvas(doc)

/** How far the picture is turned in the crop under way. */
export const cropAngle = (doc: CanvasDocument): number => sessionOf(doc)?.angle ?? 0

/** The ratio the box is held to (width over height), or null. */
export const cropRatio = (doc: CanvasDocument): number | null => ratioOf($cropOptions.get(), sessionOf(doc)?.start ?? doc.state)

const asFrame = (rect: Rect): LayerTransform => ({ origin: [rect.x, rect.y], size: [rect.width, rect.height], rotation: 0, flipX: false, flipY: false, sampling: 'High quality' })

/** A frame as a box on whole pixels, whichever way it was dragged. */
function asRect(frame: LayerTransform): Rect {
  const [x0, y0] = frame.origin
  const x1 = x0 + frame.size[0]
  const y1 = y0 + frame.size[1]
  const x = Math.round(Math.min(x0, x1))
  const y = Math.round(Math.min(y0, y1))

  return { x, y, width: Math.max(1, Math.round(Math.max(x0, x1)) - x), height: Math.max(1, Math.round(Math.max(y0, y1)) - y) }
}

function setCrop(doc: CanvasDocument, rect: Rect): void {
  const current = sessionOf(doc)
  $crop.set(current ? { ...current, rect } : { docKey: doc.key, doc, rect, angle: 0, start: null, shown: null })
  redraw()
}

/** The largest box the ratio (or the canvas's own shape) allows in the picture as it is turned. */
function fittedBox(doc: CanvasDocument, ratio: number | null): Rect {
  const crop = sessionOf(doc)
  const base = crop?.start ?? doc.state

  if (crop?.angle) {
    return largestTurnedBox(base.width, base.height, crop.angle, ratio ?? base.width / base.height)
  }

  return ratio ? fitRatio(fullCanvas(doc), ratio) : fullCanvas(doc)
}

/** A change to the ratio options: the box takes the new shape, as large as fits. */
export function setCropOptions(doc: CanvasDocument, change: Partial<CropOptions>): void {
  $cropOptions.set({ ...$cropOptions.get(), ...change })
  const ratio = cropRatio(doc)

  if (ratio || sessionOf(doc)?.angle) {
    setCrop(doc, fittedBox(doc, ratio))
  } else {
    redraw()
  }
}

/** Turn the picture so the line comes out level; the box becomes the largest the turned picture fills. */
function straighten(doc: CanvasDocument, from: Vec2, to: Vec2): void {
  const crop = sessionOf(doc)
  const start = crop?.start ?? doc.state
  const angle = Math.round(((crop?.angle ?? 0) + straightenAngle(from, to)) * 100) / 100
  const shown = rotateLayers(start, angle)
  doc.interacting = true
  doc.preview(shown)
  const ratio = ratioOf($cropOptions.get(), start)
  $crop.set({ docKey: doc.key, doc, rect: largestTurnedBox(start.width, start.height, angle, ratio ?? start.width / start.height), angle, start, shown: doc.state })
  $straighten.set(false)
  notify(angle ? `Turned ${angle}°: Enter crops, Escape puts it back` : 'Already level')
  redraw()
}

/** Crop the canvas to the box (turning the picture first when it was straightened), as one step. */
export function applyCrop(doc: CanvasDocument): void {
  const crop = sessionOf(doc)
  const rect = cropRect(doc)
  $crop.set(null)
  redraw()

  if (crop?.start) {
    doc.interacting = false

    // Something else changed the layers meanwhile (Hermes, an undo): the turn is not applied over it.
    if (doc.state.layers !== crop.shown?.layers) {
      notify('The image changed while it was being straightened, so it was not cropped', 'error')

      return
    }

    doc.commitFrom(crop.angle ? 'Straighten' : 'Crop', crop.start, [], cropCanvas(doc.state, rect))

    return
  }

  const full = fullCanvas(doc)

  if (rect.x !== full.x || rect.y !== full.y || rect.width !== full.width || rect.height !== full.height) {
    doc.commit('Crop', cropCanvas(doc.state, rect))
  }
}

export function cancelCrop(): void {
  const crop = $crop.get()
  $crop.set(null)
  line = null

  if (crop?.start) {
    crop.doc.interacting = false

    if (crop.doc.state.layers === crop.shown?.layers) {
      crop.doc.preview(crop.start)
    }
  }

  redraw()
}

export const cropTool: ToolHandler = {
  cursor(doc, at) {
    if (!at || $straighten.get()) {
      return 'crosshair'
    }

    const frame = asFrame(cropRect(doc))
    const hit = hitFrame(frame, [at.x, at.y], REACH / at.view.zoom, 0)

    return !hit ? 'crosshair' : hit === 'move' ? 'move' : hit === 'rotate' ? 'crosshair' : handleCursor(frame, hit)
  },

  down(doc, at) {
    const start: Vec2 = [at.x, at.y]

    if ($straighten.get()) {
      line = { docKey: doc.key, from: start, to: start }

      return {
        move: (now) => {
          line = { docKey: doc.key, from: start, to: [now.x, now.y] }
          redraw()
        },
        up: (now) => {
          line = null

          if (Math.hypot(now.x - start[0], now.y - start[1]) * now.view.zoom < 6) {
            redraw()

            return
          }

          straighten(doc, start, [now.x, now.y])
        },
        cancel: () => {
          line = null
          redraw()
        }
      }
    }

    const frame = asFrame(cropRect(doc))
    const hit = hitFrame(frame, start, REACH / at.view.zoom, 0)
    const ratio = cropRatio(doc)

    if (hit && hit !== 'rotate') {
      return {
        move: (now) => {
          const to = hit === 'move' ? ([now.x, now.y] as Vec2) : snapPoint(doc, [now.x, now.y], now.view)
          const rect = asRect(dragFrame(frame, hit, start, to, { constrain: now.shift || Boolean(ratio), fromCentre: now.alt }))
          setCrop(doc, ratio && hit !== 'move' ? holdRatio(rect, ratio, hit) : rect)
        },
        up: () => {}
      }
    }

    const anchor = snapPoint(doc, start, at.view)

    return {
      move: (now) => {
        const to = snapPoint(doc, [now.x, now.y], now.view)

        if (ratio) {
          setCrop(doc, ratioBoxFrom(anchor, to, ratio))

          return
        }

        const reach = Math.max(Math.abs(to[0] - anchor[0]), Math.abs(to[1] - anchor[1]))
        const end: Vec2 = now.shift ? [anchor[0] + Math.sign(to[0] - anchor[0]) * reach, anchor[1] + Math.sign(to[1] - anchor[1]) * reach] : to
        setCrop(doc, asRect({ ...frame, origin: anchor, size: [end[0] - anchor[0], end[1] - anchor[1]] }))
      },
      up: () => {}
    }
  },

  key(doc, event) {
    if (event.key === 'Enter') {
      applyCrop(doc)

      return true
    }

    if (event.key === 'Escape' && ($crop.get() || $straighten.get())) {
      $straighten.set(false)
      cancelCrop()

      return true
    }

    return false
  },

  overlay(context, doc, view: View) {
    const rect = cropRect(doc)
    const x = view.panX + rect.x * view.zoom
    const y = view.panY + rect.y * view.zoom
    const width = rect.width * view.zoom
    const height = rect.height * view.zoom
    const page = { x: view.panX, y: view.panY, width: doc.state.width * view.zoom, height: doc.state.height * view.zoom }
    context.save()
    // What the crop cuts away is shaded.
    context.fillStyle = 'rgba(0, 0, 0, 0.45)'
    context.beginPath()
    context.rect(Math.min(page.x, x) - 4000, Math.min(page.y, y) - 4000, Math.max(page.width, width) + 8000, Math.max(page.height, height) + 8000)
    context.rect(x, y, width, height)
    context.fill('evenodd')
    // Thirds, for composing; a finer grid while straightening, to judge what is level.
    context.strokeStyle = 'rgba(255, 255, 255, 0.35)'
    context.lineWidth = 1
    context.beginPath()
    const lines = sessionOf(doc)?.angle || $straighten.get() ? [1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6] : [1 / 3, 2 / 3]

    for (const t of lines) {
      context.moveTo(x + width * t, y)
      context.lineTo(x + width * t, y + height)
      context.moveTo(x, y + height * t)
      context.lineTo(x + width, y + height * t)
    }

    context.stroke()
    context.restore()
    drawFrame(context, quadOf(asFrame(rect)), view, true, '#fff')

    if (line?.docKey === doc.key) {
      const [x0, y0] = [view.panX + line.from[0] * view.zoom, view.panY + line.from[1] * view.zoom]
      const [x1, y1] = [view.panX + line.to[0] * view.zoom, view.panY + line.to[1] * view.zoom]
      context.save()
      context.lineWidth = 3
      context.strokeStyle = 'rgba(0, 0, 0, 0.55)'
      context.beginPath()
      context.moveTo(x0, y0)
      context.lineTo(x1, y1)
      context.stroke()
      context.lineWidth = 1.2
      context.strokeStyle = '#fff'
      context.stroke()
      context.font = '11px system-ui, sans-serif'
      context.fillStyle = '#fff'
      context.fillText(`${straightenAngle(line.from, line.to)}°`, x1 + 10, y1 - 10)
      context.restore()
    }
  },

  release() {
    cancelCrop()
  }
}
