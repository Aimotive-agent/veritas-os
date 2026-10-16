/*
 * The Clone Stamp and the Healing Brush. Alt-click (Option-click) picks where to copy from; a
 * stroke then lays down what is there, the source following the pointer at the same distance.
 * Aligned, that distance holds from one stroke to the next; otherwise each stroke copies from the
 * source point again. The Healing Brush keeps the copy's texture but takes its colour and tone from
 * around the stroke when the pointer lifts. Strokes go through the selection, one undo step each.
 */

import type { Vec2 } from '../../../../shared/canvas/comp-format.ts'
import { copier, healStroke, type PixelReader } from '../engine/clone.ts'
import type { CanvasDocument } from '../engine/document.ts'
import { pixelToDocument } from '../engine/geometry.ts'
import { maskPlacement } from '../engine/masks.ts'
import { Stroke } from '../engine/paint.ts'
import { clipRect, type Raster } from '../engine/raster.ts'
import { toDocumentPixels } from '../engine/sampling.ts'
import { notify } from '../store.ts'
import { compositeArea, compositeOf } from './screen.ts'
import { $clone, $healing } from './state.ts'
import { commitPixels, paintTarget } from './target.ts'
import { type PointerInfo, redraw, type ToolHandler } from './types.ts'

/** Where to copy from, shared by both tools; once an aligned stroke has started, its distance from the pointer too. */
let source: { docKey: string; point: Vec2; offset: Vec2 | null } | null = null
let hovering: { docKey: string; at: PointerInfo } | null = null
/** The distance the stroke under way copies from, for the source's crosshair. */
let painting: { docKey: string; offset: Vec2 } | null = null
/** The source under the brush, drawn over it while hovering. */
let patch: { key: string; canvas: HTMLCanvasElement; x: number; y: number } | null = null

/** The overlay leaves out sources bigger than this (document pixels a side). */
const PATCH_LIMIT = 640

/** The source as the overlay shows it: the document area around `centre`, from the layer painted on or from every layer. */
function sourcePatch(doc: CanvasDocument, centre: Vec2, size: number, allLayers: boolean): typeof patch {
  const side = Math.ceil(size)
  const x = Math.floor(centre[0] - side / 2)
  const y = Math.floor(centre[1] - side / 2)
  const layer = doc.active
  const key = `${doc.key}:${doc.revision}:${layer?.id}:${doc.editingMask}:${allLayers}:${x}:${y}:${side}`

  if (patch?.key === key) {
    return patch
  }

  let raster: Raster | null = null
  let at: Vec2 = [x, y]

  if (allLayers && !doc.editingMask) {
    const box = clipRect({ x, y, width: side, height: side }, doc.state.width, doc.state.height)

    if (box) {
      raster = compositeArea(doc, box)
      at = [box.x, box.y]
    }
  } else if (doc.editingMask && layer?.mask) {
    raster = toDocumentPixels(layer.mask, pixelToDocument(maskPlacement(layer), layer.mask.width, layer.mask.height), { x, y, width: side, height: side })
  } else if (layer?.pixels) {
    raster = toDocumentPixels(layer.pixels, pixelToDocument(layer.transform, layer.pixels.width, layer.pixels.height), { x, y, width: side, height: side })
  }

  if (!raster) {
    return null
  }

  const canvas = document.createElement('canvas')
  canvas.width = raster.width
  canvas.height = raster.height
  const rgba = raster.channels === 4 ? raster.data : Uint8ClampedArray.from({ length: raster.width * raster.height * 4 }, (_, i) => ((i & 3) === 3 ? 255 : raster.data[i >> 2]))
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), raster.width, raster.height), 0, 0)

  return { key, canvas, x: at[0], y: at[1] }
}

