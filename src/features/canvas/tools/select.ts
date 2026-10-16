/*
 * The selection tools: the marquees (Shift for a square or a circle, Alt from the centre), the
 * lasso and the polygonal lasso, and the magic wand. Shift held at the press adds to the
 * selection, Alt takes away, both intersect; a marquee or lasso dragged from inside the selection
 * (nothing held) moves it, and a click without a drag deselects. Each change is one undoable step.
 */

import type { Vec2 } from '../../../../shared/canvas/comp-format.ts'
import type { CanvasDocument } from '../engine/document.ts'
import { similarPixels } from '../engine/fill.ts'
import { pixelToDocument } from '../engine/geometry.ts'
import type { View } from '../engine/gpu/view.ts'
import { Raster, type Rect } from '../engine/raster.ts'
import { toDocumentPixels } from '../engine/sampling.ts'
import { combineSelection, ellipsePoints, featherSelection, polygonMask, rectPoints, type SelectionMode, shiftSelection } from '../engine/selection.ts'
import { compositeOf } from './screen.ts'
import { snapPoint } from './snap.ts'
import { $marquee, $selectionMode, $wand } from './state.ts'
import { type PointerInfo, redraw, type ToolDrag, type ToolHandler } from './types.ts'

/** The mode a press asks for: Shift adds, Alt takes away, both intersect; otherwise the options bar's. */
export function modeFor(at: Pick<PointerInfo, 'shift' | 'alt'>): SelectionMode {
  return at.shift && at.alt ? 'intersect' : at.shift ? 'add' : at.alt ? 'subtract' : $selectionMode.get()
}

/** Put a shape into the selection as one step; with nothing to put in, a new selection deselects. */
export function applySelection(doc: CanvasDocument, shape: Raster | null, mode: SelectionMode, label: string): void {
  const current = doc.state.selection
  const next = shape ? combineSelection(current, shape, mode) : mode === 'new' ? null : current

  if (next === current) {
    return
  }

  if (!next && current) {
    doc.lastSelection = current
  }

  doc.commit(next ? label : 'Deselect', { ...doc.state, selection: next })
}

/** A box from a drag, squared with Shift and grown from the centre with Alt, on whole pixels. */
export function marqueeBox(from: Vec2, to: Vec2, square: boolean, fromCentre: boolean): Rect {
  let dx = Math.round(to[0]) - Math.round(from[0])
  let dy = Math.round(to[1]) - Math.round(from[1])

  if (square) {
    const side = Math.max(Math.abs(dx), Math.abs(dy))
    dx = (Math.sign(dx) || 1) * side
    dy = (Math.sign(dy) || 1) * side
  }

  const x = Math.round(from[0])
  const y = Math.round(from[1])

  if (fromCentre) {
    return { x: x - Math.abs(dx), y: y - Math.abs(dy), width: Math.abs(dx) * 2, height: Math.abs(dy) * 2 }
  }

  return { x: Math.min(x, x + dx), y: Math.min(y, y + dy), width: Math.abs(dx), height: Math.abs(dy) }
}

/** The selection being moved, and how far: the marching ants are drawn there until it is let go. */
export const movingSelection: { docKey: string | null; offset: Vec2 } = { docKey: null, offset: [0, 0] }

/** True when a document point is inside the selection (at least half selected). */
const insideSelection = (doc: CanvasDocument, x: number, y: number): boolean => {
  const selection = doc.state.selection
  const px = Math.floor(x)
  const py = Math.floor(y)

  return Boolean(selection && px >= 0 && py >= 0 && px < selection.width && py < selection.height && selection.data[py * selection.width + px] >= 128)
}

/** Drag the selection outline (not the pixels) by whole pixels. */
function moveSelection(doc: CanvasDocument, at: PointerInfo): ToolDrag {
  movingSelection.docKey = doc.key
  movingSelection.offset = [0, 0]

  return {
    move: (now) => {
      movingSelection.offset = [Math.round(now.x - at.x), Math.round(now.y - at.y)]
      redraw()
    },
    up: () => {
      const [dx, dy] = movingSelection.offset
      movingSelection.docKey = null
      const selection = doc.state.selection

      if ((dx || dy) && selection) {
        doc.commit('Move Selection', { ...doc.state, selection: shiftSelection(selection, dx, dy) })
      }

      redraw()
    },
    cancel: () => {
      movingSelection.docKey = null
      redraw()
    }
  }
}

