/*
 * Undo and redo for Veritas Canvas. Document changes are snapshots of the (immutable) document state;
 * pixel edits keep only the tiles a tool touched, before and after. History is bounded by memory,
 * not by a step count, so a few big edits and many small ones both fit.
 */

import { clipRect, type Raster, type Rect } from './raster.ts'

/** Who made a step, when it was not the person's own edit in the window. */
export type StepOrigin = 'command' | 'outside'

export interface HistoryEntry {
  label: string
  /** Roughly how much memory the entry holds. */
  bytes: number
  undo(): void
  redo(): void
  origin?: StepOrigin
}

/** One step as the History panel lists it. */
export interface HistoryStep {
  id: number
  label: string
  origin?: StepOrigin
}

const DEFAULT_LIMIT = 768 * 1024 * 1024

let nextEntryId = 1

export class History {
  private past: (HistoryEntry & { id: number })[] = []
  private future: (HistoryEntry & { id: number })[] = []
  private bytes = 0
  /** Steps let go of to stay within memory: the oldest state left is then not the opening one. */
  dropped = 0

  constructor(private readonly limitBytes = DEFAULT_LIMIT) {}

  /** The newest entry still applied, or 0 at the start: compare with a saved mark to know about edits. */
  get position(): number {
    return this.past.at(-1)?.id ?? 0
  }

  get canUndo(): boolean {
    return this.past.length > 0
  }

  get canRedo(): boolean {
    return this.future.length > 0
  }

  get undoLabel(): string | null {
    return this.past.at(-1)?.label ?? null
  }

  get redoLabel(): string | null {
    return this.future.at(-1)?.label ?? null
  }

  /** The applied steps, oldest first. */
  get labels(): string[] {
    return this.past.map((entry) => entry.label)
  }

  /** Every step oldest first: the applied ones, then the undone ones in the order redo takes them. */
  get steps(): HistoryStep[] {
    return [...this.past, ...[...this.future].reverse()].map(({ id, label, origin }) => ({ id, label, ...(origin ? { origin } : {}) }))
  }

  /** How many of `steps` are applied. */
  get applied(): number {
    return this.past.length
  }

  /** Record a change that has already happened. */
  push(entry: HistoryEntry): void {
    for (const dropped of this.future) {
      this.bytes -= dropped.bytes
    }

    this.future = []
    this.past.push({ ...entry, id: nextEntryId++ })
    this.bytes += entry.bytes

    // The oldest steps go first; the newest always stays even when it alone is over the limit.
    while (this.bytes > this.limitBytes && this.past.length > 1) {
      this.bytes -= this.past.shift()!.bytes
      this.dropped++
    }
  }

  /** Say who made the newest step (Hermes's commands, a change from outside the window). */
  tagLast(origin: StepOrigin): void {
    const last = this.past.at(-1)

    if (last) {
      last.origin = origin
    }
  }

  /** Undo or redo until `applied` steps are applied; answers the labels passed over. */
  goTo(applied: number): string[] {
    const target = Math.max(0, Math.min(this.past.length + this.future.length, Math.round(applied)))
    const passed: string[] = []

    while (this.past.length > target) {
      passed.push(this.undo()!)
    }

    while (this.past.length < target) {
      passed.push(this.redo()!)
    }

    return passed
  }

  undo(): string | null {
    const entry = this.past.pop()

    if (!entry) {
      return null
    }

    entry.undo()
    this.future.push(entry)

    return entry.label
  }

  redo(): string | null {
    const entry = this.future.pop()

    if (!entry) {
      return null
    }

    entry.redo()
    this.past.push(entry)

    return entry.label
  }

  clear(): void {
    this.past = []
    this.future = []
    this.bytes = 0
    this.dropped = 0
  }
}

/** Steps that undo and redo as one. */
export function combine(label: string, entries: HistoryEntry[]): HistoryEntry {
  return {
    label,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    undo: () => [...entries].reverse().forEach((entry) => entry.undo()),
    redo: () => entries.forEach((entry) => entry.redo())
  }
}

/** The side of the square tiles pixel history keeps. */
export const TILE = 128

/**
 * Pixel history for one raster: call `prepare` with each area before changing it, then `finish`
 * once the tool is done. Only the touched tiles are kept.
 */
export class PixelEdit {
  private readonly before = new Map<number, { rect: Rect; pixels: Uint8ClampedArray }>()
  private readonly columns: number

  constructor(readonly raster: Raster) {
    this.columns = Math.ceil(raster.width / TILE)
  }

  get touched(): boolean {
    return this.before.size > 0
  }

  prepare(area: Rect): void {
    const rect = clipRect(area, this.raster.width, this.raster.height)

    if (!rect) {
      return
    }

    for (let ty = Math.floor(rect.y / TILE); ty <= Math.floor((rect.y + rect.height - 1) / TILE); ty++) {
      for (let tx = Math.floor(rect.x / TILE); tx <= Math.floor((rect.x + rect.width - 1) / TILE); tx++) {
        const key = ty * this.columns + tx

        if (!this.before.has(key)) {
          const tile = { x: tx * TILE, y: ty * TILE, width: Math.min(TILE, this.raster.width - tx * TILE), height: Math.min(TILE, this.raster.height - ty * TILE) }
          this.before.set(key, { rect: tile, pixels: this.raster.read(tile) })
        }
      }
    }
  }

  /** Every pixel is about to change (a fill or a filter over the whole layer). */
  prepareAll(): void {
    this.prepare(this.raster.bounds)
  }

  /** What the tile holding pixel (x, y) held before the edit, once that tile is prepared (a brush redraws from it). */
  original(x: number, y: number): { rect: Rect; pixels: Uint8ClampedArray } | undefined {
    return this.before.get(Math.floor(y / TILE) * this.columns + Math.floor(x / TILE))
  }

  /** The history step, or null when no pixels were touched. */
  finish(label: string): HistoryEntry | null {
    if (!this.before.size) {
      return null
    }

    const tiles = [...this.before.values()].map(({ rect, pixels }) => ({ rect, before: pixels, after: this.raster.read(rect) }))
    const raster = this.raster

    return {
      label,
      bytes: tiles.reduce((sum, tile) => sum + tile.before.byteLength * 2, 0),
      undo: () => tiles.forEach((tile) => raster.write(tile.rect, tile.before)),
      redo: () => tiles.forEach((tile) => raster.write(tile.rect, tile.after))
    }
  }
}
