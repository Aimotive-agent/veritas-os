/*
 * Object Select: click an object and it is selected. A segment-anything model encodes the picture
 * once (per version of the layer, or of everything with "All layers"), then each prompt takes a
 * moment: a click starts an object, Shift-click adds a part to it, Alt-click takes a part away,
 * and a dragged box selects what is inside it. The object goes with the selection there was by the
 * selection mode, and every change is one undoable step.
 */

import type { Vec2 } from '../../../../shared/canvas/comp-format.ts'
import { decode, encode } from '../ai/ml.ts'
import { ensureModel, modelReady } from '../ai/models.ts'
import type { CanvasDocument, CanvasLayer } from '../engine/document.ts'
import type { View } from '../engine/gpu/view.ts'
import { Raster, type Rect } from '../engine/raster.ts'
import { combineSelection, type SelectionMode } from '../engine/selection.ts'
import { notify } from '../store.ts'
import { drawOutline, marqueeBox, sampleSource } from './select.ts'
import { $objectSelect, $selectionMode } from './state.ts'
import { type PointerInfo, redraw, type ToolHandler } from './types.ts'

interface Prompt {
  x: number
  y: number
  /** 1 part of the object, 0 not part of it. */
  label: 0 | 1
}

interface Session {
  docKey: string
  source: string
  /** The selection when the object was started, which it goes with by `mode`. */
  before: Raster | null
  mode: SelectionMode
  points: Prompt[]
  box: Rect | null
  /** The selection this session last made: anything else there means the person moved on. */
  made: Raster | null
}

let session: Session | null = null
let dragging: { docKey: string; box: Rect } | null = null
let working = false

/** The encoded pictures, by what they show: their size as encoded. */
const encoded = new Map<string, { width: number; height: number }>()

const layerArrays = new WeakMap<readonly CanvasLayer[], number>()
let nextArray = 1

/** Every layer together with "All layers", or when the active layer has no pixels to look at. */
const looksAtAll = (doc: CanvasDocument): boolean => $objectSelect.get().allLayers || !doc.active?.pixels

/** What the model looks at, as a key: the active layer as placed, or every layer together, at their current pixels. */
function sourceKey(doc: CanvasDocument): string {
  const { width, height, layers } = doc.state

  if (looksAtAll(doc)) {
    if (!layerArrays.has(layers)) {
      layerArrays.set(layers, nextArray++)
    }

    const versions = layers.reduce((sum, layer) => sum + (layer.pixels?.version ?? 0) + (layer.mask?.version ?? 0), 0)

    return `${doc.key}:all:${layerArrays.get(layers)}:${versions}:${width}x${height}`
  }

  const layer = doc.active

  return `${doc.key}:${layer?.id}:${layer?.pixels?.id}:${layer?.pixels?.version}:${JSON.stringify(layer?.transform)}:${width}x${height}`
}

/** The picture encoded (once per version), with its encoded size. */
async function prepare(doc: CanvasDocument, key: string): Promise<{ width: number; height: number }> {
  const known = encoded.get(key)

  if (known) {
    return known
  }

  const pixels = sampleSource(doc, looksAtAll(doc))
  notify('Object Select: looking at the picture…')
  const size = await encode(key, pixels.data.slice(), pixels.width, pixels.height)
  encoded.clear()
  encoded.set(key, size)
  notify(size.backend === 'wasm' ? 'Object Select is ready (on the CPU; a GPU would be quicker)' : 'Object Select is ready')

  return size
}

/** The session's object, as a document-sized mask. */
async function objectMask(doc: CanvasDocument, current: Session): Promise<Raster> {
  const size = await prepare(doc, current.source)
  const sx = size.width / doc.state.width
  const sy = size.height / doc.state.height
  const points: [number, number][] = current.points.map((point) => [point.x * sx, point.y * sy])
  const labels: number[] = current.points.map((point) => point.label)

  if (current.box) {
    points.push([current.box.x * sx, current.box.y * sy], [(current.box.x + current.box.width) * sx, (current.box.y + current.box.height) * sy])
    labels.push(2, 3)
  }

  const values = await decode(current.source, points, labels, doc.state.width, doc.state.height)

  return new Raster(doc.state.width, doc.state.height, 1, new Uint8ClampedArray(values.buffer, values.byteOffset, values.byteLength))
}

async function update(doc: CanvasDocument, current: Session): Promise<void> {
  if (!(await ensureModel('efficientsam', 'Object Select'))) {
    session = null
    redraw()

    return
  }

  working = true

  try {
    const mask = await objectMask(doc, current)

    // The person may have moved on while the model worked.
    if (session !== current) {
      return
    }

    const next = combineSelection(current.before, mask, current.mode)
    current.made = next

    if (next !== doc.state.selection) {
      if (!next && doc.state.selection) {
        doc.lastSelection = doc.state.selection
      }

      doc.commit(next ? 'Object Select' : 'Deselect', { ...doc.state, selection: next })
    }
  } catch (error) {
    notify(`Object Select: ${error instanceof Error ? error.message : String(error)}`, 'error')
  } finally {
    working = false
    redraw()
  }
}

