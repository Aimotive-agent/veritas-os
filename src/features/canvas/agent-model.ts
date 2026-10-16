/*
 * The pure half of Veritas Canvas's commands: reading paths, finding layers, describing them for
 * Hermes and placing pictures. No window, no I/O, so it is tested directly.
 */

import {
  type Adjustment,
  BLEND_MODES,
  type BlendMode,
  checkAdjustment,
  checkEffects,
  checkHeraldAdjustment,
  defaultEffect,
  EFFECT_KINDS,
  type EffectKind,
  type HeraldAdjustment,
  type LayerEffects,
  RANGES,
  type RangeName,
  type RGB,
  type ShapeKind,
  type ShapeStyle,
  type TextAlignment,
  type Vec2
} from '../../../shared/canvas/comp-format.ts'
import type { AlignEdge, AlignTo, DistributeMode } from './engine/align.ts'
import type { AutoMode } from './engine/auto-levels.ts'
import { type Anchor, ANCHORS } from './engine/canvas-size.ts'
import { fitRatio, largestTurnedBox, ratioFrom } from './engine/crop.ts'
import type { FilterKind } from './engine/filters.ts'
import { type CanvasLayer, childrenOf, type DocState, findLayer } from './engine/document.ts'
import { boundsOf } from './engine/geometry.ts'
import { GRADIENT_STYLES, type GradientStyle } from './engine/gradient.ts'
import { heraldOf } from './engine/herald-adjust.ts'
import type { HistoryStep } from './engine/history.ts'
import { MASK_ACTIONS, type MaskAction } from './engine/masks.ts'
import type { Rect } from './engine/raster.ts'
import { postScriptName } from './engine/text.ts'

/** A full path from what Hermes or the person typed (`~/…` works); trailing slashes go. */
export function resolvePath(input: string, home: string): string {
  let value = input.trim()

  if (value === '~' || value.startsWith('~/')) {
    if (!home) {
      throw new Error('The home folder is not known yet; give the full path')
    }

    value = `${home}${value.slice(1)}`
  }

  if (!value.startsWith('/')) {
    throw new Error(`Give the full path (starting with / or ~/): ${input}`)
  }

  return value.replace(/\/+/g, '/').replace(/\/\.(?=\/|$)/g, '').replace(/(.)\/$/, '$1')
}

/** A layer by id, or by name (the topmost of that name; a unique part of a name also works). */
export function findByRef(state: DocState, ref: unknown): CanvasLayer {
  const text = String(ref ?? '').trim()

  if (!text) {
    throw new Error('Say which layer: its id or its name')
  }

  const lower = text.toLowerCase()
  const byId = state.layers.find((layer) => layer.id.toLowerCase() === lower)

  if (byId) {
    return byId
  }

  const named = state.layers.filter((layer) => layer.name.toLowerCase() === lower)

  if (named.length) {
    return named[named.length - 1]
  }

  const partial = state.layers.filter((layer) => layer.name.toLowerCase().includes(lower))

  if (partial.length === 1) {
    return partial[0]
  }

  throw new Error(`${partial.length ? 'Several layers match' : 'No layer is called'} “${text}”. The layers: ${state.layers.map((layer) => layer.name).join(', ') || 'none'}`)
}

export type LayerKind = 'pixels' | 'folder' | 'adjustment' | 'text' | 'shape' | 'blank'

export const kindOf = (layer: CanvasLayer): LayerKind => (layer.isGroup ? 'folder' : layer.adjustment ? 'adjustment' : layer.text ? 'text' : layer.shape ? 'shape' : layer.pixels ? 'pixels' : 'blank')

const round = (value: number, places = 2): number => Math.round(value * 10 ** places) / 10 ** places

/** One layer the way Hermes reads it. */
export function describeLayer(state: DocState, layer: CanvasLayer): Record<string, unknown> {
  const { transform } = layer
  const box = boundsOf(transform)

  return {
    id: layer.id,
    name: layer.name,
    kind: kindOf(layer),
    ...(layer.parentID ? { folder: findLayer(state, layer.parentID)?.name ?? layer.parentID } : {}),
    visible: layer.isVisible,
    opacity: round(layer.opacity ?? 1),
    blend: layer.isGroup ? 'Pass Through' : (layer.blendMode ?? 'Normal'),
    x: round(transform.origin[0], 1),
    y: round(transform.origin[1], 1),
    width: round(transform.size[0], 1),
    height: round(transform.size[1], 1),
    ...(transform.rotation ? { rotation: transform.rotation, bounds: { x: round(box.x, 1), y: round(box.y, 1), width: round(box.width, 1), height: round(box.height, 1) } } : {}),
    ...(transform.flipX ? { flipX: true } : {}),
    ...(transform.flipY ? { flipY: true } : {}),
    ...(layer.pixels ? { pixels: `${layer.pixels.width}×${layer.pixels.height}` } : {}),
    ...(layer.maskSourceID ? { clippedTo: findLayer(state, layer.maskSourceID)?.name ?? layer.maskSourceID } : {}),
    ...(layer.mask ? { mask: layer.maskEnabled === false ? 'off' : 'on', ...(layer.maskLinked === false ? { maskLinked: false } : {}) } : {}),
    ...(layer.adjustment ? (heraldOf(layer) ? { adjustment: heraldOf(layer)!.kind, settings: heraldSettings(heraldOf(layer)!) } : { adjustment: layer.adjustment.kind, settings: adjustmentSettings(layer.adjustment) }) : {}),
    ...(layer.effects && EFFECT_KINDS.some((kind) => layer.effects?.[kind]) ? { effects: Object.fromEntries(EFFECT_KINDS.filter((kind) => layer.effects?.[kind]).map((kind) => [kind, layer.effects![kind]])) } : {}),
    ...(layer.text ? { text: layer.text.content, font: layer.text.fontName, size: layer.text.fontSize, align: layer.text.alignment.toLowerCase() } : {}),
    ...(layer.shape
      ? {
          shape: layer.shape.kind === 'Rectangle' && layer.shape.cornerRadius > 0 ? 'rounded rectangle' : layer.shape.kind.toLowerCase(),
          color: hexOf(layer.shape),
          ...(layer.shape.kind === 'Rectangle' && layer.shape.cornerRadius > 0 ? { radius: round(layer.shape.cornerRadius, 1) } : {}),
          ...(layer.shape.kind === 'Line' ? { lineWidth: round(layer.shape.lineWidth ?? 1, 1) } : {})
        }
      : {})
  }
}

