/*
 * The document on screen: the part of it in view composited at the screen's resolution (never past
 * full size), drawn with the view's zoom and pan over the workspace, with a checkerboard under
 * transparency. Small documents, or ones zoomed out until they cost little more than the view,
 * are composited whole, so panning needs no new composite. A software renderer draws a draft at
 * half the resolution while something moves, and the full frame once things are still.
 */

import type { CanvasDocument, CanvasLayer } from '../document.ts'
import { type Mat, multiply, scale, toMat3, translate } from '../geometry.ts'
import { clipRect, type Raster, type Rect } from '../raster.ts'
import { filterReach, frameSize, TILE_ALIGN } from '../tiles.ts'
import { Compositor, type Rendered } from './compositor.ts'
import { Gpu, type Program } from './gl.ts'
import { DISPLAY_FRAGMENT, PLACE_VERTEX, WHOLE } from './shaders.ts'

/** Screen (CSS) pixels = document pixels × zoom + pan. */
export interface View {
  zoom: number
  panX: number
  panY: number
}

export interface Look {
  /** Around the page; null leaves it transparent so the window's glass shows. */
  workspace: [number, number, number] | null
  checkerLight: [number, number, number]
  checkerDark: [number, number, number]
}

export const MIN_ZOOM = 0.01
export const MAX_ZOOM = 64

/** Zoom to fit the document in a viewport, never past `maxZoom`. */
export function fitView(viewWidth: number, viewHeight: number, docWidth: number, docHeight: number, maxZoom = 1, margin = 32): View {
  const zoom = Math.max(MIN_ZOOM, Math.min(maxZoom, (viewWidth - margin * 2) / docWidth, (viewHeight - margin * 2) / docHeight))

  return { zoom, panX: (viewWidth - docWidth * zoom) / 2, panY: (viewHeight - docHeight * zoom) / 2 }
}

/** Zoom by a factor keeping the document point under (x, y) where it is. */
export function zoomAt(view: View, factor: number, x: number, y: number): View {
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.zoom * factor))
  const applied = zoom / view.zoom

  return { zoom, panX: x - (x - view.panX) * applied, panY: y - (y - view.panY) * applied }
}

/** Document pixels to screen pixels. */
export const docToScreen = (view: View): Mat => multiply(translate(view.panX, view.panY), scale(view.zoom))

/** A draft's resolution against the full frame's, along each side. */
export const DRAFT_SCALE = 0.5

/** How long after the last change a software renderer goes back to full quality, in milliseconds. */
export const SETTLE_MS = 160

/** The whole frame is composited when it costs at most this many times the part in view. */
const WHOLE_FRAME_COST = 1.6

export interface FramePlan {
  /** Frame pixels per document pixel. */
  scale: number
  /** What to composite, in frame pixels. */
  area: Rect
  /** The frame pixels the screen shows, which the composite must hold. */
  needed: Rect
}

/**
 * What to composite for a view: the frame scale (the screen's pixels, never past full size; half
 * that for a draft) and the area (the whole frame when it is cheap, else the part in view with a
 * margin for panning and a border for the blurs). Null when the document is out of view.
 */
export function planFrame(docWidth: number, docHeight: number, view: View, viewport: { width: number; height: number }, dpr: number, options: { draft?: boolean; maxTexture: number; reach?: (scale: number) => number }): FramePlan | null {
  const deviceScale = view.zoom * dpr
  const frameScale = Math.min(1, deviceScale * (options.draft ? DRAFT_SCALE : 1))
  const frame = frameSize(docWidth, docHeight, frameScale)
  const toFrame = frameScale / view.zoom
  const needed = clipRect({ x: -view.panX * toFrame, y: -view.panY * toFrame, width: viewport.width * toFrame, height: viewport.height * toFrame }, frame.width, frame.height)

  if (!needed) {
    return null
  }

  const limit = options.maxTexture

  if (frame.width <= limit && frame.height <= limit && frame.width * frame.height <= needed.width * needed.height * WHOLE_FRAME_COST) {
    return { scale: frameScale, area: { x: 0, y: 0, ...frame }, needed }
  }

  // A quarter of the view to spare on each side, so a small pan reuses the composite, plus the blurs' reach.
  const pad = (options.reach?.(frameScale) ?? 0) + Math.ceil(Math.max(needed.width, needed.height) / 4)
  const x0 = Math.max(0, Math.floor((needed.x - pad) / TILE_ALIGN) * TILE_ALIGN)
  const y0 = Math.max(0, Math.floor((needed.y - pad) / TILE_ALIGN) * TILE_ALIGN)
  const x1 = Math.min(frame.width, needed.x + needed.width + pad, x0 + limit)
  const y1 = Math.min(frame.height, needed.y + needed.height + pad, y0 + limit)

  return { scale: frameScale, area: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, needed }
}

