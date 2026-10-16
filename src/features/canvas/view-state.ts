/*
 * Where each open document sits in the viewport (zoom and pan), kept while switching tabs but not
 * saved, and the zoom steps the menus and shortcuts move through.
 */

import { atom } from 'nanostores'
import type { CanvasDocument } from './engine/document.ts'
import { fitView, MAX_ZOOM, MIN_ZOOM, type View, zoomAt } from './engine/gpu/view.ts'

export const $views = atom<Record<string, View>>({})

/** The viewport's size in CSS pixels (one viewport a window). */
export const viewport = { width: 800, height: 600 }

/** The document position under the pointer, for the status bar; null when it is outside. */
export const $pointer = atom<{ x: number; y: number } | null>(null)

/** View menu switches, kept between sessions. */
export interface ViewOptions {
  rulers: boolean
  guides: boolean
  lockGuides: boolean
  snap: boolean
  snapGuides: boolean
  snapLayers: boolean
  snapCanvas: boolean
  smartGuides: boolean
}

const VIEW_OPTIONS_KEY = 'herald-canvas.view'

const DEFAULT_VIEW: ViewOptions = { rulers: false, guides: true, lockGuides: false, snap: true, snapGuides: true, snapLayers: true, snapCanvas: true, smartGuides: true }

function storedView(): ViewOptions {
  try {
    return { ...DEFAULT_VIEW, ...JSON.parse(globalThis.localStorage?.getItem(VIEW_OPTIONS_KEY) ?? '{}') }
  } catch {
    return DEFAULT_VIEW
  }
}

export const $viewOptions = atom<ViewOptions>(storedView())

export function setViewOption<K extends keyof ViewOptions>(key: K, value: ViewOptions[K]): void {
  const next = { ...$viewOptions.get(), [key]: value }
  $viewOptions.set(next)
  globalThis.localStorage?.setItem(VIEW_OPTIONS_KEY, JSON.stringify(next))
}

export type PanelTab = 'properties' | 'history'

const PANEL_TAB_KEY = 'herald-canvas.panel-tab'

/** Which panel shares the side with the Layers panel. */
export const $panelTab = atom<PanelTab>(globalThis.localStorage?.getItem(PANEL_TAB_KEY) === 'history' ? 'history' : 'properties')

export function showPanel(tab: PanelTab): void {
  $panelTab.set(tab)
  globalThis.localStorage?.setItem(PANEL_TAB_KEY, tab)
}

export function viewOf(doc: CanvasDocument): View {
  return $views.get()[doc.key] ?? fitView(viewport.width, viewport.height, doc.state.width, doc.state.height)
}

export function setView(doc: CanvasDocument, view: View): void {
  $views.set({ ...$views.get(), [doc.key]: view })
}

export function forgetView(key: string): void {
  const { [key]: _gone, ...rest } = $views.get()
  $views.set(rest)
}

/** The whole document in view, as large as fits (or no larger than `maxZoom`). */
export const fitToScreen = (doc: CanvasDocument, maxZoom = MAX_ZOOM): void => setView(doc, fitView(viewport.width, viewport.height, doc.state.width, doc.state.height, maxZoom))

/** One document pixel to one screen pixel, centred. */
export function actualPixels(doc: CanvasDocument): void {
  setView(doc, { zoom: 1, panX: Math.round((viewport.width - doc.state.width) / 2), panY: Math.round((viewport.height - doc.state.height) / 2) })
}

const STEPS = [0.01, 0.02, 0.03, 0.05, 1 / 12, 0.125, 1 / 6, 0.25, 1 / 3, 0.5, 2 / 3, 1, 1.5, 2, 3, 4, 5, 6, 8, 12, 16, 24, 32, 48, 64].filter((step) => step >= MIN_ZOOM && step <= MAX_ZOOM)

/** The next zoom step in or out, around a screen point (the viewport's centre by default). */
export function zoomStep(doc: CanvasDocument, direction: 1 | -1, x = viewport.width / 2, y = viewport.height / 2): void {
  const view = viewOf(doc)
  const next = direction > 0 ? (STEPS.find((step) => step > view.zoom * 1.001) ?? MAX_ZOOM) : ([...STEPS].reverse().find((step) => step < view.zoom / 1.001) ?? MIN_ZOOM)
  setView(doc, zoomAt(view, next / view.zoom, x, y))
}

export const zoomLabel = (zoom: number): string => `${zoom >= 0.1 ? Math.round(zoom * 100) : (zoom * 100).toFixed(1)}%`