/** A colour as #rrggbb. */
const hexOf = ({ red, green, blue }: RGB): string => `#${[red, green, blue].map((value) => Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, '0')).join('')}`

/** The layers top to bottom, as the Layers panel lists them, with folders' contents after each folder. */
export function describeLayers(state: DocState): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const visit = (parentID: string | undefined) => {
    const children = childrenOf(state, parentID)

    for (let i = children.length - 1; i >= 0; i--) {
      out.push(describeLayer(state, children[i]))

      if (children[i].isGroup) {
        visit(children[i].id)
      }
    }
  }
  visit(undefined)

  return out
}

export type Fit = 'contain' | 'cover' | 'none' | 'stretch'

export const finite = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/** A number argument held to one of Compositor's ranges: undefined when not given, an error naming the argument and the range when outside it. */
export function rangedArg(value: unknown, name: string, range: RangeName, unit = ''): number | undefined {
  const number = finite(value)

  if (number === undefined) {
    return undefined
  }

  const [min, max] = RANGES[range]

  if (number < min || number > max) {
    throw new Error(`${name} must be from ${min} to ${max}${unit} (it was ${number})`)
  }

  return number
}

/**
 * Where a picture of `width`×`height` goes on the canvas: an explicit box (a missing side keeps the
 * proportions), or fitted inside it (`contain`, the default, never enlarging), covering it, at its
 * own size, or stretched over it.
 */
export function placementOf(width: number, height: number, canvas: { width: number; height: number }, args: Record<string, unknown>): { x: number; y: number; width: number; height: number } {
  const x = finite(args.x)
  const y = finite(args.y)
  let w = finite(args.width)
  let h = finite(args.height)
  const fit = (typeof args.fit === 'string' ? args.fit : 'contain') as Fit

  if (w !== undefined || h !== undefined) {
    w ??= (h! * width) / height
    h ??= (w * height) / width
  } else if (fit === 'stretch') {
    w = canvas.width
    h = canvas.height
  } else if (fit === 'none') {
    w = width
    h = height
  } else {
    const scale = fit === 'cover' ? Math.max(canvas.width / width, canvas.height / height) : Math.min(1, canvas.width / width, canvas.height / height)
    w = width * scale
    h = height * scale
  }

  return { x: x ?? (canvas.width - w) / 2, y: y ?? (canvas.height - h) / 2, width: w, height: h }
}

export type PictureFit = 'cover' | 'contain' | 'stretch'

/** How a placed picture fills its box, however it was written; cover when not given. */
export function pictureFitFrom(value: unknown): PictureFit {
  const text = String(value ?? '').trim().toLowerCase()

  if (!text || text === 'cover' || text === 'fill') {
    return 'cover'
  }

  if (text === 'contain' || text === 'fit' || text === 'inside') {
    return 'contain'
  }

  if (text === 'stretch') {
    return 'stretch'
  }

  throw new Error('fit is cover (fill the box, cutting what overflows), contain (inside the box) or stretch')
}

/**
 * A picture of `width`×`height` in a box: which of its pixels to keep (`crop`, all of them unless
 * it covers the box) and the layer's own box (smaller than the box when it is contained).
 */
export function fitPicture(width: number, height: number, box: Rect, fit: PictureFit): { crop: Rect; box: Rect } {
  const whole = { x: 0, y: 0, width, height }

  if (fit === 'stretch') {
    return { crop: whole, box }
  }

  if (fit === 'contain') {
    const scale = Math.min(box.width / width, box.height / height)
    const w = width * scale
    const h = height * scale

    return { crop: whole, box: { x: box.x + (box.width - w) / 2, y: box.y + (box.height - h) / 2, width: w, height: h } }
  }

  const scale = Math.max(box.width / width, box.height / height)
  const w = Math.min(width, Math.max(1, Math.round(box.width / scale)))
  const h = Math.min(height, Math.max(1, Math.round(box.height / scale)))

  return { crop: { x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), width: w, height: h }, box }
}