/** Does a composite of `area` hold `needed`, with `reach` to spare wherever it stops short of the frame's edge? */
export function covers(area: Rect, needed: Rect, reach: number, frame: { width: number; height: number }): boolean {
  const left = area.x === 0 ? 0 : reach
  const top = area.y === 0 ? 0 : reach
  const right = area.x + area.width >= frame.width ? 0 : reach
  const bottom = area.y + area.height >= frame.height ? 0 : reach

  return needed.x >= area.x + left && needed.y >= area.y + top && needed.x + needed.width <= area.x + area.width - right && needed.y + needed.height <= area.y + area.height - bottom
}

export interface DrawOptions {
  /** Changes to layers for this frame only (the text being typed is hidden). */
  overrides?: ReadonlyMap<string, Partial<CanvasLayer>>
}

export class ScreenRenderer {
  readonly gpu: Gpu
  readonly compositor: Compositor
  private readonly display: Program
  private rendered: Rendered | null = null
  private drawn = { key: '', revision: -1, overrides: undefined as ReadonlyMap<string, Partial<CanvasLayer>> | undefined, draft: false }
  private lastView = ''
  private lastRevision = ''
  private changedAt = 0
  /** The frame showed a composite made at another scale, stretched: a full one is owed once things are still. */
  private stretched = false

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: true, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' })

    if (!gl) {
      throw new Error('Veritas Canvas needs WebGL2, which this system does not provide')
    }

