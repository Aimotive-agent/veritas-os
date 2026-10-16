/*
 * Snapping for the tools: points and moving boxes pulled onto guides, the canvas's edges and
 * centre, and other layers' edges and centres, when they come within a few screen pixels (as the
 * View menu has it). While layers move, smart guides show what they line up with and how far they
 * are from their neighbours.
 */

import { atom } from 'nanostores'
import type { Vec2 } from '../../../../shared/canvas/comp-format.ts'
import { boxAround, contentBounds } from '../engine/align.ts'
import { type CanvasDocument, descendantIds, isShown } from '../engine/document.ts'
import type { View } from '../engine/gpu/view.ts'
import type { Rect } from '../engine/raster.ts'
import { type Gap, type GuideLine, linesOf, type SnapLine, smartGuides, snapBox, snapToLines } from '../engine/snapping.ts'
import { $viewOptions } from '../view-state.ts'

/** How close (screen pixels) a point or an edge comes to a line before it snaps. */
export const SNAP_REACH = 7

/** What the overlay shows while something moves: the lines it snapped to, smart guides and gaps. */
export interface SnapMarks {
  docKey: string
  snapped: SnapLine[]
  lines: GuideLine[]
  gaps: Gap[]
}

export const $snapMarks = atom<SnapMarks | null>(null)

/** A guide being pulled out of a ruler. */
export const $draftGuide = atom<{ docKey: string; axis: 'horizontal' | 'vertical'; position: number } | null>(null)

/** The layers that move with these (everything inside a moving folder). */
export function withInsides(doc: CanvasDocument, ids: Iterable<string>): Set<string> {
  const out = new Set<string>()

  for (const id of ids) {
    out.add(id)
    descendantIds(doc.state, id).forEach((inside) => out.add(inside))
  }

  return out
}

/** The other layers' boxes, as they show. */
function boxesOf(doc: CanvasDocument, exclude: ReadonlySet<string>): Rect[] {
  return doc.state.layers.filter((layer) => !layer.isGroup && !exclude.has(layer.id) && isShown(doc.state, layer)).flatMap((layer) => contentBounds(doc.state, layer) ?? [])
}

/** The lines things snap to on a document now, leaving out the layers in `exclude`; none when snapping is off. */
export function snapLines(doc: CanvasDocument, exclude: ReadonlySet<string> = new Set(), options: { guides?: boolean } = {}): SnapLine[] {
  const view = $viewOptions.get()

  if (!view.snap) {
    return []
  }

  return linesOf(view.snapCanvas ? doc.state : null, view.snapGuides && view.guides && options.guides !== false ? doc.state.guides : [], view.snapLayers ? boxesOf(doc, exclude) : [])
}

/** A document point pulled onto the nearest line within reach, each way on its own. */
export function snapPoint(doc: CanvasDocument, point: Vec2, view: View, options: { guides?: boolean } = {}): Vec2 {
  const lines = snapLines(doc, new Set(), options)

  if (!lines.length) {
    return point
  }

  const { delta } = snapToLines(point, lines, SNAP_REACH / view.zoom)

  return [point[0] + delta[0], point[1] + delta[1]]
}

/** A move under way: the moving layers' box, and the lines and boxes around them, worked out once. */
export interface MoveSnapper {
  /** Where an offset lands once snapped (whole pixels), showing the marks for it; `free` limits it to one axis. */
  offset(offset: Vec2, view: View, free?: 'x' | 'y'): Vec2
  /** The marks go when the move ends. */
  done(): void
}

export function moveSnapper(doc: CanvasDocument, ids: readonly string[]): MoveSnapper {
  const moving = withInsides(doc, ids)
  const box = boxAround(doc.state.layers.filter((layer) => moving.has(layer.id) && !layer.isGroup).flatMap((layer) => contentBounds(doc.state, layer) ?? []))
  const lines = box ? snapLines(doc, moving) : []
  const others = box ? boxesOf(doc, moving) : []
  const canvas = { x: 0, y: 0, width: doc.state.width, height: doc.state.height }

  return {
    offset(offset, view, free) {
      if (!box) {
        return offset
      }

      let [dx, dy] = offset
      let snapped: SnapLine[] = []

      if (lines.length) {
        const pulled = snapBox({ ...box, x: box.x + dx, y: box.y + dy }, lines, SNAP_REACH / view.zoom)
        dx = free === 'y' ? dx : Math.round(dx + pulled.delta[0])
        dy = free === 'x' ? dy : Math.round(dy + pulled.delta[1])
        snapped = pulled.lines.filter((line) => (line.axis === 'x' ? free !== 'y' : free !== 'x'))
      }

      if ($viewOptions.get().smartGuides || snapped.length) {
        const moved = { ...box, x: box.x + dx, y: box.y + dy }
        const smart = $viewOptions.get().smartGuides ? smartGuides(moved, others, canvas) : { lines: [], gaps: [] }
        $snapMarks.set({ docKey: doc.key, snapped, lines: smart.lines, gaps: smart.gaps })
      }

      return [dx, dy]
    },
    done() {
      $snapMarks.set(null)
    }
  }
}

/** The lines a move snapped to, the smart guides and the gaps, in CSS pixels. */
export function drawSnapMarks(context: CanvasRenderingContext2D, doc: CanvasDocument, view: View, size: { width: number; height: number }): void {
  const marks = $snapMarks.get()

  if (marks?.docKey !== doc.key) {
    return
  }

  const sx = (x: number) => Math.round(view.panX + x * view.zoom) + 0.5
  const sy = (y: number) => Math.round(view.panY + y * view.zoom) + 0.5
  context.save()
  context.lineWidth = 1
  context.strokeStyle = 'rgba(255, 64, 160, 0.9)'
  context.setLineDash([3, 3])

  for (const line of marks.snapped) {
    context.beginPath()

    if (line.axis === 'x') {
      context.moveTo(sx(line.value), 0)
      context.lineTo(sx(line.value), size.height)
    } else {
      context.moveTo(0, sy(line.value))
      context.lineTo(size.width, sy(line.value))
    }

    context.stroke()
  }

  context.setLineDash([])

  for (const line of marks.lines) {
    context.beginPath()

    if (line.axis === 'x') {
      context.moveTo(sx(line.at), sy(line.from))
      context.lineTo(sx(line.at), sy(line.to))
    } else {
      context.moveTo(sx(line.from), sy(line.at))
      context.lineTo(sx(line.to), sy(line.at))
    }

    context.stroke()
  }

  context.font = '10.5px system-ui, sans-serif'
  context.textAlign = 'center'
  context.textBaseline = 'middle'

  for (const gap of marks.gaps) {
    const [x0, y0, x1, y1] = gap.axis === 'x' ? [sx(gap.from), sy(gap.across), sx(gap.to), sy(gap.across)] : [sx(gap.across), sy(gap.from), sx(gap.across), sy(gap.to)]
    context.beginPath()
    context.moveTo(x0, y0)
    context.lineTo(x1, y1)
    context.stroke()
    const label = `${Math.round(gap.distance)}`
    const width = context.measureText(label).width + 8
    const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2]
    context.fillStyle = 'rgba(255, 64, 160, 0.95)'
    context.fillRect(cx - width / 2, cy - 7.5, width, 15)
    context.fillStyle = '#fff'
    context.fillText(label, cx, cy + 0.5)
  }

  context.restore()
}