/** The part of a mask image spread over `box` that lies under `inner` (a box inside it), in the mask's pixels. */
export function maskPart(maskWidth: number, maskHeight: number, box: Rect, inner: Rect): Rect {
  const sx = maskWidth / box.width
  const sy = maskHeight / box.height
  const x = Math.max(0, Math.floor((inner.x - box.x) * sx))
  const y = Math.max(0, Math.floor((inner.y - box.y) * sy))

  return { x, y, width: Math.max(1, Math.min(maskWidth - x, Math.ceil(inner.width * sx))), height: Math.max(1, Math.min(maskHeight - y, Math.ceil(inner.height * sy))) }
}

/** Remove Background's result, however it was written: the layer's mask (the default) or a cut-out layer. */
export function backgroundModeFrom(value: unknown): 'mask' | 'cutout' {
  const text = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z]/g, '')

  if (!text || text === 'mask' || text === 'layermask') {
    return 'mask'
  }

  if (['cutout', 'cut', 'newlayer', 'layer', 'copy'].includes(text)) {
    return 'cutout'
  }

  throw new Error('mode is mask (hide the background with a layer mask) or cutout (a new layer with just the subject)')
}

/** A fraction from 0 to 1, or a percentage. */
export function fractionFrom(value: unknown, name: string): number | undefined {
  const number = finite(value)

  if (number === undefined) {
    return undefined
  }

  const fraction = number > 1 ? number / 100 : number

  if (fraction < 0 || fraction > 1) {
    throw new Error(`${name} is from 0 to 1 (or a percentage)`)
  }

  return fraction
}

/** The box a fill works on: null when none is given, otherwise x, y, width and height cut to the canvas. */
export function holeBox(canvas: { width: number; height: number }, args: Record<string, unknown>): Rect | null {
  const [x, y, width, height] = [finite(args.x), finite(args.y), finite(args.width), finite(args.height)]

  if (x === undefined && y === undefined && width === undefined && height === undefined) {
    return null
  }

  if (width === undefined || height === undefined) {
    throw new Error('Give the whole box to fill: x, y, width and height in canvas pixels')
  }

  const left = Math.max(0, Math.round(x ?? 0))
  const top = Math.max(0, Math.round(y ?? 0))
  const right = Math.min(canvas.width, Math.round((x ?? 0) + width))
  const bottom = Math.min(canvas.height, Math.round((y ?? 0) + height))

  if (right - left < 1 || bottom - top < 1) {
    throw new Error(`That box is outside the ${canvas.width}×${canvas.height} canvas`)
  }

  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** A colour or gradient fill's box: what is given, and the rest of the canvas for what is not. */
export function fillBox(canvas: { width: number; height: number }, args: Record<string, unknown>): { x: number; y: number; width: number; height: number } {
  const x = finite(args.x) ?? 0
  const y = finite(args.y) ?? 0

  return { x, y, width: Math.max(1, Math.round(finite(args.width) ?? canvas.width - x)), height: Math.max(1, Math.round(finite(args.height) ?? canvas.height - y)) }
}

/**
 * A gradient written as text: colours first to last, each with an optional position ("#ff8800
 * 30%"), split at commas outside brackets so rgba() colours work. As in CSS, the ends default to 0%
 * and 100%, stops without a position share the space between their neighbours evenly, and a stop
 * placed before the one ahead of it moves up to it.
 */
export function gradientStopsFrom(text: string): { colour: string; at: number }[] {
  const parts: string[] = []
  let depth = 0
  let start = 0

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') {
      depth++
    } else if (text[i] === ')') {
      depth = Math.max(0, depth - 1)
    } else if (text[i] === ',' && !depth) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }

  parts.push(text.slice(start))
  const stops = parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [, colour, percent] = /^(.*?)(?:\s+(-?\d+(?:\.\d+)?)%)?$/.exec(part)!

      if (percent !== undefined && (Number(percent) < 0 || Number(percent) > 100)) {
        throw new Error(`Gradient positions go from 0% to 100%, not ${percent}% ("${part}")`)
      }

      return { colour: colour.trim(), at: percent === undefined ? null : Number(percent) / 100 }
    })

  if (stops.length < 2) {
    throw new Error('A gradient needs at least two colours, like "#ff0000, #0000ff", with positions if wanted: "#000 0%, #fff 70%"')
  }

  stops[0].at ??= 0
  stops[stops.length - 1].at ??= 1
  let last = 0

  for (let i = 0; i < stops.length; i++) {
    if (stops[i].at === null) {
      let next = i

      while (stops[next].at === null) {
        next++
      }

      const from = stops[i - 1].at!
      const to = stops[next].at!

      for (let k = i; k < next; k++) {
        stops[k].at = from + ((to - from) * (k - i + 1)) / (next - i + 1)
      }
    }

    stops[i].at = Math.max(last, stops[i].at!)
    last = stops[i].at!
  }

  return stops as { colour: string; at: number }[]
}

/** A gradient style however it was written; linear when none is given. */
export function gradientStyleFrom(value: unknown): GradientStyle {
  if (value === undefined || value === null || value === '') {
    return 'linear'
  }

  const style = String(value).trim().toLowerCase()

  if (!(GRADIENT_STYLES as readonly string[]).includes(style)) {
    throw new Error(`A gradient's style is ${GRADIENT_STYLES.join(', ')}, not "${String(value)}"`)
  }

  return style as GradientStyle
}

