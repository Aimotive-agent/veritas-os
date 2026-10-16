/*
 * The tool in hand and every tool's options, shared by the tool palette, the options bar, the
 * viewport and the shortcuts. Tools that share a key (the marquees, the lassos, the healing brushes,
 * the bucket and the gradient) form a group: the palette shows the one used last, and the key again
 * moves to the next.
 */

import { atom, type WritableAtom } from 'nanostores'
import type { TextAlignment } from '../../../../shared/canvas/comp-format.ts'
import type { AlignTo } from '../engine/align.ts'
import { type Gradient, GRADIENT_PRESETS, type GradientStyle } from '../engine/gradient.ts'
import type { SelectionMode } from '../engine/selection.ts'

export type ToolId =
  | 'move'
  | 'marquee'
  | 'ellipse-marquee'
  | 'lasso'
  | 'polygon-lasso'
  | 'wand'
  | 'object-select'
  | 'crop'
  | 'eyedropper'
  | 'brush'
  | 'heal'
  | 'healing'
  | 'clone'
  | 'eraser'
  | 'bucket'
  | 'gradient'
  | 'type'
  | 'shape'
  | 'hand'
  | 'zoom'
  | 'refine'

export interface ToolDef {
  id: ToolId
  label: string
  /** The key that picks it. */
  key: string
  /** Tools sharing a palette button. */
  group: string
}

export const TOOLS: readonly ToolDef[] = [
  { id: 'move', label: 'Move', key: 'v', group: 'move' },
  { id: 'marquee', label: 'Rectangular Marquee', key: 'm', group: 'marquee' },
  { id: 'ellipse-marquee', label: 'Elliptical Marquee', key: 'm', group: 'marquee' },
  { id: 'lasso', label: 'Lasso', key: 'l', group: 'lasso' },
  { id: 'polygon-lasso', label: 'Polygonal Lasso', key: 'l', group: 'lasso' },
  { id: 'wand', label: 'Magic Wand', key: 'w', group: 'wand' },
  { id: 'object-select', label: 'Object Select', key: 'w', group: 'wand' },
  { id: 'crop', label: 'Crop', key: 'c', group: 'crop' },
  { id: 'eyedropper', label: 'Eyedropper', key: 'i', group: 'eyedropper' },
  { id: 'heal', label: 'Spot Healing Brush', key: 'j', group: 'heal' },
  { id: 'healing', label: 'Healing Brush', key: 'j', group: 'heal' },
  { id: 'brush', label: 'Brush', key: 'b', group: 'brush' },
  { id: 'clone', label: 'Clone Stamp', key: 's', group: 'clone' },
  { id: 'eraser', label: 'Eraser', key: 'e', group: 'eraser' },
  { id: 'bucket', label: 'Paint Bucket', key: 'g', group: 'fill' },
  { id: 'gradient', label: 'Gradient', key: 'g', group: 'fill' },
  { id: 'type', label: 'Type', key: 't', group: 'type' },
  { id: 'shape', label: 'Shape', key: 'u', group: 'shape' },
  { id: 'hand', label: 'Hand', key: 'h', group: 'hand' },
  { id: 'zoom', label: 'Zoom', key: 'z', group: 'zoom' }
]

/** Tools a workspace puts in hand for itself (Select and Mask's Refine Edge brush), not on the palette. */
const WORKSPACE_TOOLS: readonly ToolDef[] = [{ id: 'refine', label: 'Refine Edge Brush', key: '', group: 'refine' }]

export const toolDef = (id: ToolId): ToolDef => TOOLS.find((def) => def.id === id) ?? WORKSPACE_TOOLS.find((def) => def.id === id)!

/** The palette's buttons in order, each a group. */
export const GROUPS: readonly string[] = [...new Set(TOOLS.map((def) => def.group))]

export const $tool = atom<ToolId>('move')

/** The tool each group shows: the one used last. */
export const $groupTools = atom<Record<string, ToolId>>(Object.fromEntries(GROUPS.map((group) => [group, TOOLS.find((def) => def.group === group)!.id])))

export function setTool(id: ToolId): void {
  $groupTools.set({ ...$groupTools.get(), [toolDef(id).group]: id })
  $tool.set(id)
}