    this.gpu = new Gpu(gl)
    this.compositor = new Compositor(this.gpu)
    this.display = this.gpu.program(PLACE_VERTEX, DISPLAY_FRAGMENT)
  }

  /** Composite again on the next draw even when the document says nothing changed. */
  invalidate(): void {
    this.drawn.revision = -1
  }

  /** The overrides the screen last drew a document with (for reading what the person sees). */
  overridesFor(doc: CanvasDocument): ReadonlyMap<string, Partial<CanvasLayer>> | undefined {
    return this.drawn.key === doc.key ? this.drawn.overrides : undefined
  }

  /**
   * Draw a frame. Answers whether it was a draft, which wants a full frame once things are still
   * (a software renderer drafts while the document or the view keeps changing).
   */
  draw(doc: CanvasDocument | null, view: View, look: Look, dpr: number, options: DrawOptions = {}): boolean {
    const { gl } = this.gpu
    const { width, height } = this.canvas

    if (gl.isContextLost()) {
      return false
    }

    this.gpu.bindTarget(null, width, height, false)

    if (look.workspace) {
      gl.clearColor(look.workspace[0], look.workspace[1], look.workspace[2], 1)
    } else {
      gl.clearColor(0, 0, 0, 0)
    }

    gl.clear(gl.COLOR_BUFFER_BIT)

    if (!doc) {
      return false
    }

    const now = performance.now()
    const viewKey = `${view.zoom}:${view.panX}:${view.panY}:${width}:${height}`
    const revisionKey = `${doc.key}:${doc.revision}`

    if (viewKey !== this.lastView || revisionKey !== this.lastRevision) {
      this.lastView = viewKey
      this.lastRevision = revisionKey
      this.changedAt = now
    }

    const draft = this.gpu.software && (doc.interacting || now - this.changedAt < SETTLE_MS)
    const viewport = { width: width / dpr, height: height / dpr }
    const reach = (frameScale: number) => filterReach(doc.state, frameScale)
    const plan = planFrame(doc.state.width, doc.state.height, view, viewport, dpr, { draft, maxTexture: this.gpu.maxTextureSize, reach })

    if (!plan) {
      return false
    }

    const rendered = this.current(doc, plan, draft, options.overrides)
    // Device pixels per composited pixel decides the filtering: crisp pixels when they map one to one or are blown up.
    const density = (view.zoom * dpr) / rendered.scale
    const sampling = density >= 2 || Math.abs(density - 1) < 0.01 ? 'nearest' : 'linear'
    this.gpu.setSampling(rendered.target.texture, sampling)
    this.gpu.bindTarget(null, width, height, false)
    this.gpu.blendOver(false)

    // Unit square → the composited area in the document → screen (CSS) → device pixels, y flipped for the default framebuffer.
    const { area } = rendered
    const flip: Mat = { a: 1, b: 0, c: 0, d: -1, e: 0, f: height }
    const areaToDocument = multiply(translate(area.x / rendered.scale, area.y / rendered.scale), scale(area.width / rendered.scale, area.height / rendered.scale))
    const place = multiply(flip, multiply(scale(dpr), multiply(docToScreen(view), areaToDocument)))
    this.display
      .use()
      .mat3('u_place', toMat3(place))
      .vec2('u_size', width, height)
      .vec4('u_unitRect', ...WHOLE)
      .texture('u_image', 0, rendered.target.texture)
      .float('u_checker', 8 * dpr)
      .vec3('u_light', ...look.checkerLight)
      .vec3('u_dark', ...look.checkerDark)
    this.gpu.drawQuad()

    return this.drawn.draft || this.stretched
  }

  /**
   * The composite a plan asks for: the last one while it still holds what is in view, else a new
   * one. While the view moves on a software renderer, the last one is also shown stretched when it
   * is of the same document at a nearby scale and holds what is in view (`stretched` says so).
   */
  private current(doc: CanvasDocument, plan: FramePlan, draft: boolean, overrides?: ReadonlyMap<string, Partial<CanvasLayer>>): Rendered {
    const last = this.rendered
    const drawn = this.drawn
    const frame = frameSize(doc.state.width, doc.state.height, plan.scale)
    const same = last && drawn.key === doc.key && drawn.revision === doc.revision && drawn.overrides === overrides
    this.stretched = false

    if (same && drawn.draft === draft && last.scale === plan.scale && covers(last.area, plan.needed, filterReach(doc.state, plan.scale), frame)) {
      return last
    }

    if (same && draft && this.gpu.software && last.scale !== plan.scale) {
      const ratio = plan.scale / last.scale
      const held = { x: last.area.x / last.scale, y: last.area.y / last.scale, width: last.area.width / last.scale, height: last.area.height / last.scale }
      const shown = { x: plan.needed.x / plan.scale, y: plan.needed.y / plan.scale, width: plan.needed.width / plan.scale, height: plan.needed.height / plan.scale }
      const inside = shown.x >= held.x && shown.y >= held.y && shown.x + shown.width <= held.x + held.width && shown.y + shown.height <= held.y + held.height

      if (ratio >= 0.5 && ratio <= 2 && inside) {
        this.stretched = true

        return last
      }
    }

    this.rendered = this.compositor.render(doc.state, { scale: plan.scale, area: plan.area, overrides, draft })
    this.drawn = { key: doc.key, revision: doc.revision, overrides, draft }

    return this.rendered
  }

  /** Free the GPU memory; the context itself goes with its canvas (a remount may reuse it). */
  dispose(): void {
    this.compositor.dispose()
  }

  /** Anything rendered with this compositor's targets for another purpose leaves the screen's composite stale. */
  borrowed(): void {
    this.rendered = null
    this.invalidate()
  }

  /** Pixels the screen has, for reading back a small area quickly without a new composite (null when it lacks them). */
  readCached(doc: CanvasDocument, area: Rect): Raster | null {
    const rendered = this.rendered

    if (!rendered || this.drawn.key !== doc.key || this.drawn.revision !== doc.revision || this.drawn.draft || rendered.scale !== 1) {
      return null
    }

    const box = { x: area.x - rendered.area.x, y: area.y - rendered.area.y, width: area.width, height: area.height }

    if (box.x < 0 || box.y < 0 || box.x + box.width > rendered.width || box.y + box.height > rendered.height) {
      return null
    }

    return this.compositor.read(rendered, null, box)
  }
}
