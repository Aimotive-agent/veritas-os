/*
 * Align and distribute: where layers go so their edges or centres line up with each other, the
 * selection or the canvas, or so three or more are spread evenly. A layer is measured by what it
 * shows (its pixels' opaque area, a folder by everything in it), not by its box, so a logo on a
 * canvas-sized layer lines up by the logo. Offsets are whole pixels, so layers stay crisp.
 */

import type { Vec2 } from '../../../../shared/canvas/comp-format.ts'
import { type CanvasLayer, descendantIds, type DocState, isShown } from './document.ts'
import { apply, pixelToDocument } from './geometry.ts'
import type { Raster, Rect } from './raster.ts'

export const ALIGN_EDGES = ['left', 'center', 'right', 'top', 'middle', 'bottom'] as const
export type AlignEdge = (typeof ALIGN_EDGES)[number]

export const DISTRIBUTE_MODES = ['left', 'center', 'right', 'top', 'middle', 'bottom', 'horizontal', 'vertical'] as const
export type DistributeMode = (typeof DISTRIBUTE_MODES)[number]

/** What layers line up with: each other (their combined bounds), the selection's bounds, or the canvas. */
export type AlignTo = 'layers' | 'selection' | 'canvas'

export const ALIGN_LABELS: Record<AlignEdge, string> = {
  left: 'Align Left Edges',
  center: 'Align Horizontal Centres',
  right: 'Align Right Edges',
  top: 'Align Top Edges',
  middle: 'Align Vertical Centres',
  bottom: 'Align Bottom Edges'
}

export const DISTRIBUTE_LABELS: Record<DistributeMode, string> = {
  left: 'Distribute Left Edges',
  center: 'Distribute Horizontal Centres',
  right: 'Distribute Right Edges',
  top: 'Distribute Top Edges',
  middle: 'Distribute Vertical Centres',
  bottom: 'Distribute Bottom Edges',
  horizontal: 'Distribute Horizontal Spacing',
  vertical: 'Distribute Vertical Spacing'
}

/** Does the edge run across (left, centre, right: the layers move sideways)? */
export const isHorizontal = (edge: AlignEdge | DistributeMode): boolean => edge === 'left' || edge === 'center' || edge === 'right' || edge === 'horizontal'

/** Where a box's edge or centre sits along its axis. */
export function edgeOf(box: Rect, edge: AlignEdge): number {
  switch (edge) {
    case 'left':
      return box.x
    case 'center':
      return box.x + box.width / 2
    case 'right':
      return box.x + box.width
    case 'top':
      return box.y
    case 'middle':
      return box.y + box.height / 2
    case 'bottom':
      return box.y + box.height
  }
}

/** The offsets that put each box's edge (or centre) on the target's. */
export function alignOffsets(boxes: readonly Rect[], edge: AlignEdge, target: Rect): Vec2[] {
  const goal = edgeOf(target, edge)

  return boxes.map((box) => {
    const distance = goal - edgeOf(box, edge)

    return isHorizontal(edge) ? [distance, 0] : [0, distance]
  })
}

/**
 * Offsets that spread three or more boxes evenly: their edges or centres at even steps from the
 * outermost one to the other (those two stay), or, for `horizontal` and `vertical`, equal gaps
 * between neighbours across the span they cover. Fewer than three boxes stay where they are.
 */
export function distributeOffsets(boxes: readonly Rect[], mode: DistributeMode): Vec2[] {
  const out: Vec2[] = boxes.map(() => [0, 0])

  if (boxes.length < 3) {
    return out
  }

  const across = isHorizontal(mode)
  const start = (box: Rect) => (across ? box.x : box.y)
  const size = (box: Rect) => (across ? box.width : box.height)
  const put = (i: number, distance: number) => (out[i] = across ? [distance, 0] : [0, distance])

  if (mode === 'horizontal' || mode === 'vertical') {
    const order = boxes.map((_, i) => i).sort((a, b) => start(boxes[a]) - start(boxes[b]) || size(boxes[a]) - size(boxes[b]))
    const first = Math.min(...boxes.map(start))
    const last = Math.max(...boxes.map((box) => start(box) + size(box)))
    const gap = (last - first - boxes.reduce((sum, box) => sum + size(box), 0)) / (boxes.length - 1)
    let at = first

    for (const i of order) {
      put(i, at - start(boxes[i]))
      at += size(boxes[i]) + gap
    }

    return out
  }

  const order = boxes.map((_, i) => i).sort((a, b) => edgeOf(boxes[a], mode) - edgeOf(boxes[b], mode))
  const first = edgeOf(boxes[order[0]], mode)
  const last = edgeOf(boxes[order[order.length - 1]], mode)
  order.forEach((i, k) => put(i, first + ((last - first) * k) / (order.length - 1) - edgeOf(boxes[i], mode)))

  return out
}

/** The smallest box around several. */
export function boxAround(boxes: readonly Rect[]): Rect | null {
  if (!boxes.length) {
    return null
  }

  const x = Math.min(...boxes.map((box) => box.x))
  const y = Math.min(...boxes.map((box) => box.y))

  return { x, y, width: Math.max(...boxes.map((box) => box.x + box.width)) - x, height: Math.max(...boxes.map((box) => box.y + box.height)) - y }
}

const opaque = new WeakMap<Raster, { version: number; rect: Rect | null }>()

/** A raster's opaque area, worked out once per version. */
function opaqueArea(raster: Raster): Rect | null {
  const known = opaque.get(raster)

  if (known?.version === raster.version) {
    return known.rect
  }

  const rect = raster.opaqueBounds()
  opaque.set(raster, { version: raster.version, rect })

  return rect
}

