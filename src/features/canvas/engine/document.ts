/*
 * An open Veritas Canvas document. Its state is immutable and replaced on every change, so undo is
 * a swap back to an earlier state; pixels live in rasters shared between states and change only
 * through PixelEdit, which keeps its own history. Layers run bottom to top, each folder right
 * before its children, the order `.comp` uses.
 */

import {
  type AdjustmentKind,
  defaultAdjustment,
  defaultTransform,
  type Guide,
  type LayerRecord,
  LIMITS,
  newId,
  orderLayers
} from '../../../../shared/canvas/comp-format.ts'
import type { ColorTable } from './color-table.ts'
import { combine, History, type HistoryEntry } from './history.ts'
import type { Raster } from './raster.ts'

export type CanvasLayer = LayerRecord & {
  /** The layer's pixels; null for folders, adjustments and blank layers. */
  pixels: Raster | null
  /** A one-channel mask (white shows, black hides); null when the layer has none. */
  mask: Raster | null
  /** A Color Lookup layer's table, read from its `.cube` file; never part of the record. */
  table?: ColorTable | null
}

export interface DocState {
  width: number
  height: number
  resolution: number
  layers: readonly CanvasLayer[]
  activeLayerId: string | null
  guides: readonly Guide[]
  /** One value a document pixel (255 selected); null when nothing is selected, so everything is editable. */
  selection: Raster | null
}

// --- New layers --------------------------------------------------------------------------------

const baseLayer = (name: string, width: number, height: number): CanvasLayer => ({
  id: newId(),
  name,
  isVisible: true,
  transform: defaultTransform(width, height),
  isGroup: false,
  opacity: 1,
  blendMode: 'Normal',
  pixels: null,
  mask: null
})

export const pixelLayer = (name: string, pixels: Raster, transform = defaultTransform(pixels.width, pixels.height)): CanvasLayer => ({
  ...baseLayer(name, pixels.width, pixels.height),
  transform,
  pixels
})

/** An empty layer over the canvas; it gets pixels when something is painted on it. */
export const blankLayer = (name: string, width: number, height: number): CanvasLayer => baseLayer(name, width, height)

export const folderLayer = (name: string, width: number, height: number): CanvasLayer => ({ ...baseLayer(name, width, height), isGroup: true })

export const adjustmentLayer = (kind: AdjustmentKind, width: number, height: number): CanvasLayer => ({ ...baseLayer(kind, width, height), adjustment: defaultAdjustment(kind) })

