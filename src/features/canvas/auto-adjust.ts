/*
 * Image > Auto Tone, Auto Contrast and Auto Color, for the menus and for Hermes: the picture under
 * where the new layer goes is read once (reduced to a few megapixels, plenty for a histogram), and
 * the fix lands as a Levels adjustment layer above the active layer, editable like any other.
 */

import type { LevelsSettings } from '../../../shared/canvas/comp-format.ts'
import { type AutoMode, AUTO_LABELS, autoLevels, DEFAULT_CLIP } from './engine/auto-levels.ts'
import { adjustmentLayer, type CanvasLayer, type DocState, insertLayer, type Placement, placementFor } from './engine/document.ts'
import type { Raster } from './engine/raster.ts'

/** The most pixels the histogram is read from. */
const HISTOGRAM_PIXELS = 4_000_000

export interface AutoOptions {
  place?: Placement
  /** The share of the darkest and lightest pixels ignored (0.001 is 0.1%). */
  clip?: number
  name?: string
  /** Draws the given layers at a scale (1 is full size), the way the person sees them. */
  render: (state: DocState, only: ReadonlySet<string>, scale: number) => Raster
}

/** The document with an automatic Levels layer added; null when the picture has nothing to stretch. */
export function autoAdjustState(state: DocState, mode: AutoMode, options: AutoOptions): { state: DocState; layer: CanvasLayer; levels: LevelsSettings } | null {
  const layer: CanvasLayer = { ...adjustmentLayer('Levels', state.width, state.height), name: options.name ?? AUTO_LABELS[mode] }
  const placed = insertLayer(state, layer, options.place ?? placementFor(state))
  const index = placed.layers.findIndex((entry) => entry.id === layer.id)
  // What is drawn before the new layer is what it adjusts.
  const below = new Set(placed.layers.slice(0, index).map((entry) => entry.id))

  if (!below.size) {
    throw new Error('There is nothing under the new layer to measure')
  }

  const scale = Math.min(1, Math.sqrt(HISTOGRAM_PIXELS / (state.width * state.height)))
  const levels = autoLevels(options.render(state, below, scale).data, mode, options.clip ?? DEFAULT_CLIP)

  if (!levels) {
    return null
  }

  const adjusted: CanvasLayer = { ...layer, adjustment: { ...layer.adjustment!, levels } }

  return { state: { ...placed, layers: placed.layers.map((entry) => (entry.id === layer.id ? adjusted : entry)) }, layer: adjusted, levels }
}
