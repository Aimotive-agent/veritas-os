/*
 * Select > Select and Mask: a workspace that refines the selection (or the active layer's mask)
 * along its edge. Settings preview on the canvas in one of the view modes, worked out on a reduced
 * copy of a large picture; the Refine Edge brush paints where the edge needs working out again
 * (hair, fur). OK refines at full size and sends the result to the selection, the layer's mask, a
 * new layer, or a new layer with a mask (the original hidden), as one step.
 */

import { atom } from 'nanostores'
import { defaultTransform } from '../../../shared/canvas/comp-format.ts'
import { type CanvasDocument, type CanvasLayer, type DocState, findLayer, insertLayer, pixelLayer, withLayer } from './engine/document.ts'
import { pixelToDocument } from './engine/geometry.ts'
import { maskFromSelection, maskPlacement } from './engine/masks.ts'
import { Raster, type Rect, resample } from './engine/raster.ts'
import { DEFAULT_REFINE, type RefineSettings, type RefineView } from './engine/refine-edge.ts'
import { selectionFromRaster, toDocumentPixels } from './engine/sampling.ts'
import type { RefineReply, RefineRequest } from './refine-worker.ts'
import { notify } from './store.ts'
import { compositeOf } from './tools/screen.ts'
import { $refineBrush, $tool, setTool, type ToolId } from './tools/state.ts'
import { type PointerInfo, redraw, type ToolHandler } from './tools/types.ts'

export type RefineOutput = 'selection' | 'mask' | 'layer' | 'layerMask'

export const REFINE_OUTPUTS: { id: RefineOutput; label: string }[] = [
  { id: 'selection', label: 'Selection' },
  { id: 'mask', label: 'Layer Mask' },
  { id: 'layer', label: 'New Layer' },
  { id: 'layerMask', label: 'New Layer with Layer Mask' }
]

export interface SelectMaskOptions {
  settings: RefineSettings
  view: RefineView
  output: RefineOutput
  decontaminate: boolean
  /** Decontaminate Colors' strength, 0 to 100. */
  amount: number
  /** Follow every layer's colours rather than the active layer's. */
  sampleAll: boolean
}

export interface SelectMaskSession extends SelectMaskOptions {
  docKey: string
  doc: CanvasDocument
  before: DocState
  /** The layer whose mask is refined; null for the selection. */
  maskLayerId: string | null
  /** The layer the colours (and a new layer's pixels) come from. */
  layerId: string | null
  /** Work pixels per document pixel (below 1 for a large picture). */
  scale: number
  workWidth: number
  workHeight: number
  /** The starting matte, the picture and the Refine brush's strokes, at work size. */
  input: Float32Array
  picture: Uint8ClampedArray
  painted: Uint8Array
  /** The brush strokes in document points, for drawing them. */
  strokes: { points: [number, number][]; size: number; erase: boolean }[]
  previousTool: ToolId
  busy: boolean
}

export const $selectMask = atom<SelectMaskSession | null>(null)

/** Settings carried from one session to the next, as photo editors remember them. */
let remembered: SelectMaskOptions = { settings: DEFAULT_REFINE, view: 'overlay', output: 'selection', decontaminate: false, amount: 100, sampleAll: false }

/** The most pixels the preview works on. */
const PREVIEW_PIXELS = 1_500_000

let worker: Worker | null = null

/** Refine in a worker (one at a time: a newer request ends the one under way). */
function refine(request: RefineRequest): Promise<Extract<RefineReply, { ok: true }>> {
  worker?.terminate()
  const running = new Worker(new URL('./refine-worker.ts', import.meta.url), { type: 'module', name: 'herald-canvas-refine' })
  worker = running

  return new Promise((resolve, reject) => {
    running.onmessage = (event: MessageEvent<RefineReply>) => {
      running.terminate()

      if (worker === running) {
        worker = null
      }

      if (event.data.ok) {
        resolve(event.data)
      } else {
        reject(new Error(event.data.error))
      }
    }
    running.onerror = (event) => {
      event.preventDefault()
      running.terminate()
      reject(new Error(event.message || 'Refining stopped'))
    }
    const transfer: Transferable[] = [request.matte.buffer, request.picture.buffer, ...(request.painted ? [request.painted.buffer] : []), ...(request.colours ? [request.colours.rgba.buffer] : [])]
    running.postMessage(request, transfer)
  })
}

/** A document-sized one-channel raster as values from 0 to 1. */
const toMatte = (raster: Raster): Float32Array => Float32Array.from(raster.data, (value) => value / 255)

/** What the edge follows: the active layer's pixels where they land in the document, or every layer together. */
function pictureOf(doc: CanvasDocument, state: DocState, layer: CanvasLayer | undefined, sampleAll: boolean): Raster {
  if (!sampleAll && layer?.pixels && !layer.isGroup && !layer.adjustment) {
    return toDocumentPixels(layer.pixels, pixelToDocument(layer.transform, layer.pixels.width, layer.pixels.height), { x: 0, y: 0, width: state.width, height: state.height })
  }

  return compositeOf(doc)
}