/** "Layer 4" after "Layer 3": the next free number for a name. */
export function nextName(state: DocState, prefix = 'Layer'): string {
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\d+)$`)
  const highest = state.layers.reduce((max, layer) => Math.max(max, Number(pattern.exec(layer.name)?.[1] ?? 0)), 0)

  return `${prefix} ${highest + 1}`
}

// --- Reading the tree --------------------------------------------------------------------------

const indexes = new WeakMap<readonly CanvasLayer[], Map<string, CanvasLayer>>()

function byId(layers: readonly CanvasLayer[]): Map<string, CanvasLayer> {
  let map = indexes.get(layers)

  if (!map) {
    map = new Map(layers.map((layer) => [layer.id, layer]))
    indexes.set(layers, map)
  }

  return map
}

export const findLayer = (state: DocState, id: string | null | undefined): CanvasLayer | undefined => (id ? byId(state.layers).get(id) : undefined)

/** Siblings bottom to top: the root's when `parentID` is undefined. */
export const childrenOf = (state: DocState, parentID: string | undefined): CanvasLayer[] => state.layers.filter((layer) => layer.parentID === parentID)

/** Enclosing folders, nearest first. */
export function ancestorsOf(state: DocState, layer: CanvasLayer): CanvasLayer[] {
  const out: CanvasLayer[] = []
  let parent = findLayer(state, layer.parentID)

  while (parent && out.length <= LIMITS.depth) {
    out.push(parent)
    parent = findLayer(state, parent.parentID)
  }

  return out
}

/** Every layer inside a folder, at any depth. */
export function descendantIds(state: DocState, id: string): Set<string> {
  const out = new Set<string>()
  let grew = true

  while (grew) {
    grew = false

    for (const layer of state.layers) {
      if (layer.parentID && !out.has(layer.id) && (layer.parentID === id || out.has(layer.parentID))) {
        out.add(layer.id)
        grew = true
      }
    }
  }

  return out
}

/** Drawn: visible itself and inside visible folders. */
export const isShown = (state: DocState, layer: CanvasLayer): boolean => layer.isVisible && ancestorsOf(state, layer).every((folder) => folder.isVisible)

// --- Changing the tree -------------------------------------------------------------------------

export function withLayer(state: DocState, id: string, patch: Partial<CanvasLayer>): DocState {
  return { ...state, layers: state.layers.map((layer) => (layer.id === id ? { ...layer, ...patch } : layer)) }
}

/** A layer and everything inside it, in order. */
function subtree(state: DocState, id: string): CanvasLayer[] {
  const inside = descendantIds(state, id)

  return state.layers.filter((layer) => layer.id === id || inside.has(layer.id))
}

/** Where a new layer goes: above `above` (beside it), or at the top of `parentID` (the root when undefined). */
export interface Placement {
  above?: string
  parentID?: string
}

/** Insert layers (a subtree in order: its root first) at a placement. */
function insertAt(state: DocState, layers: CanvasLayer[], place: Placement): CanvasLayer[] {
  const [root, ...rest] = layers
  const anchor = findLayer(state, place.above)
  const parentID = anchor ? anchor.parentID : place.parentID
  const placed = [{ ...root, parentID }, ...rest]
  let index: number

  if (anchor) {
    const block = subtree(state, anchor.id)
    index = state.layers.indexOf(block[block.length - 1]) + 1
  } else if (parentID) {
    const block = subtree(state, parentID)
    index = state.layers.indexOf(block[block.length - 1]) + 1
  } else {
    index = state.layers.length
  }

  const out = [...state.layers]
  out.splice(index, 0, ...placed)

  return out
}

/** The default place for something new: above the active layer, or inside it when it is a folder. */
export function placementFor(state: DocState): Placement {
  const active = findLayer(state, state.activeLayerId)

  if (!active) {
    return {}
  }

  return active.isGroup ? { parentID: active.id } : { above: active.id }
}

function checkDepth(state: DocState, layers: readonly CanvasLayer[]): void {
  const next = { ...state, layers }

  for (const layer of layers) {
    if (ancestorsOf(next, layer).length >= LIMITS.depth) {
      throw new Error(`Folders can nest at most ${LIMITS.depth} deep`)
    }
  }
}

export function insertLayer(state: DocState, layer: CanvasLayer, place: Placement = placementFor(state)): DocState {
  if (state.layers.length >= LIMITS.layers) {
    throw new Error(`A document holds at most ${LIMITS.layers.toLocaleString()} layers`)
  }

  const layers = insertAt(state, [layer], place)
  checkDepth(state, layers)

  return { ...state, layers, activeLayerId: layer.id }
}

/** Remove layers with everything inside them; layers clipped to a removed one are released. */
export function removeLayers(state: DocState, ids: Iterable<string>): DocState {
  const gone = new Set<string>()

  for (const id of ids) {
    gone.add(id)
    descendantIds(state, id).forEach((inside) => gone.add(inside))
  }

  if (!gone.size) {
    return state
  }

  const index = state.layers.findIndex((layer) => gone.has(layer.id))
  const layers = state.layers
    .filter((layer) => !gone.has(layer.id))
    .map((layer) => (layer.maskSourceID && gone.has(layer.maskSourceID) ? { ...layer, maskSourceID: undefined } : layer))
  const active = gone.has(state.activeLayerId ?? '') ? (layers[Math.min(index, layers.length - 1)]?.id ?? null) : state.activeLayerId

  return { ...state, layers, activeLayerId: active }
}

/**
 * Move a layer (with its contents) into `parentID` at `index` among the new siblings, 0 being the
 * bottom. A clipped layer moved out of its clipping stack is released.
 */
export function moveLayer(state: DocState, id: string, parentID: string | undefined, index: number): DocState {
  const layer = findLayer(state, id)

  if (!layer || parentID === id || (parentID && descendantIds(state, id).has(parentID))) {
    return state
  }

  if (parentID && !findLayer(state, parentID)?.isGroup) {
    return state
  }

  const block = subtree(state, id)
  const moving = new Set(block.map((entry) => entry.id))
  const rest = { ...state, layers: state.layers.filter((entry) => !moving.has(entry.id)) }
  const siblings = childrenOf(rest, parentID)
  const clamped = Math.max(0, Math.min(index, siblings.length))
  const placed = [{ ...block[0], parentID }, ...block.slice(1)]
  let at: number

  if (clamped < siblings.length) {
    at = rest.layers.indexOf(siblings[clamped])
  } else if (siblings.length) {
    const last = subtree(rest, siblings[siblings.length - 1].id)
    at = rest.layers.indexOf(last[last.length - 1]) + 1
  } else if (parentID) {
    at = rest.layers.indexOf(findLayer(rest, parentID)!) + 1
  } else {
    at = rest.layers.length
  }

  const layers = [...rest.layers]
  layers.splice(at, 0, ...placed)
  checkDepth(state, layers)

  return releaseStrayClips({ ...state, layers }, [id])
}

/** Put layers in a new folder where the topmost of them was. */
export function groupLayers(state: DocState, ids: string[], folder: CanvasLayer): DocState {
  const picked = new Set(ids)
  // A layer inside a picked folder moves with the folder.
  const roots = state.layers.filter((layer) => picked.has(layer.id) && !ancestorsOf(state, layer).some((parent) => picked.has(parent.id)))

  if (!roots.length) {
    return state
  }

  const top = roots[roots.length - 1]
  const blocks = roots.map((root) => subtree(state, root.id))
  const moving = new Set(blocks.flat().map((layer) => layer.id))
  const inFolder = blocks.flatMap(([root, ...rest]) => [{ ...root, parentID: folder.id }, ...rest])
  const layers: CanvasLayer[] = []

  for (const layer of state.layers) {
    if (layer.id === top.id) {
      layers.push({ ...folder, isGroup: true, parentID: top.parentID }, ...inFolder)
    }

    if (!moving.has(layer.id)) {
      layers.push(layer)
    }
  }

  checkDepth(state, layers)

  return releaseStrayClips({ ...state, layers, activeLayerId: folder.id }, roots.map((root) => root.id))
}

/** Take a folder's contents out where it was, and drop the folder. */
export function ungroupLayer(state: DocState, folderId: string): DocState {
  const folder = findLayer(state, folderId)

  if (!folder?.isGroup) {
    return state
  }

  const children = childrenOf(state, folderId)
  const layers = state.layers.filter((layer) => layer.id !== folderId).map((layer) => (layer.parentID === folderId ? { ...layer, parentID: folder.parentID } : layer))

  return { ...state, layers, activeLayerId: children.at(-1)?.id ?? state.activeLayerId }
}

/** Copies (pixels included) right above each original; returns the copies' ids. */
export function duplicateLayers(state: DocState, ids: string[]): { state: DocState; ids: string[] } {
  const picked = new Set(ids)
  const roots = state.layers.filter((layer) => picked.has(layer.id) && !ancestorsOf(state, layer).some((parent) => picked.has(parent.id)))
  let next = state
  const copies: string[] = []

  for (const root of roots) {
    const block = subtree(next, root.id)
    const renamed = new Map(block.map((layer) => [layer.id, newId()]))
    const cloned = block.map((layer, i) => ({
      ...layer,
      id: renamed.get(layer.id)!,
      name: i === 0 ? `${layer.name} copy` : layer.name,
      parentID: i === 0 ? layer.parentID : renamed.get(layer.parentID!),
      maskSourceID: layer.maskSourceID ? (renamed.get(layer.maskSourceID) ?? layer.maskSourceID) : undefined,
      pixels: layer.pixels?.clone() ?? null,
      mask: layer.mask?.clone() ?? null
    }))

    if (next.layers.length + cloned.length > LIMITS.layers) {
      throw new Error(`A document holds at most ${LIMITS.layers.toLocaleString()} layers`)
    }

    next = { ...next, layers: insertAt(next, cloned, { above: root.id }) }
    copies.push(cloned[0].id)
  }

  return { state: { ...next, activeLayerId: copies.at(-1) ?? state.activeLayerId }, ids: copies }
}

/** The layer a clipping stack rests on: the base of the sibling below, or that sibling itself (never a folder or an adjustment, which have no pixels to clip to). */
function clipBaseBelow(state: DocState, layer: CanvasLayer): CanvasLayer | undefined {
  const siblings = childrenOf(state, layer.parentID)
  const below = siblings[siblings.indexOf(layer) - 1]

  if (!below) {
    return undefined
  }

  const base = below.maskSourceID ? findLayer(state, below.maskSourceID) : below

  return base && !base.isGroup && !base.adjustment ? base : undefined
}

/** Clip a layer to the one below it (joining that one's stack when it is clipped too), or release it. */
export function setClipped(state: DocState, id: string, clipped: boolean): DocState {
  const layer = findLayer(state, id)

  if (!layer || layer.isGroup) {
    return state
  }

  if (!clipped) {
    return layer.maskSourceID ? withLayer(state, id, { maskSourceID: undefined }) : state
  }

  const base = clipBaseBelow(state, layer)

  return base && base.id !== id ? withLayer(state, id, { maskSourceID: base.id }) : state
}

/** Moved layers that no longer sit in their base's stack let go of it. */
function releaseStrayClips(state: DocState, moved: string[]): DocState {
  let next = state

  for (const id of moved) {
    const layer = findLayer(next, id)

    if (layer?.maskSourceID && clipBaseBelow(next, layer)?.id !== layer.maskSourceID) {
      next = withLayer(next, id, { maskSourceID: undefined })
    }
  }

  return next
}

/** Layers in `.comp` order, whatever order a change left them in. */
export const normalized = (state: DocState): DocState => ({ ...state, layers: orderLayers(state.layers) })

// --- The document ------------------------------------------------------------------------------

/** Bytes of pixels only `before` holds: what keeping it in history costs. */
function retainedBytes(before: DocState, after: DocState): number {
  const kept = new Set<Raster>()

  for (const layer of after.layers) {
    if (layer.pixels) kept.add(layer.pixels)
    if (layer.mask) kept.add(layer.mask)
  }

  if (after.selection) {
    kept.add(after.selection)
  }

  let bytes = 512 + before.layers.length * 256

  for (const raster of [...before.layers.flatMap((layer) => [layer.pixels, layer.mask]), before.selection]) {
    if (raster && !kept.has(raster)) {
      bytes += raster.data.byteLength
    }
  }

  return bytes
}

let nextKey = 1

export interface DocumentInit {
  state: DocState
  name: string
  path?: string | null
  documentId?: string
  /** Manifest fields Veritas does not use, written back as they were. */
  extra?: Record<string, unknown>
  digest?: string | null
}

export class CanvasDocument {
  /** Identifies the open document in this window. */
  readonly key = `canvas-${nextKey++}`
  readonly history = new History()
  state: DocState
  name: string
  path: string | null
  documentId: string
  extra: Record<string, unknown>
  /** The project's digest when last read or written, to tell its own saves from someone else's. */
  digest: string | null
  /** `history.position` when last saved. */
  savedPosition = 0
  /** Which raster each image file on disk holds, and at which version. */
  readonly savedAssets = new Map<string, { raster: Raster; version: number }>()
  /** Which colour table each `.cube` file on disk holds (tables never change in place: a new one is new bytes). */
  readonly savedTables = new Map<string, Uint8Array>()
  /** Layers picked in the Layers panel along with the active one (not saved). */
  selectedIds: string[] = []
  /** Painting goes into the active layer's mask rather than its pixels (picked on its mask thumbnail). */
  maskTargeted = false
  /** A stroke, drag or text edit is under way: saving waits until it is done. */
  interacting = false
  /** The selection before the last Deselect, for Reselect. */
  lastSelection: Raster | null = null
  /** A small picture of the document as it opened, for the top of the History panel. */
  openingThumb: Raster | null = null
  /** Bumps on every change, for anything that redraws. */
  revision = 0
  private readonly listeners = new Set<() => void>()
  /** `history.position` right after Toggle Last State undid a step, so the next toggle redoes it. */
  private toggled: number | null = null
  /** While above 0, redraws wait (several steps undone at once redraw once). */
  private holding = 0
  private held = false

  constructor(init: DocumentInit) {
    this.state = normalized(init.state)
    this.name = init.name
    this.path = init.path ?? null
    this.documentId = init.documentId ?? newId()
    this.extra = init.extra ?? {}
    this.digest = init.digest ?? null
  }

  get modified(): boolean {
    return this.history.position !== this.savedPosition
  }

  get active(): CanvasLayer | undefined {
    return findLayer(this.state, this.state.activeLayerId)
  }

  /** Whether painting changes the active layer's mask rather than its pixels. */
  get editingMask(): boolean {
    return this.maskTargeted && Boolean(this.active?.mask)
  }

  layer(id: string | null | undefined): CanvasLayer | undefined {
    return findLayer(this.state, id)
  }

  /** The picked layers in stacking order: the selection, or the active layer alone. */
  get picked(): CanvasLayer[] {
    const ids = new Set([...this.selectedIds, this.state.activeLayerId ?? ''])

    return this.state.layers.filter((layer) => ids.has(layer.id))
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)

    return () => this.listeners.delete(listener)
  }

  /** Something visible changed (pixels included): redraw. */
  changed(): void {
    if (this.holding) {
      this.held = true

      return
    }

    this.revision++
    this.listeners.forEach((listener) => listener())
  }

  private restore(state: DocState): void {
    this.state = state
    this.selectedIds = this.selectedIds.filter((id) => findLayer(state, id))
    this.changed()
  }

  /** Swap in a new state as one undoable step, with any pixel steps taken alongside. */
  commit(label: string, next: DocState, pixelSteps: HistoryEntry[] = []): void {
    this.commitFrom(label, this.state, pixelSteps, next)
  }

  /** Show a state without recording it, while a drag or a slider is moving; `commitFrom` records it. */
  preview(next: DocState): void {
    this.state = next
    this.changed()
  }

  /** Record everything since `before` (the state when the drag started) as one step. */
  commitFrom(label: string, before: DocState, pixelSteps: HistoryEntry[] = [], next: DocState = this.state): void {
    if (next === before && !pixelSteps.length) {
      return
    }

    const after = next === before ? before : normalized(next)
    const steps: HistoryEntry[] = []

    if (after !== before) {
      steps.push({ label, bytes: retainedBytes(before, after), undo: () => this.restore(before), redo: () => this.restore(after) })
    }

    // State first: a layer that gets its pixels in this step must exist before they are painted back.
    this.history.push(combine(label, [...steps, ...pixelSteps]))
    this.state = after
    this.changed()
  }

  /** Pick a layer, and whether painting goes into its mask (not a history step: picking is not an edit). */
  select(id: string | null, extend = false, mask = false): void {
    this.maskTargeted = mask && Boolean(findLayer(this.state, id)?.mask)

    if (extend && id) {
      const current = new Set([...this.selectedIds, this.state.activeLayerId ?? ''].filter(Boolean))

      if (current.has(id) && current.size > 1) {
        current.delete(id)
      } else {
        current.add(id)
      }

      this.selectedIds = [...current]
      this.state = { ...this.state, activeLayerId: current.has(id) ? id : ([...current].at(-1) ?? null) }
    } else {
      this.selectedIds = []
      this.state = { ...this.state, activeLayerId: id }
    }

    this.changed()
  }

  undo(): string | null {
    const label = this.history.undo()

    if (label) {
      this.changed()
    }

    return label
  }

  redo(): string | null {
    const label = this.history.redo()

    if (label) {
      this.changed()
    }

    return label
  }

  /** Go back or forward to the state after `applied` steps (0 is the opening state); answers the labels passed over. */
  goTo(applied: number): string[] {
    let passed: string[]
    this.holding++

    try {
      passed = this.history.goTo(applied)
    } finally {
      this.holding--
    }

    if (passed.length || this.held) {
      this.held = false
      this.changed()
    }

    return passed
  }

  /** Toggle Last State: undo the last step, or redo it when the last toggle undid it. */
  toggleLast(): string | null {
    if (this.toggled !== null && this.toggled === this.history.position && this.history.canRedo) {
      this.toggled = null

      return this.redo()
    }

    const label = this.undo()
    this.toggled = label ? this.history.position : null

    return label
  }

  /** The document as saved: nothing to undo, nothing modified. */
  markSaved(digest: string | null): void {
    this.digest = digest
    this.savedPosition = this.history.position
    this.changed()
  }
}
