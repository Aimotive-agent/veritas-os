/*
 * What a tool is to the viewport: it takes pointer presses (and the drag that follows), shows a
 * cursor, draws its marks over the document (marquees, handles, the brush outline) and may take
 * keys while it is in hand. The viewport turns pointer events into document positions first.
 */

import { atom } from 'nanostores'
import type { CanvasDocument } from '../engine/document.ts'
import type { View } from '../engine/gpu/view.ts'
import { isMac } from '../platform.ts'

export interface PointerInfo {
  /** Document position (fractional pixels). */
  x: number
  y: number
  /** Viewport position, in CSS pixels. */
  sx: number
  sy: number
  shift: boolean
  alt: boolean
  /** ⌘ on the Mac, Ctrl elsewhere. */
  mod: boolean
  /** Pen pressure, 1 for a mouse. */
  pressure: number
  /** The view when the event came in (zoom turns screen distances into document ones). */
  view: View
}

export interface ToolDrag {
  /** The pointer moved with the button down; `trail` has every position since the last call (coalesced events). */
  move(at: PointerInfo, trail: PointerInfo[]): void
  up(at: PointerInfo): void
  /** The drag was interrupted (Escape, a lost pointer). */
  cancel?(): void
}

export interface ToolHandler {
  /** The button went down over the viewport; a drag keeps the pointer until it is released. */
  down(doc: CanvasDocument, at: PointerInfo): ToolDrag | null | void
  /** The pointer moved with no button down. */
  hover?(doc: CanvasDocument, at: PointerInfo | null): void
  doubleClick?(doc: CanvasDocument, at: PointerInfo): void
  /** The CSS cursor over the document. */
  cursor?(doc: CanvasDocument, at: PointerInfo | null): string
  /** Marks over the document, in CSS pixels (the context is scaled for the screen's density). */
  overlay?(context: CanvasRenderingContext2D, doc: CanvasDocument, view: View): void
  /** A key while the tool is in hand and nothing is being typed; true when it took it. */
  key?(doc: CanvasDocument, event: KeyboardEvent): boolean
  /** The tool is put down, or the document changes: finish or drop what is under way. */
  release?(doc: CanvasDocument | null): void
}

/** Bumped when a tool's marks change without the document changing, so the viewport redraws. */
export const $overlayTick = atom(0)

export const redraw = (): void => $overlayTick.set($overlayTick.get() + 1)

/** A screen distance (CSS pixels) in document pixels at the view's zoom. */
export const screenToDoc = (pixels: number, view: View): number => pixels / view.zoom

/** ⌘ on the Mac, Ctrl elsewhere. */
export const modKey = (event: { metaKey: boolean; ctrlKey: boolean }): boolean => (isMac ? event.metaKey : event.ctrlKey)