/** The matte a session starts from: the selection, or the targeted layer mask where it lands in the document. */
function startingMatte(doc: CanvasDocument): { matte: Raster; maskLayerId: string | null } | null {
  const { state } = doc
  const layer = doc.active

  if (doc.editingMask && layer?.mask) {
    const placement = maskPlacement(layer)
    const placed = selectionFromRaster(layer.mask, pixelToDocument(placement, layer.mask.width, layer.mask.height), state.width, state.height)

    return { matte: placed ?? new Raster(state.width, state.height, 1), maskLayerId: layer.id }
  }

  return state.selection ? { matte: state.selection, maskLayerId: null } : null
}

/** Open the workspace on the selection (or the targeted mask). */
export function startSelectMask(doc: CanvasDocument): void {
  if ($selectMask.get()) {
    return
  }

  const start = startingMatte(doc)

  if (!start) {
    notify('Select something first, or pick a layer’s mask, to refine its edge', 'error')

    return
  }

  const { width, height } = doc.state
  const scale = Math.min(1, Math.sqrt(PREVIEW_PIXELS / (width * height)))
  const workWidth = Math.max(1, Math.round(width * scale))
  const workHeight = Math.max(1, Math.round(height * scale))
  const layer = doc.active
  const picture = pictureOf(doc, doc.state, layer, remembered.sampleAll)
  const workPicture = scale < 1 ? resample(picture, workWidth, workHeight) : picture
  const workMatte = scale < 1 ? resample(start.matte, workWidth, workHeight) : start.matte
  const session: SelectMaskSession = {
    ...remembered,
    output: start.maskLayerId ? 'mask' : remembered.output === 'mask' && !layer ? 'selection' : remembered.output,
    docKey: doc.key,
    doc,
    before: doc.state,
    maskLayerId: start.maskLayerId,
    layerId: layer?.id ?? null,
    scale,
    workWidth,
    workHeight,
    input: toMatte(workMatte),
    picture: new Uint8ClampedArray(workPicture.data),
    painted: new Uint8Array(workWidth * workHeight),
    strokes: [],
    previousTool: $tool.get(),
    busy: false
  }
  doc.interacting = true
  $selectMask.set(session)
  setTool('refine')
  schedulePreview()
}

let previewTimer: ReturnType<typeof setTimeout> | undefined

/** Change the workspace's settings; the preview follows a moment later. */
export function updateSelectMask(change: Partial<SelectMaskOptions>): void {
  const session = $selectMask.get()

  if (!session) {
    return
  }

  const next = { ...session, ...change }

  // Following other layers' colours needs the picture read again.
  if (change.sampleAll !== undefined && change.sampleAll !== session.sampleAll) {
    const picture = pictureOf(session.doc, session.before, findLayer(session.before, session.layerId), change.sampleAll)
    next.picture = new Uint8ClampedArray((session.scale < 1 ? resample(picture, session.workWidth, session.workHeight) : picture).data)
  }

  $selectMask.set(next)
  schedulePreview()
}

function schedulePreview(): void {
  clearTimeout(previewTimer)
  previewTimer = setTimeout(() => void showPreview(), 90)
}

/** Settings measured in pixels, for the reduced preview. */
const scaledSettings = (settings: RefineSettings, scale: number): RefineSettings => ({ ...settings, radius: settings.radius * scale, feather: settings.feather * scale })

