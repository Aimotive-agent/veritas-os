/*
 * Free Transform sessions. In a session (⌘T) drags add up until Enter applies them as one step or
 * Escape puts everything back; the Move tool's transform controls apply each drag as it ends. The
 * picked layers follow the frame through their placements, so their pixels are untouched. A
 * distort holds the layer's four corners and shows a quick warp while dragging; applying it bakes
 * the warp into new pixels at full resolution.
 */

import { atom } from 'nanostores'
import type { LayerTransform, Vec2 } from '../../../../shared/canvas/comp-format.ts'
import { type CanvasDocument, type CanvasLayer, descendantIds, type DocState } from '../engine/document.ts'
import { apply, decompose, type Mat, multiply, rotate, translate, unitToDocument } from '../engine/geometry.ts'
import type { View } from '../engine/gpu/view.ts'
import { boundsPlacement, dragFrame, follow, frameAround, type FrameDrag, type FrameHit, type Handle, isConvex, type Quad, quadOf, warpRaster } from '../engine/transform.ts'
import { notify } from '../store.ts'
import { redraw } from './types.ts'

export interface TransformSession {
  docKey: string
  /** The document when the session began; Escape goes back to it. */
  start: DocState
  /** Layers that follow the frame: the picked ones, and everything inside picked folders. */
  ids: string[]
  startFrame: LayerTransform
  frame: LayerTransform
  /** The four corners after a distort (one layer only). */
  quad: Quad | null
  /** Corner drags distort (Edit > Transform > Distort) instead of scaling. */
  distort: boolean
  /** Ends with its drag (the Move tool's controls) rather than with Enter. */
  transient: boolean
  /** What the drags did, for the step's name. */
  did: Set<Change>
  /** The state last shown, to notice a change made from elsewhere (Hermes, an undo). */
  shown: DocState
}

export const $transform = atom<TransformSession | null>(null)

type Change = 'move' | 'scale' | 'rotate' | 'flip' | 'distort'

const LABELS: Record<Change, string> = { move: 'Move', scale: 'Scale', rotate: 'Rotate', flip: 'Flip', distort: 'Distort' }

/** Pixels a distort preview may have while dragging, so it keeps up with the pointer. */
const PREVIEW_PIXELS = 600_000
/** Pixels a baked distort may have. */
const BAKED_PIXELS = 64_000_000

/** The layers a transform moves and the frame around them; null when nothing picked can move. */
export function transformable(doc: CanvasDocument): { ids: string[]; frame: LayerTransform } | null {
  const picked = doc.picked
  const ids = new Set<string>()

  for (const layer of picked) {
    ids.add(layer.id)
    descendantIds(doc.state, layer.id).forEach((inside) => ids.add(inside))
  }

  const members = doc.state.layers.filter((layer) => ids.has(layer.id) && !layer.isGroup)

  if (!members.length) {
    return null
  }

  const frame = members.length === 1 && picked.length === 1 && !picked[0].isGroup ? members[0].transform : frameAround(members.map((layer) => layer.transform))

  return frame ? { ids: [...ids], frame } : null
}

/** The session on a document, dropped when the document changed under it. */
export function sessionFor(doc: CanvasDocument): TransformSession | null {
  const session = $transform.get()

  if (!session || session.docKey !== doc.key) {
    return null
  }

  if (session.shown === doc.state) {
    return session
  }

  // Picking another layer changes only which one is active: the transform goes on.
  if (session.shown.layers === doc.state.layers && session.shown.selection === doc.state.selection && session.shown.width === doc.state.width && session.shown.height === doc.state.height) {
    const next = { ...session, shown: doc.state }
    $transform.set(next)

    return next
  }

  // Something else changed the document (an undo, Hermes): the session is over, and the preview stays as that change left it.
  $transform.set(null)
  doc.interacting = false

  return null
}

export function startTransform(doc: CanvasDocument, options: { distort?: boolean; transient?: boolean } = {}): TransformSession | null {
  const existing = sessionFor(doc)

  if (existing) {
    if (options.distort && !existing.distort) {
      return update(doc, { ...existing, distort: true })
    }

    return existing
  }

  const found = transformable(doc)

  if (!found) {
    notify('Pick a layer to transform', 'error')

    return null
  }

  const session: TransformSession = {
    docKey: doc.key,
    start: doc.state,
    ids: found.ids,
    startFrame: found.frame,
    frame: found.frame,
    quad: null,
    distort: Boolean(options.distort),
    transient: Boolean(options.transient),
    did: new Set(),
    shown: doc.state
  }
  $transform.set(session)
  doc.interacting = true

  return session
}

/** The layer a distort warps: the only one moving, with pixels. */
function distortLayer(session: TransformSession): CanvasLayer | null {
  const layers = session.start.layers.filter((layer) => session.ids.includes(layer.id) && !layer.isGroup)

  return layers.length === 1 && layers[0].pixels ? layers[0] : null
}

