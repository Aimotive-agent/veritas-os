/*
 * Moving guides in the view: with the Move tool, or with ⌘ held whatever the tool, a guide under
 * the pointer drags (snapping to layers and the canvas; Shift lets it go free). Dropped off the
 * canvas it is deleted. Locked or hidden guides stay put.
 */

import type { Guide } from '../../../../shared/canvas/comp-format.ts'
import type { CanvasDocument } from '../engine/document.ts'
import { onCanvas, withGuideMoved, withoutGuides } from '../engine/guides.ts'
import { $viewOptions } from '../view-state.ts'
import { snapPoint } from './snap.ts'
import type { PointerInfo, ToolDrag } from './types.ts'

/** How close (screen pixels) the pointer comes to a guide to grab it. */
const GRAB = 4

/** The guide under the pointer, when guides are shown and not locked. */
export function guideAt(doc: CanvasDocument, at: Pick<PointerInfo, 'x' | 'y' | 'view'>): Guide | null {
  const view = $viewOptions.get()

  if (!view.guides || view.lockGuides || !doc.state.guides.length) {
    return null
  }

  let best: Guide | null = null
  let distance = GRAB / at.view.zoom

  for (const guide of doc.state.guides) {
    const d = Math.abs((guide.axis === 'vertical' ? at.x : at.y) - guide.position)

    if (d <= distance) {
      best = guide
      distance = d
    }
  }

  return best
}

/** Drag a guide; it is one step, deleted when let go off the canvas. */
export function dragGuide(doc: CanvasDocument, guide: Guide): ToolDrag {
  const before = doc.state
  let position = guide.position
  doc.interacting = true

  return {
    move: (now) => {
      const raw = guide.axis === 'vertical' ? now.x : now.y
      const snapped = now.shift ? raw : guide.axis === 'vertical' ? snapPoint(doc, [raw, Number.NaN], now.view, { guides: false })[0] : snapPoint(doc, [Number.NaN, raw], now.view, { guides: false })[1]
      position = Math.round(snapped)
      doc.preview(withGuideMoved(before, guide.id, position))
    },
    up: () => {
      doc.interacting = false

      if (!onCanvas(before, guide.axis, position)) {
        doc.commitFrom('Delete Guide', before, [], withoutGuides(before, [guide.id]))
      } else if (position !== guide.position) {
        doc.commitFrom('Move Guide', before)
      } else {
        doc.preview(before)
      }
    },
    cancel: () => {
      doc.interacting = false
      doc.preview(before)
    }
  }
}