/** What a selection tool is drawing right now, for the overlay. */
let drawing: { docKey: string; outline: Vec2[] } | null = null

/** A dashed outline through document points, in CSS pixels. */
export function drawOutline(context: CanvasRenderingContext2D, points: readonly Vec2[], view: View, closed: boolean): void {
  if (points.length < 2) {
    return
  }

  context.save()
  context.beginPath()
  points.forEach(([x, y], i) => {
    const sx = view.panX + x * view.zoom
    const sy = view.panY + y * view.zoom

    if (i) {
      context.lineTo(sx, sy)
    } else {
      context.moveTo(sx, sy)
    }
  })

  if (closed) {
    context.closePath()
  }

  context.lineWidth = 1
  context.strokeStyle = '#fff'
  context.stroke()
  context.setLineDash([4, 4])
  context.strokeStyle = '#000'
  context.stroke()
  context.restore()
}

function overlayDrawing(context: CanvasRenderingContext2D, doc: CanvasDocument, view: View): void {
  if (drawing?.docKey === doc.key) {
    drawOutline(context, drawing.outline, view, true)
  }
}

function marqueeTool(ellipse: boolean): ToolHandler {
  return {
    cursor: (doc, at) => (at && !at.shift && !at.alt && $selectionMode.get() === 'new' && insideSelection(doc, at.x, at.y) ? 'move' : 'crosshair'),

    down(doc, at) {
      const mode = modeFor(at)

      if (mode === 'new' && insideSelection(doc, at.x, at.y)) {
        return moveSelection(doc, at)
      }

      const from: Vec2 = snapPoint(doc, [at.x, at.y], at.view)
      let box: Rect | null = null

      return {
        move: (now) => {
          box = marqueeBox(from, snapPoint(doc, [now.x, now.y], now.view), now.shift, now.alt)
          drawing = { docKey: doc.key, outline: ellipse ? ellipsePoints(box) : rectPoints(box) }
          redraw()
        },
        up: () => {
          drawing = null
          redraw()

          if (!box || box.width < 1 || box.height < 1) {
            // A click deselects.
            if (mode === 'new') {
              applySelection(doc, null, 'new', 'Deselect')
            }

            return
          }

          let shape: Raster | null = polygonMask(doc.state.width, doc.state.height, ellipse ? ellipsePoints(box) : rectPoints(box))
          const feather = $marquee.get().feather

          if (feather > 0) {
            shape = featherSelection(shape, feather)
          }

          applySelection(doc, shape, mode, ellipse ? 'Elliptical Marquee' : 'Rectangular Marquee')
        },
        cancel: () => {
          drawing = null
          redraw()
        }
      }
    },

    overlay: overlayDrawing
  }
}

export const marqueeTools = { rect: marqueeTool(false), ellipse: marqueeTool(true) }

export const lassoTool: ToolHandler = {
  cursor: (doc, at) => (at && !at.shift && !at.alt && $selectionMode.get() === 'new' && insideSelection(doc, at.x, at.y) ? 'move' : 'crosshair'),

  down(doc, at) {
    const mode = modeFor(at)

    if (mode === 'new' && insideSelection(doc, at.x, at.y)) {
      return moveSelection(doc, at)
    }

    const points: Vec2[] = [[at.x, at.y]]
    drawing = { docKey: doc.key, outline: points }

    return {
      move: (_now, trail) => {
        for (const point of trail) {
          const last = points[points.length - 1]

          if (Math.hypot(point.x - last[0], point.y - last[1]) * point.view.zoom >= 1.5) {
            points.push([point.x, point.y])
          }
        }

        redraw()
      },
      up: () => {
        drawing = null
        redraw()
        const xs = points.map((point) => point[0])
        const ys = points.map((point) => point[1])

        if (points.length < 3 || Math.max(...xs) - Math.min(...xs) < 1 || Math.max(...ys) - Math.min(...ys) < 1) {
          if (mode === 'new') {
            applySelection(doc, null, 'new', 'Deselect')
          }

          return
        }

        applySelection(doc, polygonMask(doc.state.width, doc.state.height, points), mode, 'Lasso')
      },
      cancel: () => {
        drawing = null
        redraw()
      }
    }
  },

  overlay: overlayDrawing
}