/** A blend mode however it was written ("soft light", "SoftLight", "Linear Dodge (Add)"). */
export function blendFrom(value: unknown): BlendMode | undefined {
  if (value === undefined || value === '') {
    return undefined
  }

  const squash = (text: string) => text.toLowerCase().replace(/[^a-z]/g, '')
  const wanted = String(value)
  const mode = BLEND_MODES.find((entry) => entry.toLowerCase() === wanted.toLowerCase() || squash(entry) === squash(wanted)) ?? (squash(wanted) === 'add' ? 'Linear Dodge (Add)' : undefined)

  if (!mode) {
    throw new Error(`Blend modes: ${BLEND_MODES.join(', ')}`)
  }

  return mode
}

/** Opacity from 0 to 1, or from a percentage. */
export function opacityFrom(value: unknown): number | undefined {
  const number = finite(value)

  return number === undefined ? undefined : Math.max(0, Math.min(1, number > 1 ? number / 100 : number))
}

const words = (value: unknown): string => String(value ?? '').trim().toLowerCase()

/** Text alignment however it was written ("centre", "middle", "right"); undefined when not given. */
export function alignFrom(value: unknown): TextAlignment | undefined {
  const text = words(value)

  if (!text) {
    return undefined
  }

  if (['left', 'start'].includes(text)) {
    return 'Left'
  }

  if (['center', 'centre', 'middle'].includes(text)) {
    return 'Center'
  }

  if (['right', 'end'].includes(text)) {
    return 'Right'
  }

  throw new Error('align is left, center or right')
}

/** A shape kind however it was written: a rectangle (rect, square, box), a rounded one, an ellipse (circle, oval) or a line. */
export function shapeKindFrom(value: unknown): { kind: ShapeKind; rounded: boolean } {
  const text = words(value).replace(/[\s_-]+/g, ' ')

  if (['rectangle', 'rect', 'square', 'box'].includes(text)) {
    return { kind: 'Rectangle', rounded: false }
  }

  if (['rounded', 'rounded rectangle', 'rounded rect', 'round rect', 'pill'].includes(text)) {
    return { kind: 'Rectangle', rounded: true }
  }

  if (['ellipse', 'circle', 'oval'].includes(text)) {
    return { kind: 'Ellipse', rounded: false }
  }

  if (['line', 'rule', 'stroke'].includes(text)) {
    return { kind: 'Line', rounded: false }
  }

  throw new Error('kind is rectangle, rounded, ellipse or line')
}

/** The thickest line a shape layer draws, in pixels. */
export const MAX_LINE_WIDTH = 2000

/** The ends of a line across a box, corner to corner, inset so its width stays inside (fractions of the box). */
export function diagonalEnds(box: { width: number; height: number }, lineWidth: number): [Vec2, Vec2] {
  const reach = lineWidth / 2 + 1
  const inset = (span: number) => Math.min(0.5, reach / Math.max(1, span))

  return [
    [inset(box.width), inset(box.height)],
    [1 - inset(box.width), 1 - inset(box.height)]
  ]
}

/**
 * A shape layer's style after a change, in a box `width`×`height`: its kind (a rounded rectangle is a
 * rectangle with a corner radius), colour, corner radius or line width. A rectangle or ellipse
 * turned into a line runs corner to corner inside the box.
 */
export function shapeWith(shape: ShapeStyle, args: Record<string, unknown>, box: { width: number; height: number }, colour: (value: unknown) => RGB): { style: ShapeStyle; changes: string[] } {
  const style: ShapeStyle = { ...shape }
  const changes: string[] = []
  const largestRadius = Math.max(0, Math.min(box.width, box.height) / 2)

  if (args.kind !== undefined && args.kind !== '') {
    const { kind, rounded } = shapeKindFrom(args.kind)
    style.kind = kind
    delete style.start
    delete style.end
    delete style.lineWidth

    if (kind === 'Line') {
      const lineWidth = shape.kind === 'Line' && shape.lineWidth ? shape.lineWidth : 4
      const [start, end] = shape.kind === 'Line' && shape.start && shape.end ? [shape.start, shape.end] : diagonalEnds(box, lineWidth)
      Object.assign(style, { cornerRadius: 0, lineWidth, start, end })
    } else {
      style.cornerRadius = kind === 'Rectangle' && rounded ? (shape.kind === 'Rectangle' && shape.cornerRadius > 0 ? shape.cornerRadius : Math.round(Math.min(box.width, box.height) * 0.15)) : 0
    }

    changes.push(kind === 'Rectangle' ? (style.cornerRadius > 0 ? 'a rounded rectangle' : 'a rectangle') : kind === 'Ellipse' ? 'an ellipse' : 'a line')
  }

  if (args.color !== undefined && args.color !== '') {
    Object.assign(style, colour(args.color))
    changes.push('colour')
  }

  const radius = finite(args.radius)

  if (radius !== undefined) {
    if (style.kind !== 'Rectangle') {
      throw new Error(`radius rounds a rectangle’s corners, and this shape is ${style.kind === 'Ellipse' ? 'an ellipse' : 'a line'} (give kind=rounded to make it a rectangle)`)
    }

    style.cornerRadius = Math.round(Math.min(largestRadius, Math.max(0, radius)) * 100) / 100
    changes.push(`corner radius ${style.cornerRadius}`)
  }

  const lineWidth = finite(args.lineWidth)

  if (lineWidth !== undefined) {
    if (style.kind !== 'Line') {
      throw new Error(`lineWidth is for lines, and this shape is ${style.kind === 'Ellipse' ? 'an ellipse' : 'a rectangle'} (give kind=line to make it one)`)
    }

    style.lineWidth = Math.min(MAX_LINE_WIDTH, Math.max(1, lineWidth))
    changes.push(`line width ${style.lineWidth}`)
  }

  if (!changes.length) {
    throw new Error('Nothing to change: give kind (rectangle, rounded, ellipse or line), color, radius or lineWidth')
  }

  return { style, changes }
}