async function showPreview(): Promise<void> {
  const session = $selectMask.get()

  if (!session) {
    return
  }

  $selectMask.set({ ...session, busy: true })

  try {
    const reply = await refine({
      matte: session.input.slice(),
      picture: session.picture.slice(),
      width: session.workWidth,
      height: session.workHeight,
      settings: scaledSettings(session.settings, session.scale),
      painted: session.painted.slice(),
      view: session.view === 'ants' ? undefined : session.view
    })
    const current = $selectMask.get()

    if (!current || current.docKey !== session.docKey) {
      return
    }

    const { before, workWidth, workHeight } = current
    const matte = new Raster(workWidth, workHeight, 1, Uint8ClampedArray.from(reply.matte, (value) => value * 255))

    if (current.view === 'ants' || !reply.view) {
      current.doc.preview({ ...before, selection: current.scale < 1 ? resample(matte, before.width, before.height) : matte })
    } else {
      const shown = pixelLayer('Select and Mask preview', new Raster(workWidth, workHeight, 4, reply.view), defaultTransform(before.width, before.height))
      current.doc.preview({ ...before, layers: [...before.layers, shown], selection: null })
    }

    $selectMask.set({ ...current, busy: false })
  } catch (error) {
    // A newer preview took over: nothing to say.
    if (!(error instanceof Error && /terminated|stopped/i.test(error.message))) {
      notify(`Could not refine the edge: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }
}

function end(session: SelectMaskSession): void {
  clearTimeout(previewTimer)
  worker?.terminate()
  worker = null
  remembered = { settings: session.settings, view: session.view, output: session.output, decontaminate: session.decontaminate, amount: session.amount, sampleAll: session.sampleAll }
  $selectMask.set(null)
  session.doc.interacting = false
  setTool(session.previousTool === 'refine' ? 'move' : session.previousTool)
  redraw()
}

/** Close the workspace and put everything back. */
export function cancelSelectMask(): void {
  const session = $selectMask.get()

  if (!session) {
    return
  }

  end(session)
  session.doc.preview(session.before)
}

/** An OK under way: a second press waits for it. */
let applying = false

/** Refine at full size and send the result where the workspace says, as one step. */
export async function applySelectMask(): Promise<void> {
  const session = $selectMask.get()

  if (!session || applying) {
    return
  }

  applying = true

  try {
    await applySession(session)
  } finally {
    applying = false
  }
}

async function applySession(session: SelectMaskSession): Promise<void> {

  const { doc, before } = session
  const { width, height } = before
  const start = startingMatteFrom(session)
  const picture = pictureOf(doc, before, findLayer(before, session.layerId), session.sampleAll)
  const painted = session.scale < 1 ? resample(new Raster(session.workWidth, session.workHeight, 1, new Uint8ClampedArray(session.painted)), width, height).data : session.painted
  const layer = findLayer(before, session.layerId)
  const wantsPixels = session.output === 'layer' || session.output === 'layerMask'

  if (wantsPixels && (!layer?.pixels || layer.isGroup || layer.adjustment)) {
    notify('A new layer takes its pixels from the active layer: pick a layer with pixels, or output to the selection or a mask', 'error')

    return
  }

  const layerPixels = wantsPixels && layer?.pixels ? toDocumentPixels(layer.pixels, pixelToDocument(layer.transform, layer.pixels.width, layer.pixels.height), { x: 0, y: 0, width, height }) : null
  $selectMask.set({ ...session, busy: true })
  doc.preview(before)
  notify('Refining the edge at full size…')
  let reply: Extract<RefineReply, { ok: true }>

  try {
    reply = await refine({
      matte: start,
      picture: new Uint8ClampedArray(picture.data),
      width,
      height,
      settings: session.settings,
      painted: new Uint8Array(painted),
      ...(layerPixels && session.decontaminate ? { colours: { rgba: new Uint8ClampedArray(layerPixels.data), amount: session.amount / 100, reach: Math.max(4, Math.round(session.settings.radius + 4)) } } : {})
    })
  } catch (error) {
    notify(`Could not refine the edge: ${error instanceof Error ? error.message : String(error)}`, 'error')
    $selectMask.set({ ...session, busy: false })

    return
  }

  end(session)
  const matte = new Raster(width, height, 1, Uint8ClampedArray.from(reply.matte, (value) => value * 255))
  const colours = reply.colours && layerPixels ? new Raster(width, height, 4, reply.colours) : layerPixels
  doc.commit('Select and Mask', refinedState(before, session, matte, colours))
  notify(`Refined the edge into ${REFINE_OUTPUTS.find((output) => output.id === session.output)!.label.toLowerCase()}`)
}

/** The starting matte at full size. */
function startingMatteFrom(session: SelectMaskSession): Float32Array {
  const { before } = session

  if (session.maskLayerId) {
    const layer = findLayer(before, session.maskLayerId)

    if (layer?.mask) {
      const placed = selectionFromRaster(layer.mask, pixelToDocument(maskPlacement(layer), layer.mask.width, layer.mask.height), before.width, before.height)

      return placed ? toMatte(placed) : new Float32Array(before.width * before.height)
    }
  }

  return before.selection ? toMatte(before.selection) : new Float32Array(before.width * before.height)
}

/** The document with the refined matte sent where the session says. */
function refinedState(before: DocState, session: SelectMaskSession, matte: Raster, colours: Raster | null): DocState {
  const empty = !matte.opaqueBounds()
  const target = findLayer(before, session.maskLayerId ?? session.layerId)

  if (session.output === 'selection' || !target) {
    return { ...before, selection: empty ? null : matte }
  }

  if (session.output === 'mask') {
    return { ...withLayer(before, target.id, { mask: maskFromSelection(target, matte, false), maskEnabled: true, maskLinked: target.mask ? target.maskLinked : true }), selection: null }
  }

  const bounds: Rect = session.output === 'layer' ? (matte.opaqueBounds() ?? { x: 0, y: 0, width: 1, height: 1 }) : (colours?.opaqueBounds() ?? { x: 0, y: 0, width: before.width, height: before.height })
  const pixels = colours!.crop(bounds)

  if (session.output === 'layer') {
    // The pixels with the matte as their transparency.
    for (let y = 0; y < bounds.height; y++) {
      for (let x = 0; x < bounds.width; x++) {
        const o = (y * bounds.width + x) * 4 + 3
        pixels.data[o] = (pixels.data[o] * matte.data[(bounds.y + y) * before.width + bounds.x + x]) / 255
      }
    }
  }

  let layer: CanvasLayer = { ...pixelLayer(`${target.name} copy`, pixels, defaultTransform(bounds.width, bounds.height, bounds.x, bounds.y)) }

  if (session.output === 'layerMask') {
    layer = { ...layer, mask: matte.crop(bounds), maskEnabled: true, maskLinked: true }
  }

  const hidden = withLayer(before, target.id, { isVisible: false })

  return { ...insertLayer(hidden, layer, { above: target.id }), selection: null }
}

/** The Refine Edge brush: paints where the edge is worked out again (Alt takes strokes back). Enter applies, Escape cancels. */
let hovering: PointerInfo | null = null

function paint(session: SelectMaskSession, from: [number, number], to: [number, number], size: number, erase: boolean): void {
  const { painted, workWidth, workHeight, scale } = session
  const radius = Math.max(1, (size / 2) * scale)
  const steps = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) * scale / Math.max(1, radius / 3)))

  for (let s = 0; s <= steps; s++) {
    const cx = (from[0] + ((to[0] - from[0]) * s) / steps) * scale
    const cy = (from[1] + ((to[1] - from[1]) * s) / steps) * scale

    for (let y = Math.max(0, Math.floor(cy - radius)); y < Math.min(workHeight, Math.ceil(cy + radius)); y++) {
      for (let x = Math.max(0, Math.floor(cx - radius)); x < Math.min(workWidth, Math.ceil(cx + radius)); x++) {
        if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= radius) {
          painted[y * workWidth + x] = erase ? 0 : 255
        }
      }
    }
  }
}

export const refineTool: ToolHandler = {
  cursor: (_doc, at) => (at && $refineBrush.get().size * at.view.zoom >= 6 ? 'none' : 'crosshair'),

  hover(_doc, at) {
    hovering = at
    redraw()
  },

  down(doc, at) {
    const session = $selectMask.get()

    if (!session || session.docKey !== doc.key) {
      return null
    }

    const size = $refineBrush.get().size
    const stroke = { points: [[at.x, at.y]] as [number, number][], size, erase: at.alt }
    session.strokes.push(stroke)
    paint(session, [at.x, at.y], [at.x, at.y], size, at.alt)
    redraw()

    return {
      move: (now) => {
        const last = stroke.points[stroke.points.length - 1]
        stroke.points.push([now.x, now.y])
        paint(session, last, [now.x, now.y], size, stroke.erase)
        hovering = now
        redraw()
      },
      up: () => schedulePreview()
    }
  },

  key(_doc, event) {
    if (!$selectMask.get()) {
      return false
    }

    if (event.key === 'Enter') {
      void applySelectMask()

      return true
    }

    if (event.key === 'Escape') {
      cancelSelectMask()

      return true
    }

    return false
  },

  overlay(context, doc, view) {
    const session = $selectMask.get()

    if (session?.docKey !== doc.key) {
      return
    }

    context.save()
    context.lineCap = 'round'
    context.lineJoin = 'round'

    for (const stroke of session.strokes) {
      context.lineWidth = Math.max(1, stroke.size * view.zoom)
      context.strokeStyle = stroke.erase ? 'rgba(255, 80, 80, 0.25)' : 'rgba(80, 200, 255, 0.25)'
      context.beginPath()
      stroke.points.forEach(([x, y], i) => (i ? context.lineTo(view.panX + x * view.zoom, view.panY + y * view.zoom) : context.moveTo(view.panX + x * view.zoom, view.panY + y * view.zoom)))

      if (stroke.points.length === 1) {
        context.lineTo(view.panX + stroke.points[0][0] * view.zoom + 0.01, view.panY + stroke.points[0][1] * view.zoom)
      }

      context.stroke()
    }

    if (hovering) {
      const radius = ($refineBrush.get().size * view.zoom) / 2

      if (radius >= 3) {
        context.beginPath()
        context.arc(hovering.sx, hovering.sy, radius, 0, Math.PI * 2)
        context.lineWidth = 2.5
        context.strokeStyle = 'rgba(0, 0, 0, 0.55)'
        context.stroke()
        context.lineWidth = 1
        context.strokeStyle = 'rgba(255, 255, 255, 0.95)'
        context.stroke()
      }
    }

    context.restore()
  },

  release() {
    hovering = null
  }
}