/** The polygon being drawn with the polygonal lasso. */
let polygon: { docKey: string; points: Vec2[]; mode: SelectionMode; hover: Vec2 | null } | null = null

/** A point for the polygonal lasso: Shift keeps the side at a multiple of 45°. */
function polygonPoint(at: PointerInfo): Vec2 {
  const last = polygon?.points.at(-1)

  if (!at.shift || !last) {
    return [at.x, at.y]
  }

  const angle = Math.round(Math.atan2(at.y - last[1], at.x - last[0]) / (Math.PI / 4)) * (Math.PI / 4)
  const length = Math.hypot(at.x - last[0], at.y - last[1])

  return [last[0] + Math.cos(angle) * length, last[1] + Math.sin(angle) * length]
}

function closePolygon(doc: CanvasDocument): void {
  const drawn = polygon
  polygon = null
  redraw()

  if (drawn && drawn.docKey === doc.key && drawn.points.length >= 3) {
    applySelection(doc, polygonMask(doc.state.width, doc.state.height, drawn.points), drawn.mode, 'Polygonal Lasso')
  }
}

export const polygonLassoTool: ToolHandler = {
  cursor: () => 'crosshair',

  down(doc, at) {
    if (polygon && polygon.docKey !== doc.key) {
      polygon = null
    }

    if (!polygon) {
      polygon = { docKey: doc.key, points: [[at.x, at.y]], mode: modeFor(at), hover: null }
      redraw()

      return null
    }

    const [fx, fy] = polygon.points[0]

    // Back on the first point closes the shape.
    if (polygon.points.length >= 3 && Math.hypot(at.x - fx, at.y - fy) * at.view.zoom <= 8) {
      closePolygon(doc)

      return null
    }

    polygon.points.push(polygonPoint(at))
    redraw()

    return null
  },

  hover(doc, at) {
    if (polygon?.docKey === doc.key) {
      polygon.hover = at ? polygonPoint(at) : null
      redraw()
    }
  },

  doubleClick(doc) {
    closePolygon(doc)
  },

  key(doc, event) {
    if (!polygon || polygon.docKey !== doc.key) {
      return false
    }

    if (event.key === 'Enter') {
      closePolygon(doc)
    } else if (event.key === 'Escape') {
      polygon = null
      redraw()
    } else if (event.key === 'Backspace' || event.key === 'Delete') {
      polygon.points.pop()

      if (!polygon.points.length) {
        polygon = null
      }

      redraw()
    } else {
      return false
    }

    return true
  },

  overlay(context, doc, view) {
    if (polygon?.docKey === doc.key) {
      drawOutline(context, polygon.hover ? [...polygon.points, polygon.hover] : polygon.points, view, false)
    }
  },

  release() {
    polygon = null
  }
}

/** What the magic wand and the bucket look at: the active layer (or its mask) where it lands in the document, or every layer together. */
export function sampleSource(doc: CanvasDocument, allLayers: boolean, mask = false): Raster {
  const { width, height } = doc.state

  if (allLayers) {
    return compositeOf(doc)
  }

  const layer = doc.active
  const raster = mask ? layer?.mask : layer?.pixels

  if (!layer || !raster) {
    return new Raster(width, height, mask ? 1 : 4)
  }

  const placement = mask && layer.maskLinked === false && layer.maskPlacement ? layer.maskPlacement : layer.transform

  return toDocumentPixels(raster, pixelToDocument(placement, raster.width, raster.height), { x: 0, y: 0, width, height })
}

export const wandTool: ToolHandler = {
  cursor: () => 'crosshair',

  down(doc, at) {
    const { tolerance, contiguous, allLayers } = $wand.get()
    const region = similarPixels(sampleSource(doc, allLayers), at.x, at.y, tolerance, contiguous)

    if (region) {
      applySelection(doc, region, modeFor(at), 'Magic Wand')
    }

    return null
  }
}