/** Style words at the end of a font name ("Avenir Next Bold Italic") and the weights they stand for. */
const FONT_STYLES: [RegExp, number][] = [
  [/^(thin|hairline)$/, 100],
  [/^(extra ?light|ultra ?light)$/, 200],
  [/^light$/, 300],
  [/^(regular|normal|book|plain)$/, 400],
  [/^medium$/, 500],
  [/^(semi ?bold|demi ?bold)$/, 600],
  [/^bold$/, 700],
  [/^(extra ?bold|ultra ?bold)$/, 800],
  [/^(black|heavy)$/, 900]
]

/**
 * A font as the format keeps it (a PostScript-style name) from what was written: a PostScript
 * name as it is ("HelveticaNeue-Bold"), or a family with style words after it ("Avenir Next
 * Bold Italic", "Georgia").
 */
export function fontNameFrom(value: unknown, fallback = 'Helvetica'): string {
  const text = String(value ?? '').trim()

  if (!text) {
    return fallback
  }

  if (!/\s/.test(text)) {
    return text
  }

  const parts = text.split(/\s+/)
  let weight = 400
  let italic = false

  // Style words come off the end ("Extra Bold" is two of them).
  for (;;) {
    const last = parts.at(-1)?.toLowerCase() ?? ''
    const two = parts.length > 2 ? `${parts.at(-2)!.toLowerCase()} ${last}` : ''
    const pair = FONT_STYLES.find(([pattern]) => two && pattern.test(two))
    const single = FONT_STYLES.find(([pattern]) => pattern.test(last))

    if (/^(italic|oblique)$/.test(last) && parts.length > 1) {
      italic = true
      parts.pop()
    } else if (pair) {
      weight = pair[1]
      parts.splice(-2, 2)
    } else if (single && parts.length > 1) {
      weight = single[1]
      parts.pop()
    } else {
      break
    }
  }

  return postScriptName({ family: parts.join(' '), weight, italic })
}

/** An anchor however it was written ("top left", "top-left", "centre", "bottom"); the centre when not given. */
export function anchorFrom(value: unknown): Anchor {
  const text = words(value).replace(/[\s_]+/g, '-').replace('centre', 'center').replace('middle', 'center')

  if (!text || text === 'center-center') {
    return 'center'
  }

  const flipped = text.split('-').reverse().join('-')
  const anchor = ANCHORS.find((entry) => entry === text || entry === flipped || entry === text.replace(/-?center-?/, ''))

  if (!anchor) {
    throw new Error(`anchor is one of: ${ANCHORS.join(', ')}`)
  }

  return anchor
}

export type ResizePlan = { kind: 'canvas'; width: number; height: number; anchor: Anchor } | { kind: 'image'; width: number; height: number; resample: boolean }

/**
 * What a resize asks for: with `scale`, or `image` true, the whole image scaled (one side alone
 * keeps the proportions); otherwise the canvas grown or cut around `anchor`, layers untouched.
 */
export function resizePlan(state: { width: number; height: number }, args: Record<string, unknown>): ResizePlan {
  const scale = finite(args.scale)
  const width = finite(args.width)
  const height = finite(args.height)

  if (scale !== undefined) {
    if (scale <= 0) {
      throw new Error('scale must be above 0')
    }

    return { kind: 'image', width: Math.max(1, Math.round(state.width * scale)), height: Math.max(1, Math.round(state.height * scale)), resample: args.resample !== false }
  }

  if (width === undefined && height === undefined) {
    throw new Error('Give width and height (pixels), or scale')
  }

  if (args.image === true) {
    const w = width ?? (height! * state.width) / state.height
    const h = height ?? (width! * state.height) / state.width

    return { kind: 'image', width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)), resample: args.resample !== false }
  }

  return { kind: 'canvas', width: Math.max(1, Math.round(width ?? state.width)), height: Math.max(1, Math.round(height ?? state.height)), anchor: anchorFrom(args.anchor) }
}

/** The box a crop keeps: what is given, the rest of the canvas for what is not, cut to the canvas. */
export function cropBox(state: { width: number; height: number }, args: Record<string, unknown>): Rect {
  const x = Math.max(0, Math.round(finite(args.x) ?? 0))
  const y = Math.max(0, Math.round(finite(args.y) ?? 0))
  const width = Math.min(state.width - x, Math.round(finite(args.width) ?? state.width - x))
  const height = Math.min(state.height - y, Math.round(finite(args.height) ?? state.height - y))

  if (width < 1 || height < 1) {
    throw new Error(`That box is outside the ${state.width}×${state.height} canvas`)
  }

  return { x, y, width, height }
}