function cloneTool(kind: 'clone' | 'healing'): ToolHandler {
  const options = kind === 'clone' ? $clone : $healing
  const label = kind === 'clone' ? 'Clone Stamp' : 'Healing Brush'

  return {
    cursor: (_doc, at) => (at?.alt ? 'crosshair' : at && options.get().size * at.view.zoom >= 6 ? 'none' : 'crosshair'),

    hover(doc, at) {
      hovering = at ? { docKey: doc.key, at } : null
      redraw()
    },

    down(doc, at) {
      if (at.alt) {
        source = { docKey: doc.key, point: [at.x, at.y], offset: null }
        redraw()

        return null
      }

      if (source?.docKey !== doc.key) {
        notify(`${label}: Alt-click (Option-click on a Mac) where to copy from first`)

        return null
      }

      if (kind === 'healing' && doc.editingMask) {
        notify('The Healing Brush works on pixels: pick the layer, not its mask', 'error')

        return null
      }

      const target = paintTarget(doc)

      if (!target) {
        return null
      }

      const settings = options.get()
      const before = doc.state
      const offset: Vec2 = settings.aligned && source.offset ? source.offset : [Math.round(source.point[0] - at.x), Math.round(source.point[1] - at.y)]

      if (settings.aligned) {
        source.offset = offset
      }

      // Every layer is pictured once, before the stroke changes any of them.
      const picture = settings.allLayers && !target.mask ? compositeOf(doc) : null
      let copy: PixelReader = (_x, _y, out) => out.fill(0)
      const stroke = new Stroke(target.raster, target.toDocument, settings, { colour: [0, 0, 0], erase: false, sample: (x, y, out) => copy(x, y, out) }, doc.state.selection)
      copy = copier(target.raster, target.toDocument, offset, picture, stroke.edit)
      painting = { docKey: doc.key, offset }
      doc.interacting = true

      if (target.state !== before) {
        doc.preview(target.state)
      }

      stroke.to(at.x, at.y, at.pressure)
      doc.changed()

      const done = (): void => {
        painting = null
        doc.interacting = false
      }

      return {
        move: (now, trail) => {
          for (const point of trail) {
            stroke.to(point.x, point.y, point.pressure)
          }

          hovering = { docKey: doc.key, at: now }
          doc.changed()
        },
        up: () => {
          stroke.end()

          if (kind === 'healing') {
            healStroke(stroke, copy)
          }

          done()
          commitPixels(doc, before, target, stroke.edit, label)
        },
        cancel: () => {
          stroke.end()
          done()
          stroke.finish(label)?.undo()
          doc.preview(before)
        }
      }
    },

    overlay(context, doc, view) {
      const at = hovering?.docKey === doc.key ? hovering.at : null
      const settings = options.get()
      const radius = (settings.size * view.zoom) / 2
      const offset = painting?.docKey === doc.key ? painting.offset : source?.docKey === doc.key && settings.aligned ? source.offset : null
      // Where the brush copies from now: the pointer moved by the distance, or before a stroke sets one, the source point itself.
      const from: Vec2 | null = source?.docKey !== doc.key ? null : at && offset ? [at.x + offset[0], at.y + offset[1]] : source.point

      if (at && from && !painting && !at.alt && radius >= 3 && settings.size <= PATCH_LIMIT) {
        patch = sourcePatch(doc, from, settings.size, settings.allLayers)

        if (patch) {
          context.save()
          context.beginPath()
          context.arc(at.sx, at.sy, radius, 0, Math.PI * 2)
          context.clip()
          context.globalAlpha = 0.6
          context.imageSmoothingEnabled = view.zoom < 1
          context.drawImage(patch.canvas, at.sx + (patch.x - from[0]) * view.zoom, at.sy + (patch.y - from[1]) * view.zoom, patch.canvas.width * view.zoom, patch.canvas.height * view.zoom)
          context.restore()
        }
      }

      context.save()

      if (from) {
        const sx = view.panX + from[0] * view.zoom
        const sy = view.panY + from[1] * view.zoom
        context.beginPath()
        context.moveTo(sx - 7, sy)
        context.lineTo(sx + 7, sy)
        context.moveTo(sx, sy - 7)
        context.lineTo(sx, sy + 7)
        context.lineWidth = 3
        context.strokeStyle = 'rgba(0, 0, 0, 0.55)'
        context.stroke()
        context.lineWidth = 1
        context.strokeStyle = 'rgba(255, 255, 255, 0.95)'
        context.stroke()
      }

      if (at && radius >= 3) {
        context.beginPath()
        context.arc(at.sx, at.sy, radius, 0, Math.PI * 2)
        context.lineWidth = 2.5
        context.strokeStyle = 'rgba(0, 0, 0, 0.55)'
        context.stroke()
        context.lineWidth = 1
        context.strokeStyle = 'rgba(255, 255, 255, 0.95)'
        context.stroke()
      }

      context.restore()
    },

    release() {
      hovering = null
      patch = null
    }
  }
}

export const cloneStampTool = cloneTool('clone')
export const healingBrushTool = cloneTool('healing')
