/*
 * The Move tool: drag the picked layers (Shift keeps to one axis); with "Pick the layer under the
 * pointer" on, or ⌘ held, the layer under the pointer is picked first. With transform controls
 * shown, or in Free Transform (⌘T), a frame goes around the picked layers: its handles scale
 * (Shift keeps the proportions, Alt scales from the centre), outside a corner turns it (Shift in
 * 15° steps) and a ⌘-drag on a corner distorts. Enter applies a Free Transform, Escape drops it.
 */

import type { LayerTransform, Vec2 } from '../../../../shared/canvas/comp-format.ts'
import { layerAt, movedState } from '../actions.ts'
import type { CanvasDocument } from '../engine/document.ts'
import { containsPoint } from '../engine/geometry.ts'
import { type FrameHit, handleCursor, hitFrame, type Quad, quadOf } from '../engine/transform.ts'
import { $autoSelect, $showTransform } from './state.ts'
import {
  beginDistort,
  cancelTransform,
  commitTransform,
  cornerAt,
  cornerIndex,
  cornersOf,
  distortTo,
  dragTo,
  drawFrame,
  insideQuad,
  nudgeSession,
  sessionFor,
  startTransform,
  type TransformSession,
  transformable
} from './transform.ts'
import { moveSnapper, snapPoint } from './snap.ts'
import { editTextLayer } from './type.ts'
import type { PointerInfo, ToolDrag, ToolHandler } from './types.ts'

/** How close (in screen pixels) the pointer must be to grab a handle. */
const REACH = 6

const ROTATE_SVG = `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'><g fill='none' stroke-linecap='round'><path d='M6 13a6.5 6.5 0 1 0 6-6.5' stroke='white' stroke-width='4'/><path d='M6 13a6.5 6.5 0 1 0 6-6.5' stroke='black' stroke-width='1.6'/></g><path d='M12 2.5v8l-4.5-4z' fill='black' stroke='white' stroke-width='1'/></svg>`
const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(ROTATE_SVG)}") 12 12, crosshair`

interface Shown {
  session: TransformSession | null
  corners: Quad
  frame: LayerTransform | null
}

/** The frame on screen, if any: the session's, or the transform controls' around the picked layers. */
function shownFrame(doc: CanvasDocument): Shown | null {
  const session = sessionFor(doc)

  if (session) {
    return { session, corners: cornersOf(session), frame: session.quad ? null : session.frame }
  }

  if (!$showTransform.get()) {
    return null
  }

  const found = transformable(doc)

  return found ? { session: null, corners: quadOf(found.frame), frame: found.frame } : null
}

type Grab = { kind: 'frame'; hit: FrameHit; frame: LayerTransform } | { kind: 'corner'; corner: number } | { kind: 'quad' }

function grabAt(doc: CanvasDocument, at: PointerInfo): Grab | null {
  const shown = shownFrame(doc)

  if (!shown) {
    return null
  }

  const point: Vec2 = [at.x, at.y]
  const reach = REACH / at.view.zoom

  if (!shown.frame) {
    const corner = cornerAt(shown.corners, point, reach)

    return corner !== null ? { kind: 'corner', corner } : insideQuad(shown.corners, point) ? { kind: 'quad' } : null
  }

  // In a Free Transform, dragging anywhere outside the frame turns it.
  const hit = hitFrame(shown.frame, point, reach) ?? (shown.session && !shown.session.transient ? 'rotate' : null)

  if (!hit) {
    return null
  }

  const corner = hit !== 'move' && hit !== 'rotate' ? cornerIndex(hit) : null

  if (corner !== null && (at.mod || shown.session?.distort)) {
    return { kind: 'corner', corner }
  }

  return { kind: 'frame', hit, frame: shown.frame }
}