/** The document with every moving layer placed by the frame (and the distorted one warped). */
function framed(session: TransformSession, density?: number): DocState {
  const ids = new Set(session.ids)
  const warped = session.quad ? distortLayer(session) : null
  const layers = session.start.layers.map((layer): CanvasLayer => {
    if (!ids.has(layer.id)) {
      return layer
    }

    if (warped && layer.id === warped.id && session.quad && layer.pixels) {
      const side = Math.sqrt(layer.pixels.width * layer.pixels.height)
      const area = Math.max(1, Math.abs(layer.transform.size[0] * layer.transform.size[1]))
      const own = Math.max(1, Math.min(4, side / Math.sqrt(area)))
      const budget = density === undefined ? BAKED_PIXELS : PREVIEW_PIXELS
      const box = warpBox(session.quad)
      const scale = Math.min(own, Math.sqrt(budget / Math.max(1, box)))
      const { raster, bounds } = warpRaster(layer.pixels, session.quad, density ?? scale)
      const uniform = !layer.mask || (layer.mask.width === 1 && layer.mask.height === 1) || layer.maskLinked === false
      const mask = uniform ? layer.mask : warpRaster(layer.mask!, session.quad, raster.width / bounds.width).raster

      return { ...layer, pixels: raster, mask, transform: boundsPlacement(bounds), text: undefined, shape: undefined }
    }

    return {
      ...layer,
      transform: follow(layer.transform, session.startFrame, session.frame),
      ...(layer.maskPlacement ? { maskPlacement: follow(layer.maskPlacement, session.startFrame, session.frame) } : {})
    }
  })

  return { ...session.start, layers }
}

const warpBox = (quad: Quad): number => {
  const xs = quad.map((point) => point[0])
  const ys = quad.map((point) => point[1])

  return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))
}

/** Show a session's latest frame (a quick preview for a distort). */
function update(doc: CanvasDocument, session: TransformSession): TransformSession {
  const preview = session.quad ? Math.min(1, Math.sqrt(PREVIEW_PIXELS / Math.max(1, warpBox(session.quad)))) : undefined
  const state = session.quad || session.frame !== session.startFrame ? framed(session, preview) : session.start
  doc.preview(state)
  const next = { ...session, shown: doc.state }
  $transform.set(next)
  redraw()

  return next
}

/** A frame drag, from the frame as it was when the drag began. */
export function dragTo(doc: CanvasDocument, session: TransformSession, from: LayerTransform, hit: FrameHit, start: Vec2, to: Vec2, options: FrameDrag): TransformSession {
  const frame = dragFrame(from, hit, start, to, options)
  session.did.add(hit === 'move' ? 'move' : hit === 'rotate' ? 'rotate' : 'scale')

  return update(doc, { ...session, frame })
}

/** A distort drag: one corner (or, for 'move', all four) from where they were when the drag began. */
export function distortTo(doc: CanvasDocument, session: TransformSession, from: Quad, corner: number | 'move', delta: Vec2): TransformSession {
  const quad = from.map((point, i) => (corner === 'move' || corner === i ? [point[0] + delta[0], point[1] + delta[1]] : point)) as Quad

  if (!isConvex(quad)) {
    return session
  }

  session.did.add(corner === 'move' ? 'move' : 'distort')

  return update(doc, { ...session, quad })
}

/** Start distorting: the corners of the layer as the frame has it now; null (with a notice) when it cannot be distorted. */
export function beginDistort(session: TransformSession): TransformSession | null {
  if (session.quad) {
    return session
  }

  const layer = distortLayer(session)

  if (!layer) {
    notify('Distort works on one layer with pixels at a time', 'error')

    return null
  }

  const next = { ...session, quad: quadOf(follow(layer.transform, session.startFrame, session.frame)) }
  $transform.set(next)
  redraw()

  return next
}

/** The frame's corners now: the distort's, or the frame's. */
export const cornersOf = (session: TransformSession): Quad => session.quad ?? quadOf(session.frame)

/** Apply the session as one step. */
export function commitTransform(doc: CanvasDocument): void {
  const session = sessionFor(doc)
  $transform.set(null)
  doc.interacting = false

  if (!session) {
    return
  }

  if (session.quad) {
    doc.commitFrom('Distort', session.start, [], framed(session))
  } else if (session.frame !== session.startFrame) {
    const did = [...session.did]
    doc.commitFrom(session.transient && did.length === 1 ? LABELS[did[0]] : 'Free Transform', session.start)
  } else if (doc.state !== session.start) {
    doc.preview(session.start)
  }

  redraw()
}

/** Put everything back as it was before the session. */
export function cancelTransform(doc: CanvasDocument): void {
  const session = sessionFor(doc)
  $transform.set(null)
  doc.interacting = false

  if (session && doc.state !== session.start) {
    doc.preview(session.start)
  }

  redraw()
}