/**
 * What a crop keeps: the box given (the rest of the canvas for what is left out), held to `ratio`
 * around its centre; with `angle`, the picture is turned that many degrees clockwise first, and
 * without a box the crop is the largest one (of the ratio, or the canvas's shape) the turned
 * picture fills, so no empty corners show.
 */
export function cropPlan(state: { width: number; height: number }, args: Record<string, unknown>): { box: Rect; angle: number } {
  const angle = finite(args.angle) ?? 0

  if (Math.abs(angle) > 180) {
    throw new Error(`angle is degrees from -180 to 180 (it was ${angle})`)
  }

  const ratio = ratioFrom(args.ratio, state)
  const boxGiven = [args.x, args.y, args.width, args.height].some((value) => finite(value) !== undefined)

  if (angle && !boxGiven) {
    return { box: largestTurnedBox(state.width, state.height, angle, ratio ?? state.width / state.height), angle }
  }

  const box = cropBox(state, args)

  return { box: ratio ? fitRatio(box, ratio) : box, angle }
}

/** A line's two ends from a box: it runs from (x, y) to (x + width, y + height). */
export function lineEnds(args: Record<string, unknown>, canvas: { width: number; height: number }): [Vec2, Vec2] {
  const x = finite(args.x) ?? 0
  const y = finite(args.y) ?? canvas.height / 2
  const width = finite(args.width) ?? canvas.width - x
  const height = finite(args.height) ?? 0

  if (!width && !height) {
    throw new Error('A line needs a length: give width (across) and/or height (down)')
  }

  return [
    [x, y],
    [x + width, y + height]
  ]
}

/** The fields of an adjustment that its kind uses, as `canvas.setAdjustment` takes them. */
export function adjustmentSettings(adjustment: Adjustment): Record<string, unknown> {
  const fields: Record<Adjustment['kind'], string[]> = {
    'Hue/Saturation': ['hue', 'saturation', 'lightness', 'colorize'],
    Levels: ['levels'],
    Curves: ['curves'],
    Exposure: ['exposureSettings'],
    'Gradient Map': ['gradientMapSettings'],
    Grain: ['grainSettings'],
    Invert: [],
    'Black & White': ['blackWhiteSettings'],
    'Color Balance': ['colorBalanceSettings'],
    'Gaussian Blur': ['blurRadius'],
    'Motion Blur': ['motionAngle', 'motionDistance'],
    'Add Noise': ['noiseAmount', 'noiseGaussian', 'noiseMonochromatic', 'noiseSeed']
  }

  return Object.fromEntries(fields[adjustment.kind].filter((key) => adjustment[key] !== undefined).map((key) => [key, adjustment[key]]))
}