function transformDrag(doc: CanvasDocument, at: PointerInfo, grab: Grab): ToolDrag | null {
  let session = sessionFor(doc) ?? startTransform(doc, { transient: true })

  if (!session) {
    return null
  }

  if (grab.kind !== 'frame') {
    const distorting = beginDistort(session)

    if (!distorting) {
      if (session.transient) {
        cancelTransform(doc)
      }

      return null
    }

    session = distorting
  }

  const startFrame = session.frame
  const startQuad = session.quad
  const start: Vec2 = [at.x, at.y]
  const transient = session.transient
  // The frame's box snaps when it moves; a handle of an unturned frame snaps on its own.
  const snapper = grab.kind === 'frame' && grab.hit === 'move' ? moveSnapper(doc, session.ids) : null
  const square = Math.abs(startFrame.rotation % 90) < 1e-6

  return {
    move: (now) => {
      const current = sessionFor(doc)

      if (!current) {
        return
      }

      if (grab.kind === 'frame') {
        let to: Vec2 = [now.x, now.y]

        if (snapper) {
          const [dx, dy] = snapper.offset([now.x - start[0], now.y - start[1]], now.view)
          to = [start[0] + dx, start[1] + dy]
        } else if (grab.hit !== 'rotate' && square) {
          to = snapPoint(doc, to, now.view)
        }

        dragTo(doc, current, startFrame, grab.hit, start, to, { constrain: now.shift, fromCentre: now.alt })
      } else if (startQuad) {
        distortTo(doc, current, startQuad, grab.kind === 'corner' ? grab.corner : 'move', [now.x - start[0], now.y - start[1]])
      }
    },
    up: () => {
      snapper?.done()

      if (transient) {
        commitTransform(doc)
      }
    },
    cancel: () => {
      snapper?.done()

      if (transient) {
        cancelTransform(doc)
      }
    }
  }
}

/** Drag the picked layers by whole pixels. */
function moveDrag(doc: CanvasDocument, at: PointerInfo): ToolDrag | null {
  if ($autoSelect.get() !== at.mod) {
    const hit = layerAt(doc, at.x, at.y)

    if (hit) {
      doc.select(hit.id, at.shift)
    }
  }

  const ids = doc.picked.map((layer) => layer.id)

  if (!ids.length) {
    return null
  }

  const before = doc.state
  let offset: Vec2 = [0, 0]
  const snapper = moveSnapper(doc, ids)
  doc.interacting = true

  return {
    move: (now) => {
      let dx = Math.round(now.x - at.x)
      let dy = Math.round(now.y - at.y)
      let free: 'x' | 'y' | undefined

      if (now.shift) {
        if (Math.abs(dx) > Math.abs(dy)) {
          dy = 0
          free = 'x'
        } else {
          dx = 0
          free = 'y'
        }
      }

      ;[dx, dy] = snapper.offset([dx, dy], now.view, free)

      if (dx !== offset[0] || dy !== offset[1]) {
        offset = [dx, dy]
        doc.preview(dx || dy ? movedState(before, ids, dx, dy) : before)
      }
    },
    up: () => {
      snapper.done()
      doc.interacting = false

      if (offset[0] || offset[1]) {
        doc.commitFrom('Move', before)
      }
    },
    cancel: () => {
      snapper.done()
      doc.interacting = false
      doc.preview(before)
    }
  }
}

export const moveTool: ToolHandler = {
  cursor(doc, at) {
    const grab = at && grabAt(doc, at)

    if (!grab) {
      return 'default'
    }

    if (grab.kind === 'corner') {
      return 'crosshair'
    }

    if (grab.kind === 'quad') {
      return 'move'
    }

    return grab.hit === 'move' ? 'move' : grab.hit === 'rotate' ? ROTATE_CURSOR : handleCursor(grab.frame, grab.hit)
  },

  down(doc, at) {
    const grab = grabAt(doc, at)

    if (grab) {
      return transformDrag(doc, at, grab)
    }

    // A click outside a Free Transform's frame does nothing; its frame is still being worked on.
    if (sessionFor(doc)) {
      return null
    }

    return moveDrag(doc, at)
  },

  doubleClick(doc, at) {
    const layer = layerAt(doc, at.x, at.y) ?? doc.active

    if (layer?.text && containsPoint(layer.transform, [at.x, at.y])) {
      void editTextLayer(doc, layer)
    }
  },

  key(doc, event) {
    const session = sessionFor(doc)

    if (!session) {
      return false
    }

    if (event.key === 'Enter') {
      commitTransform(doc)

      return true
    }

    if (event.key === 'Escape') {
      cancelTransform(doc)

      return true
    }

    const arrows: Record<string, Vec2> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    const arrow = arrows[event.key]

    if (arrow) {
      const step = event.shiftKey ? 10 : 1
      nudgeSession(doc, session, arrow[0] * step, arrow[1] * step)

      return true
    }

    return false
  },

  overlay(context, doc, view) {
    const shown = shownFrame(doc)

    if (shown) {
      drawFrame(context, shown.corners, view, Boolean(shown.frame))
    }
  },

  release(doc) {
    if (doc && sessionFor(doc)) {
      commitTransform(doc)
    }
  }
}