/** What a layer shows, as a box in document pixels: its opaque pixels where they land, a folder's contents together; null for adjustments and empty layers. */
export function contentBounds(state: DocState, layer: CanvasLayer): Rect | null {
  if (layer.isGroup) {
    const inside = descendantIds(state, layer.id)

    return boxAround(state.layers.filter((entry) => inside.has(entry.id) && !entry.isGroup && isShown(state, entry)).flatMap((entry) => contentBounds(state, entry) ?? []))
  }

  if (!layer.pixels || layer.adjustment) {
    return null
  }

  const area = opaqueArea(layer.pixels)

  if (!area) {
    return null
  }

  const toDocument = pixelToDocument(layer.transform, layer.pixels.width, layer.pixels.height)
  const corners = [apply(toDocument, [area.x, area.y]), apply(toDocument, [area.x + area.width, area.y]), apply(toDocument, [area.x + area.width, area.y + area.height]), apply(toDocument, [area.x, area.y + area.height])]
  const xs = corners.map((point) => point[0])
  const ys = corners.map((point) => point[1])

  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }
}

/** The layers that move for a pick: a layer inside a picked folder moves with the folder, and layers that show nothing stay. */
export function movableLayers(state: DocState, ids: readonly string[]): { layer: CanvasLayer; box: Rect }[] {
  const picked = new Set(ids)
  const inside = new Set<string>()

  for (const id of ids) {
    descendantIds(state, id).forEach((entry) => inside.add(entry))
  }

  return state.layers.filter((layer) => picked.has(layer.id) && !inside.has(layer.id)).flatMap((layer) => {
    const box = contentBounds(state, layer)

    return box && box.width > 0 && box.height > 0 ? [{ layer, box }] : []
  })
}

/** The document with each layer (and what is inside a folder) moved by its offset, rounded to whole pixels. */
export function withOffsets(state: DocState, moves: readonly { layer: CanvasLayer; offset: Vec2 }[]): DocState {
  const shifts = new Map<string, Vec2>()

  for (const { layer, offset } of moves) {
    const dx = Math.round(offset[0])
    const dy = Math.round(offset[1])

    if (dx || dy) {
      for (const id of [layer.id, ...descendantIds(state, layer.id)]) {
        shifts.set(id, [dx, dy])
      }
    }
  }

  if (!shifts.size) {
    return state
  }

  return {
    ...state,
    layers: state.layers.map((layer) => {
      const shift = shifts.get(layer.id)

      // An unlinked mask stays where it is, as it does when the layer is dragged.
      return shift ? { ...layer, transform: { ...layer.transform, origin: [layer.transform.origin[0] + shift[0], layer.transform.origin[1] + shift[1]] } } : layer
    })
  }
}

export interface AlignRequest {
  /** One or two edges (one each way): left, center or right, and top, middle or bottom. */
  edges: readonly AlignEdge[]
  to: AlignTo
  /** Pixels kept clear of the canvas edges when aligning to the canvas. */
  margin?: number
  /** The selection's bounds, for `to: 'selection'`. */
  selection?: Rect | null
}

/** What lines up with what: the box layers align to. */
export function alignTarget(state: DocState, boxes: readonly Rect[], request: Pick<AlignRequest, 'to' | 'margin' | 'selection'>): Rect {
  if (request.to === 'selection') {
    if (!request.selection) {
      throw new Error('Nothing is selected to align to')
    }

    return request.selection
  }

  if (request.to === 'layers') {
    return boxAround(boxes) ?? { x: 0, y: 0, width: state.width, height: state.height }
  }

  const margin = Math.max(0, Math.min(request.margin ?? 0, state.width / 2, state.height / 2))

  return { x: margin, y: margin, width: state.width - margin * 2, height: state.height - margin * 2 }
}

/** Layers aligned as one change; `moved` counts the layers that moved. */
export function alignState(state: DocState, ids: readonly string[], request: AlignRequest): { state: DocState; moved: number } {
  const layers = movableLayers(state, ids)

  if (!layers.length) {
    throw new Error('None of those layers shows anything to align (folders align by what is in them; adjustment layers do not move)')
  }

  if (request.to === 'layers' && layers.length < 2) {
    throw new Error('Aligning to each other takes two or more layers: align one to the canvas or the selection')
  }

  const boxes = layers.map((entry) => entry.box)
  const target = alignTarget(state, boxes, request)
  const offsets: Vec2[] = boxes.map(() => [0, 0])

  for (const edge of request.edges) {
    alignOffsets(boxes, edge, target).forEach((offset, i) => {
      offsets[i] = [offsets[i][0] + offset[0], offsets[i][1] + offset[1]]
    })
  }

  const next = withOffsets(
    state,
    layers.map((entry, i) => ({ layer: entry.layer, offset: offsets[i] }))
  )

  return { state: next, moved: offsets.filter((offset) => Math.round(offset[0]) || Math.round(offset[1])).length }
}

/** Three or more layers spread evenly as one change. */
export function distributeState(state: DocState, ids: readonly string[], mode: DistributeMode): { state: DocState; moved: number } {
  const layers = movableLayers(state, ids)

  if (layers.length < 3) {
    throw new Error('Distributing takes three or more layers that show something')
  }

  const offsets = distributeOffsets(
    layers.map((entry) => entry.box),
    mode
  )
  const next = withOffsets(
    state,
    layers.map((entry, i) => ({ layer: entry.layer, offset: offsets[i] }))
  )

  return { state: next, moved: offsets.filter((offset) => Math.round(offset[0]) || Math.round(offset[1])).length }
}

/** Align to the selection when there is one, to each other with two or more layers, otherwise to the canvas (as photo editors do). */
export function automaticTarget(count: number, selected: boolean): AlignTo {
  return selected ? 'selection' : count >= 2 ? 'layers' : 'canvas'
}