/** A JSON object argument (settings, effects): an object as it is, or JSON text of one; nothing given is an empty one. */
export function jsonObject(value: unknown, what: string, example: string): Record<string, unknown> {
  if (value === undefined || value === null || value === '') {
    return {}
  }

  let parsed: unknown = value

  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      parsed = null
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${what} must be a JSON object, like ${example}`)
  }

  return parsed as Record<string, unknown>
}

/** A colour Hermes wrote (any CSS colour) as the format's red, green and blue from 0 to 1. */
export type ColourReader = (value: unknown) => RGB

/** Colours written as text in a record ("color", or named fields like a gradient map's ends) as red, green and blue. */
function withColours(record: Record<string, unknown>, fields: string[], read: ColourReader | undefined): Record<string, unknown> {
  const out = { ...record }

  for (const field of fields) {
    if (typeof out[field] !== 'string') {
      continue
    }

    if (!read) {
      throw new Error(`${field} needs red, green and blue from 0 to 1`)
    }

    const colour = read(out[field])

    // An effect's colour is its own red, green and blue; a gradient map's ends are records.
    if (field === 'color' || field === 'colour') {
      delete out[field]
      Object.assign(out, colour)
    } else {
      out[field] = colour
    }
  }

  return out
}

/**
 * An adjustment with settings changed: nested settings merge over what it has (a gradient map's
 * ends may be CSS colours), and the result is checked as strictly as a project file would be.
 */
export function adjustmentWith(current: Adjustment, settings: Record<string, unknown>, read?: ColourReader): Adjustment {
  if (settings.kind !== undefined && settings.kind !== current.kind) {
    throw new Error(`An adjustment keeps its kind (${current.kind}): add a new adjustment layer for another`)
  }

  const prepared = { ...settings }

  if (prepared.gradientMapSettings && typeof prepared.gradientMapSettings === 'object') {
    prepared.gradientMapSettings = withColours(prepared.gradientMapSettings as Record<string, unknown>, ['shadows', 'highlights'], read)
  }

  return checkAdjustment({ ...mergeSettings(current, prepared), kind: current.kind })
}

/**
 * Veritas-only adjustment settings with changes merged in, checked as strictly as a project file's:
 * nested settings merge (a mixer row, a range's inks), and a Photo Filter's colour may be any CSS
 * colour. A Color Lookup's table (`table`, a file) is read by the caller; it is not a setting here.
 */
export function heraldWith(current: HeraldAdjustment, settings: Record<string, unknown>, read?: ColourReader): HeraldAdjustment {
  if (settings.kind !== undefined && settings.kind !== current.kind) {
    throw new Error(`An adjustment keeps its kind (${current.kind}): add a new adjustment layer for another`)
  }

  const { table: _table, ...prepared } = settings

  if (typeof prepared.color === 'string') {
    if (!read) {
      throw new Error('color needs red, green and blue from 0 to 1')
    }

    prepared.color = read(prepared.color)
  }

  if (current.kind === 'Color Lookup' && (prepared.size !== undefined || prepared.name !== undefined)) {
    throw new Error('A Color Lookup takes its table from a file: settings={"table": "~/LUTs/Film.cube"}')
  }

  return checkHeraldAdjustment({ ...mergeSettings(current, prepared), kind: current.kind })
}

/** Veritas-only settings as Hermes reads and sets them: the record without its kind. */
export const heraldSettings = (settings: HeraldAdjustment): Record<string, unknown> => {
  const { kind: _kind, ...rest } = settings

  return rest
}

/** An effect's name however it was written ("drop shadow", "DropShadow", "glow", "outline"). */
export function effectKindFrom(name: string): EffectKind {
  const squashed = name.toLowerCase().replace(/[^a-z]/g, '')
  const aliases: Record<string, EffectKind> = {
    stroke: 'stroke',
    outline: 'stroke',
    shadow: 'shadow',
    dropshadow: 'shadow',
    coloroverlay: 'colorOverlay',
    colouroverlay: 'colorOverlay',
    overlay: 'colorOverlay',
    innershadow: 'innerShadow',
    outerglow: 'outerGlow',
    glow: 'outerGlow',
    innerglow: 'innerGlow'
  }
  const kind = aliases[squashed]

  if (!kind) {
    throw new Error(`Effects: ${EFFECT_KINDS.join(', ')} (“${name}” is not one)`)
  }

  return kind
}

/**
 * A layer's effects after a change. Per effect: an object of settings merged over what it has (or
 * over the effect's defaults when the layer lacks it), true to add or show it, false or null to
 * remove it; {"enabled": false} hides it and keeps its settings. `color` takes any CSS colour and
 * an opacity above 1 is a percentage. Effects other apps wrote stay as they were.
 */
export function effectsWith(current: LayerEffects | undefined, patch: Record<string, unknown>, read?: ColourReader): LayerEffects | undefined {
  const next: LayerEffects = { ...current }

  for (const [name, value] of Object.entries(patch)) {
    const kind = effectKindFrom(name)

    if (value === false || value === null) {
      delete next[kind]
      continue
    }

    const existing = (next[kind] as Record<string, unknown> | undefined) ?? (defaultEffect[kind]() as unknown as Record<string, unknown>)

    if (value === true) {
      next[kind] = { ...existing, enabled: true } as never
      continue
    }

    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${name} takes an object of settings, true to add it, or false to remove it`)
    }

    const record = withColours({ ...existing, ...(value as Record<string, unknown>) }, ['color', 'colour'], read)

    if (typeof record.opacity === 'number' && record.opacity > 1) {
      record.opacity = Math.min(100, record.opacity) / 100
    }

    next[kind] = record as never
  }

  const checked = checkEffects(next)

  return Object.keys(checked).length ? checked : undefined
}

/** A mask action however it was written ("reveal all", "hide_selection", "off", "delete"). */
export function maskActionFrom(value: unknown): MaskAction {
  const squashed = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z]/g, '')
  const aliases: Record<string, MaskAction> = {
    reveal: 'reveal',
    revealall: 'reveal',
    show: 'reveal',
    showall: 'reveal',
    hide: 'hide',
    hideall: 'hide',
    revealselection: 'revealSelection',
    showselection: 'revealSelection',
    hideselection: 'hideSelection',
    invert: 'invert',
    apply: 'apply',
    enable: 'enable',
    on: 'enable',
    disable: 'disable',
    off: 'disable',
    remove: 'remove',
    delete: 'remove',
    link: 'link',
    unlink: 'unlink'
  }
  const action = aliases[squashed]

  if (!action) {
    throw new Error(`Mask actions: ${MASK_ACTIONS.join(', ')}`)
  }

  return action
}

/**
 * The edges to align by, however they were written ("left", "bottom right", "center,middle",
 * "centre"): at most one each way. A second "center" (or one after left or right) is the vertical
 * centre, so "center center" centres both ways.
 */
export function alignEdgesFrom(value: unknown): AlignEdge[] {
  const parts = words(value).split(/[\s,;+/_-]+/).filter(Boolean)
  let across: AlignEdge | undefined
  let down: AlignEdge | undefined

  if (!parts.length) {
    throw new Error('edge is left, center, right, top, middle or bottom; two (like "bottom,right" or "center,middle") align both ways')
  }

  for (const part of parts) {
    if (part === 'left' || part === 'right') {
      if (across === 'center' && !down) {
        down = 'middle'
      }

      across = part
    } else if (part === 'top' || part === 'bottom') {
      down = part
    } else if (part === 'middle') {
      down = 'middle'
    } else if (part === 'center' || part === 'centre') {
      if (across) {
        down = 'middle'
      } else {
        across = 'center'
      }
    } else {
      throw new Error(`edge is left, center, right, top, middle or bottom (“${part}” is not one)`)
    }
  }

  return [across, down].filter((edge): edge is AlignEdge => Boolean(edge))
}