/** Is the session still the one that made the selection on screen? */
const live = (doc: CanvasDocument): Session | null => (session && session.docKey === doc.key && session.made === doc.state.selection && session.source === sourceKey(doc) ? session : null)

const modeOf = (at: Pick<PointerInfo, 'shift' | 'alt'>): SelectionMode => (at.shift && at.alt ? 'intersect' : at.shift ? 'add' : at.alt ? 'subtract' : $selectionMode.get())

function start(doc: CanvasDocument, at: PointerInfo, box: Rect | null): Session {
  return { docKey: doc.key, source: sourceKey(doc), before: doc.state.selection, mode: modeOf(at), points: box ? [] : [{ x: at.x, y: at.y, label: 1 }], box, made: null }
}

function click(doc: CanvasDocument, at: PointerInfo): void {
  if (at.x < 0 || at.y < 0 || at.x >= doc.state.width || at.y >= doc.state.height) {
    return
  }

  const current = live(doc)

  if (current && (at.shift || at.alt) && !(at.shift && at.alt)) {
    current.points = [...current.points, { x: at.x, y: at.y, label: at.alt ? 0 : 1 }]
  } else {
    session = start(doc, at, null)
  }

  redraw()
  void update(doc, session!)
}

function drawPoints(context: CanvasRenderingContext2D, current: Session, view: View): void {
  for (const point of current.points) {
    const x = view.panX + point.x * view.zoom
    const y = view.panY + point.y * view.zoom
    context.save()
    context.beginPath()
    context.arc(x, y, 5.5, 0, Math.PI * 2)
    context.fillStyle = point.label ? '#2fbf71' : '#e5484d'
    context.strokeStyle = '#fff'
    context.lineWidth = 1.5
    context.fill()
    context.stroke()
    context.beginPath()
    context.moveTo(x - 2.5, y)
    context.lineTo(x + 2.5, y)

    if (point.label) {
      context.moveTo(x, y - 2.5)
      context.lineTo(x, y + 2.5)
    }

    context.stroke()
    context.restore()
  }
}

export const objectSelectTool: ToolHandler = {
  cursor: () => (working ? 'progress' : 'crosshair'),

  down(doc, at) {
    const from: Vec2 = [at.x, at.y]
    let box: Rect | null = null

    return {
      move: (now) => {
        // A drag of a few screen pixels is a box; less is a click.
        if (Math.hypot(now.sx - at.sx, now.sy - at.sy) < 4 && !box) {
          return
        }

        box = marqueeBox(from, [now.x, now.y], false, false)
        dragging = { docKey: doc.key, box }
        redraw()
      },
      up: () => {
        dragging = null

        if (box && box.width >= 2 && box.height >= 2) {
          session = start(doc, at, box)
          redraw()
          void update(doc, session)
        } else {
          click(doc, at)
        }
      },
      cancel: () => {
        dragging = null
        redraw()
      }
    }
  },

  key(doc, event) {
    if (session?.docKey === doc.key && (event.key === 'Escape' || event.key === 'Enter')) {
      session = null
      redraw()

      return true
    }

    return false
  },

  overlay(context, doc, view) {
    if (dragging?.docKey === doc.key) {
      const { x, y, width, height } = dragging.box
      drawOutline(context, [[x, y], [x + width, y], [x + width, y + height], [x, y + height]], view, true)
    }

    const current = live(doc) ?? (session?.docKey === doc.key && working ? session : null)

    if (current) {
      // The box that asked for the object: a thin line, so it is not taken for a selection.
      if (current.box) {
        const { x, y, width, height } = current.box
        context.save()
        context.strokeStyle = 'rgba(77, 163, 255, 0.85)'
        context.lineWidth = 1
        context.strokeRect(Math.round(view.panX + x * view.zoom) + 0.5, Math.round(view.panY + y * view.zoom) + 0.5, Math.round(width * view.zoom), Math.round(height * view.zoom))
        context.restore()
      }

      drawPoints(context, current, view)
    }
  },

  release() {
    session = null
    dragging = null
  }
}

/** Start encoding as soon as the tool is picked, so the first click answers quickly. */
export function warmObjectSelect(doc: CanvasDocument): void {
  void (async () => {
    if (await modelReady('efficientsam')) {
      await prepare(doc, sourceKey(doc)).catch(() => {})
    }
  })()
}