/** A frame turned around its centre, or mirrored across it, on its own axes. */
function changedFrame(frame: LayerTransform, change: { degrees?: number; flip?: 'horizontal' | 'vertical' }): LayerTransform {
  const m = unitToDocument(frame)

  if (change.flip) {
    const mirror: Mat = change.flip === 'horizontal' ? { a: -1, b: 0, c: 0, d: 1, e: 1, f: 0 } : { a: 1, b: 0, c: 0, d: -1, e: 0, f: 1 }

    return decompose(multiply(m, mirror), change.flip === 'horizontal' ? { ...frame, flipX: !frame.flipX } : { ...frame, flipY: !frame.flipY })
  }

  const [cx, cy] = apply(m, [0.5, 0.5])

  return decompose(multiply(multiply(translate(cx, cy), multiply(rotate(change.degrees ?? 0), translate(-cx, -cy))), m), frame)
}

/** Edit > Transform > Flip or Rotate: the picked layers (or the session's frame) at once. */
export function turnPicked(doc: CanvasDocument, change: { degrees?: number; flip?: 'horizontal' | 'vertical' }, label: string): void {
  const session = sessionFor(doc)

  if (session) {
    if (session.quad) {
      notify('Apply or cancel the distort first', 'error')

      return
    }

    session.did.add(change.flip ? 'flip' : 'rotate')
    update(doc, { ...session, frame: changedFrame(session.frame, change) })

    return
  }

  const found = transformable(doc)

  if (!found) {
    notify('Pick a layer to transform', 'error')

    return
  }

  const after = changedFrame(found.frame, change)
  const ids = new Set(found.ids)
  doc.commit(label, {
    ...doc.state,
    layers: doc.state.layers.map((layer) =>
      ids.has(layer.id) ? { ...layer, transform: follow(layer.transform, found.frame, after), ...(layer.maskPlacement ? { maskPlacement: follow(layer.maskPlacement, found.frame, after) } : {}) } : layer
    )
  })
}

/** Nudge the session's frame (arrow keys while transforming). */
export function nudgeSession(doc: CanvasDocument, session: TransformSession, dx: number, dy: number): void {
  if (session.quad) {
    distortTo(doc, session, session.quad, 'move', [dx, dy])

    return
  }

  session.did.add('move')
  update(doc, { ...session, frame: { ...session.frame, origin: [session.frame.origin[0] + dx, session.frame.origin[1] + dy] } })
}

// Drawing.

const HANDLE = 7

/** The frame (or distort corners) with its handles, in CSS pixels. */
export function drawFrame(context: CanvasRenderingContext2D, corners: Quad, view: View, withEdges: boolean, colour = '#4da3ff'): void {
  const screen = corners.map(([x, y]) => [view.panX + x * view.zoom, view.panY + y * view.zoom] as Vec2)
  context.save()
  context.lineWidth = 1
  context.strokeStyle = colour
  context.beginPath()
  screen.forEach(([x, y], i) => (i ? context.lineTo(x, y) : context.moveTo(x, y)))
  context.closePath()
  context.stroke()
  const points = withEdges ? [...screen, ...screen.map((point, i) => mid(point, screen[(i + 1) % 4]))] : screen

  for (const [x, y] of points) {
    context.fillStyle = '#fff'
    context.fillRect(Math.round(x - HANDLE / 2) + 0.5, Math.round(y - HANDLE / 2) + 0.5, HANDLE - 1, HANDLE - 1)
    context.strokeRect(Math.round(x - HANDLE / 2) + 0.5, Math.round(y - HANDLE / 2) + 0.5, HANDLE - 1, HANDLE - 1)
  }

  context.restore()
}

const mid = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]

/** Which distort corner a point is on, within `reach` document pixels. */
export function cornerAt(corners: Quad, point: Vec2, reach: number): number | null {
  let best: number | null = null
  let distance = reach

  corners.forEach(([x, y], i) => {
    const d = Math.hypot(point[0] - x, point[1] - y)

    if (d <= distance) {
      best = i
      distance = d
    }
  })

  return best
}

/** True when a point is inside a quad (any convex one). */
export function insideQuad(quad: Quad, [x, y]: Vec2): boolean {
  let sign = 0

  for (let i = 0; i < 4; i++) {
    const [ax, ay] = quad[i]
    const [bx, by] = quad[(i + 1) % 4]
    const cross = Math.sign((bx - ax) * (y - ay) - (by - ay) * (x - ax))

    if (cross && sign && cross !== sign) {
      return false
    }

    sign ||= cross
  }

  return true
}

const CORNERS: Partial<Record<Handle, number>> = { nw: 0, ne: 1, se: 2, sw: 3 }

/** Which corner of the frame's quad a handle is (null for an edge). */
export const cornerIndex = (handle: Handle): number | null => CORNERS[handle] ?? null