/** What layers align to, however it was written; the canvas for one layer and each other for several when not given. */
export function alignToFrom(value: unknown, count: number): AlignTo {
  const text = words(value).replace(/[^a-z]/g, '')

  if (!text) {
    return count >= 2 ? 'layers' : 'canvas'
  }

  if (['canvas', 'document', 'page', 'image'].includes(text)) {
    return 'canvas'
  }

  if (['layers', 'eachother', 'each', 'together', 'group'].includes(text)) {
    return 'layers'
  }

  if (['selection', 'selected'].includes(text)) {
    return 'selection'
  }

  throw new Error('to is canvas, layers (each other) or selection')
}

/** How to distribute, however it was written: equal gaps across or down, or even edges or centres. */
export function distributeFrom(value: unknown): DistributeMode {
  const text = words(value).replace(/[^a-z]/g, '')
  const aliases: Record<string, DistributeMode> = {
    horizontal: 'horizontal',
    horizontally: 'horizontal',
    across: 'horizontal',
    horizontalspacing: 'horizontal',
    vertical: 'vertical',
    vertically: 'vertical',
    down: 'vertical',
    verticalspacing: 'vertical',
    left: 'left',
    center: 'center',
    centre: 'center',
    right: 'right',
    top: 'top',
    middle: 'middle',
    bottom: 'bottom'
  }
  const mode = aliases[text]

  if (!mode) {
    throw new Error('distribute is horizontal or vertical (equal gaps), or left, center, right, top, middle or bottom (even edges or centres)')
  }

  return mode
}

/** A filter however it was written ("Unsharp Mask", "sharpen", "gaussian", "denoise"). */
export function filterKindFrom(value: unknown): FilterKind {
  const text = words(value).replace(/[^a-z]/g, '')
  const aliases: Record<string, FilterKind> = {
    gaussianblur: 'gaussianBlur',
    gaussian: 'gaussianBlur',
    blur: 'gaussianBlur',
    motionblur: 'motionBlur',
    motion: 'motionBlur',
    highpass: 'highPass',
    unsharpmask: 'unsharpMask',
    unsharp: 'unsharpMask',
    usm: 'unsharpMask',
    sharpen: 'unsharpMask',
    smartsharpen: 'smartSharpen',
    reducenoise: 'reduceNoise',
    denoise: 'reduceNoise',
    noisereduction: 'reduceNoise',
    addnoise: 'addNoise',
    noise: 'addNoise',
    median: 'median',
    despeckle: 'median'
  }
  const kind = aliases[text]

  if (!kind) {
    throw new Error('kind is one of: Gaussian Blur, Motion Blur, High Pass, Unsharp Mask (sharpen), Smart Sharpen, Reduce Noise, Add Noise, Median')
  }

  return kind
}

/** Which way a guide runs, however it was written: vertical (a line down, at an x) or horizontal (across, at a y). */
export function guideAxisFrom(value: unknown): 'vertical' | 'horizontal' {
  const text = words(value)

  if (['vertical', 'v', 'x', 'column', 'down'].includes(text)) {
    return 'vertical'
  }

  if (['horizontal', 'h', 'y', 'row', 'across'].includes(text)) {
    return 'horizontal'
  }

  throw new Error('axis is vertical (a line down the canvas, at an x) or horizontal (a line across, at a y)')
}

/** Which automatic fix, however it was written ("tone", "Auto Contrast", "colour"); tone when not given. */
export function autoModeFrom(value: unknown): AutoMode {
  const text = words(value).replace(/^auto\s*/, '').replace(/[^a-z]/g, '')

  if (!text || text === 'tone' || text === 'levels') {
    return 'tone'
  }

  if (text === 'contrast') {
    return 'contrast'
  }

  if (text === 'color' || text === 'colour') {
    return 'color'
  }

  throw new Error('kind is tone, contrast or color')
}

/** How many steps an undo or redo takes: one when not given, at most a thousand. */
export function stepCount(value: unknown): number {
  const number = finite(value)

  if (number === undefined) {
    return 1
  }

  if (number < 1) {
    throw new Error('steps is how many steps to take: 1 or more')
  }

  return Math.min(1000, Math.round(number))
}

/** Undo or redo up to `count` steps; the labels of the steps taken (fewer when the history runs out). */
export function stepThrough(doc: { undo(): string | null; redo(): string | null }, direction: 'undo' | 'redo', count: number): string[] {
  const labels: string[] = []

  for (let i = 0; i < count; i++) {
    const label = direction === 'undo' ? doc.undo() : doc.redo()

    if (!label) {
      break
    }

    labels.push(label)
  }

  return labels
}

/** History steps the way Hermes reads them: numbered from 1, who made them, and which are undone. */
export function describeHistory(steps: readonly HistoryStep[], applied: number): Record<string, unknown>[] {
  return steps.map((step, i) => ({ step: i + 1, label: step.label, ...(step.origin ? { by: step.origin === 'command' ? 'Hermes or a command' : 'outside the window' } : {}), ...(i + 1 > applied ? { undone: true } : {}) }))
}

/** Settings over an adjustment's defaults: nested objects merge, the rest replaces. */
export function mergeSettings(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }

  for (const [key, value] of Object.entries(extra)) {
    const current = out[key]
    out[key] = value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object' && !Array.isArray(current) ? mergeSettings(current as Record<string, unknown>, value as Record<string, unknown>) : value
  }

  return out
}