/** A tool's key: its group's tool, or with the group already in hand (or Shift held), the next one in the group. */
export function toolForKey(key: string, cycle: boolean): ToolId | null {
  const inGroup = key ? TOOLS.filter((def) => def.key === key) : []

  if (!inGroup.length) {
    return null
  }

  const current = $tool.get()
  const index = inGroup.findIndex((def) => def.id === current)

  if (index >= 0 && (cycle || inGroup.length > 1)) {
    return inGroup[(index + 1) % inGroup.length].id
  }

  return $groupTools.get()[inGroup[0].group] ?? inGroup[0].id
}

/** Move tool: pick the layer under the pointer instead of moving the active one. */
export const $autoSelect = atom(false)

/** Move tool: show the transform frame around the picked layers. */
export const $showTransform = atom(false)

/** Move tool and Layer > Align: what layers line up with; automatic picks the selection, then each other, then the canvas. */
export const $alignTo = atom<AlignTo | 'auto'>('auto')

/** Space held: the Hand tool for as long as it is down. */
export const $spaceHeld = atom(false)

export type RGB = [number, number, number]

export const $foreground = atom<RGB>([0, 0, 0])
export const $background = atom<RGB>([255, 255, 255])

export const swapColours = (): void => {
  const foreground = $foreground.get()
  $foreground.set($background.get())
  $background.set(foreground)
}

export const resetColours = (): void => {
  $foreground.set([0, 0, 0])
  $background.set([255, 255, 255])
}

export interface BrushOptions {
  /** Diameter in document pixels. */
  size: number
  hardness: number
  opacity: number
  flow: number
  spacing: number
}

export const $brush = atom<BrushOptions>({ size: 30, hardness: 0.8, opacity: 1, flow: 1, spacing: 0.12 })
export const $eraser = atom<BrushOptions>({ size: 50, hardness: 0.8, opacity: 1, flow: 1, spacing: 0.12 })

export interface CloneOptions extends BrushOptions {
  /** Keep the distance to the source from one stroke to the next, rather than copying from the source point again. */
  aligned: boolean
  /** Copy what every layer shows together, rather than the layer painted on. */
  allLayers: boolean
}

export const $clone = atom<CloneOptions>({ size: 60, hardness: 0.7, opacity: 1, flow: 1, spacing: 0.1, aligned: true, allLayers: false })
export const $healing = atom<CloneOptions>({ size: 60, hardness: 0.7, opacity: 1, flow: 1, spacing: 0.1, aligned: true, allLayers: false })

/** How a new selection goes with the one there is (Shift adds, Alt takes away, both intersect). */
export const $selectionMode = atom<SelectionMode>('new')
export const $marquee = atom({ feather: 0 })
export const $wand = atom({ tolerance: 32, contiguous: true, allLayers: false })
export const $objectSelect = atom({ allLayers: false })
/** Spot Healing Brush: the brush's diameter in document pixels. */
export const $heal = atom({ size: 40 })
export const $bucket = atom({ tolerance: 32, contiguous: true, allLayers: false, opacity: 1 })
export interface GradientOptions {
  style: GradientStyle
  gradient: Gradient
  reverse: boolean
  opacity: number
}

export const $gradient = atom<GradientOptions>({ style: 'linear', gradient: GRADIENT_PRESETS[0], reverse: false, opacity: 1 })
export const $eyedropper = atom({ allLayers: true })

export type ShapeTool = 'rectangle' | 'rounded' | 'ellipse' | 'line'
export const $shape = atom({ kind: 'rectangle' as ShapeTool, radius: 24, lineWidth: 6 })

export interface TypeOptions {
  family: string
  weight: number
  italic: boolean
  size: number
  alignment: TextAlignment
  tracking: number
  leading: number
}

export const $type = atom<TypeOptions>({ family: 'Helvetica', weight: 400, italic: false, size: 72, alignment: 'Left', tracking: 0, leading: 0 })

/** Select and Mask's Refine Edge brush: its diameter in document pixels. */
export const $refineBrush = atom({ size: 40 })

/** The painting tool's options atom, for the keys that change size and opacity. */
export function paintOptionsFor(tool: ToolId): WritableAtom<BrushOptions> | null {
  return tool === 'brush' ? $brush : tool === 'eraser' ? $eraser : tool === 'clone' ? $clone : tool === 'healing' ? $healing : null
}
/** The next brush size for `[` and `]`, in steps that grow with the size. */
export function stepSize(size: number, direction: 1 | -1): number {
  const step = size < 10 ? 1 : size < 50 ? 5 : size < 100 ? 10 : size < 300 ? 25 : 50
  const next = direction > 0 ? Math.floor(size / step) * step + step : Math.ceil(size / step) * step - step

  return Math.max(1, Math.min(5000, next))
}
