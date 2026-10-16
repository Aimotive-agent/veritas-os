/*
 * Rendering in tiles. A document too large for one GPU texture, or not worth holding whole, is
 * drawn a tile at a time: each tile with a border as wide as the blurs above it reach, so they see
 * what they would see in one piece, and the border cut away. Rendered areas start on a grid, so a
 * blur halves the same pixels whichever tile it runs in.
 */

import { blurPlan } from './adjust-math.ts'
import { type DocState, isShown } from './document.ts'
import type { Rect } from './raster.ts'

/** Rendered areas start on multiples of this (frame pixels): a power of two at least as large as any blur's halving. */
export const TILE_ALIGN = 256

/** The side of the tiles exports and flattening are drawn in. */
export const TILE_SIZE = 2048

/** The frame a document draws into at a scale: its size in target pixels. */
export const frameSize = (width: number, height: number, scale: number): { width: number; height: number } => ({
  width: Math.max(1, Math.round(width * scale)),
  height: Math.max(1, Math.round(height * scale))
})

/** How far (frame pixels) the blur adjustments shown in a document carry a pixel's colour: what a tile's border must cover. */
export function filterReach(state: DocState, scale: number): number {
  let reach = 0

  for (const layer of state.layers) {
    const adjustment = layer.adjustment

    if (!adjustment || !isShown(state, layer) || (layer.opacity ?? 1) <= 0) {
      continue
    }

    if (adjustment.kind === 'Gaussian Blur') {
      const sigma = (adjustment.blurRadius ?? 8) * scale
      // Three sigmas, plus the halving's box and the stretch back's tent.
      reach += Math.ceil(sigma * 3) + blurPlan(sigma).factor * 3 + 2
    } else if (adjustment.kind === 'Motion Blur') {
      reach += Math.ceil(((adjustment.motionDistance ?? 20) * scale) / 2) + 4
    }
  }

  return reach
}

export interface Tile {
  /** The part of the area this tile delivers, in frame pixels; inner parts cover the area once. */
  inner: Rect
  /** What is rendered for it: the inner part and its border, inside the frame, starting on the grid. */
  padded: Rect
}

/** The largest tile side that still fits the GPU with its border on both sides. */
export function tileSide(maxTexture: number, pad: number, wanted = TILE_SIZE): number {
  const border = Math.ceil(pad / TILE_ALIGN) * TILE_ALIGN + TILE_ALIGN
  const room = Math.floor((maxTexture - border * 2) / TILE_ALIGN) * TILE_ALIGN

  return Math.max(TILE_ALIGN, Math.min(wanted, room))
}

/** Tiles over an area of a frame (frame pixels), `size` a side, each padded by `pad` within the frame. */
export function planTiles(frame: { width: number; height: number }, area: Rect, size: number, pad: number): Tile[] {
  const tiles: Tile[] = []
  const x0 = Math.max(0, area.x)
  const y0 = Math.max(0, area.y)
  const x1 = Math.min(frame.width, area.x + area.width)
  const y1 = Math.min(frame.height, area.y + area.height)
  const down = (value: number) => Math.max(0, Math.floor(value / TILE_ALIGN) * TILE_ALIGN)

  for (let y = Math.floor(y0 / size) * size; y < y1; y += size) {
    for (let x = Math.floor(x0 / size) * size; x < x1; x += size) {
      const inner = { x: Math.max(x, x0), y: Math.max(y, y0), width: 0, height: 0 }
      inner.width = Math.min(x + size, x1) - inner.x
      inner.height = Math.min(y + size, y1) - inner.y
      const px = down(inner.x - pad)
      const py = down(inner.y - pad)
      const padded = { x: px, y: py, width: Math.min(frame.width, inner.x + inner.width + pad) - px, height: Math.min(frame.height, inner.y + inner.height + pad) - py }
      tiles.push({ inner, padded })
    }
  }

  return tiles
}

/** Rows of an area in strips of at most `rows`, top to bottom (for writing a file a strip at a time). */
export function strips(height: number, rows: number): { y: number; height: number }[] {
  const out: { y: number; height: number }[] = []

  for (let y = 0; y < height; y += rows) {
    out.push({ y, height: Math.min(rows, height - y) })
  }

  return out
}
