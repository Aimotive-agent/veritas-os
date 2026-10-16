/*
 * Layer effects on the GPU: the layer and its effects drawn as one unit, then composited the way the
 * layer itself is (opacity, blend mode, folders' masks, clipping). Under the layer's pixels go the
 * drop shadow (its shape moved and softened) and the outer glow; over them, inside their alpha, the
 * colour overlay, inner glow and inner shadow; a stroke sits outside the edge, under the pixels so
 * the two meet without a seam, or inside it, over them. Sizes are in layer pixels, carried through
 * the layer's transform. The work happens in a tile around the layer, not over the whole frame.
 */

import type { LayerEffects } from '../../../../../shared/canvas/comp-format.ts'
import type { CanvasLayer } from '../document.ts'
import { boundsOf, multiply, pixelToDocument, translate } from '../geometry.ts'
import type { Rect } from '../raster.ts'
import type { Compositor, FrameInfo, LayerCoverage, LayerPass } from './compositor.ts'
import type { Scaled } from './filters.ts'
import type { Program, Target } from './gl.ts'
import { TILE_ALIGN } from '../tiles.ts'
import { BLEND_FUNCTIONS, blendModeIndex, COVERAGE, FULL_VERTEX, WHOLE } from './shaders.ts'

/** The effects that draw something: present, not hidden, and not at zero opacity or size. */
export function visibleEffects(effects: LayerEffects | undefined): LayerEffects | null {
  if (!effects) {
    return null
  }

  const shown = <T extends { enabled?: boolean; opacity: number }>(record: T | undefined, size = 1): T | undefined => (record && record.enabled !== false && record.opacity > 0 && size > 0 ? record : undefined)
  const visible: LayerEffects = {
    stroke: shown(effects.stroke, effects.stroke?.size),
    shadow: shown(effects.shadow),
    colorOverlay: shown(effects.colorOverlay),
    innerShadow: shown(effects.innerShadow),
    outerGlow: shown(effects.outerGlow, effects.outerGlow?.size),
    innerGlow: shown(effects.innerGlow, effects.innerGlow?.size)
  }

  return Object.values(visible).some(Boolean) ? visible : null
}

/** Where a shadow falls, in layer pixels (y down): away from the light, which comes from `angle` degrees counterclockwise from the right. */
export const shadowOffset = (angle: number, distance: number): [number, number] => [-Math.cos((angle * Math.PI) / 180) * distance, Math.sin((angle * Math.PI) / 180) * distance]

/** The unit: shadow, glow and outside stroke under the pixels; overlay, inner glow, inner shadow and inside stroke inside them. */
const EFFECTS_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_content;
uniform sampler2D u_shadow;
uniform vec2 u_shadowSize;
uniform float u_shadowPad;
uniform vec2 u_shadowOffset;
uniform vec4 u_shadowColor;
uniform bool u_hasShadow;
uniform sampler2D u_innerShadow;
uniform vec2 u_innerShadowSize;
uniform float u_innerShadowPad;
uniform vec2 u_innerShadowOffset;
uniform vec4 u_innerShadowColor;
uniform bool u_hasInnerShadow;
uniform sampler2D u_glow;
uniform vec2 u_glowSize;
uniform float u_glowPad;
uniform vec4 u_glowColor;
uniform bool u_hasGlow;
uniform sampler2D u_innerGlow;
uniform vec2 u_innerGlowSize;
uniform float u_innerGlowPad;
uniform vec4 u_innerGlowColor;
uniform bool u_hasInnerGlow;
uniform vec4 u_overlay;
uniform bool u_hasOverlay;
uniform highp usampler2D u_seeds;
uniform bool u_hasStroke;
uniform bool u_strokeInside;
uniform float u_strokeSize;
uniform vec4 u_strokeColor;
out vec4 o;

vec4 over(vec4 top, vec4 bottom) { return top + bottom * (1.0 - top.a); }

// The nearest seed is a pixel on the other side of the edge; its coverage says how far past its
// centre the edge really lies, for a smooth stroke on soft edges.
float strokeAt(vec2 p) {
  uvec4 seed = texelFetch(u_seeds, ivec2(p), 0);
  if (seed.x == 0u) return 0.0;
  float d = distance(vec2(seed.xy) - 0.5, p);
  float lean = float(seed.z) / 65535.0 - 0.5;
  float edge = u_strokeInside ? d + lean : d - lean;
  return clamp(u_strokeSize + 0.5 - edge, 0.0, 1.0);
}

void main() {
  vec2 p = gl_FragCoord.xy;
  vec4 content = texelFetch(u_content, ivec2(p), 0);
  float a = content.a;
  vec4 unit = vec4(0.0);
  if (u_hasShadow) {
    float s = texture(u_shadow, (p - u_shadowOffset + u_shadowPad) / u_shadowSize).a;
    unit = over(vec4(u_shadowColor.rgb, 1.0) * (s * u_shadowColor.a), unit);
  }
  if (u_hasGlow) {
    // Doubled, so the glow is full at the edge of a solid shape and fades out over its size.
    float g = clamp(2.0 * texture(u_glow, (p + u_glowPad) / u_glowSize).a, 0.0, 1.0);
    unit = over(vec4(u_glowColor.rgb, 1.0) * (g * u_glowColor.a), unit);
  }
  if (u_hasStroke && !u_strokeInside) {
    unit = over(vec4(u_strokeColor.rgb, 1.0) * (strokeAt(p) * u_strokeColor.a), unit);
  }
  vec3 c = a > 0.0 ? clamp(content.rgb / a, 0.0, 1.0) : vec3(0.0);
  if (u_hasOverlay) c = mix(c, u_overlay.rgb, u_overlay.a);
  if (u_hasInnerGlow) {
    float g = clamp(2.0 * (1.0 - texture(u_innerGlow, (p + u_innerGlowPad) / u_innerGlowSize).a), 0.0, 1.0);
    c = mix(c, u_innerGlowColor.rgb, g * u_innerGlowColor.a);
  }
  if (u_hasInnerShadow) {
    float s = 1.0 - texture(u_innerShadow, (p - u_innerShadowOffset + u_innerShadowPad) / u_innerShadowSize).a;
    c = mix(c, u_innerShadowColor.rgb, s * u_innerShadowColor.a);
  }
  if (u_hasStroke && u_strokeInside) c = mix(c, u_strokeColor.rgb, strokeAt(p) * u_strokeColor.a);
  o = over(vec4(c * a, a), unit);
}
`

/** The unit over the backdrop, every pixel of the frame: the tile's pixels where it lies, the backdrop alone elsewhere. */
const UNIT_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_backdrop;
uniform sampler2D u_unit;
uniform ivec2 u_tileOrigin;
uniform ivec2 u_tileSize;
uniform int u_mode;
${COVERAGE}
${BLEND_FUNCTIONS}
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 q = p - u_tileOrigin;
  vec4 s = q.x >= 0 && q.y >= 0 && q.x < u_tileSize.x && q.y < u_tileSize.y ? texelFetch(u_unit, q, 0) : vec4(0.0);
  o = composite(texelFetch(u_backdrop, p, 0), s * coverage(vec2(0.0)), u_mode);
}
`

const colour = (record: { red: number; green: number; blue: number; opacity: number }): [number, number, number, number] => [record.red, record.green, record.blue, record.opacity]

export class EffectsPass implements LayerPass {
  private readonly effects: Program
  private readonly unit: Program
  /** Bound to the seeds sampler when there is no stroke: an unsigned sampler needs an unsigned texture. */
  private readonly noSeeds: Target

  constructor(private readonly compositor: Compositor) {
    this.effects = compositor.gpu.program(FULL_VERTEX, EFFECTS_FRAGMENT)
    this.unit = compositor.gpu.program(FULL_VERTEX, UNIT_FRAGMENT)
    this.noSeeds = compositor.gpu.createTarget(1, 1, { seeds: true })
  }

  draw(layer: CanvasLayer, backdrop: Target, into: Target, frame: FrameInfo, coverage: LayerCoverage): boolean {
    const effects = layer.adjustment || layer.isGroup ? null : visibleEffects(layer.effects)
    const pixels = layer.pixels

    if (!effects || !pixels) {
      return false
    }

    const { compositor } = this
    const { gpu, filters, blank } = compositor
    // Layer pixels to frame pixels: effect sizes scale by its area's ratio, offsets turn with it.
    const place = multiply(frame.docToTarget, pixelToDocument(layer.transform, pixels.width, pixels.height))
    const k = Math.sqrt(Math.abs(place.a * place.d - place.b * place.c))
    const vector = ([x, y]: [number, number]): [number, number] => [place.a * x + place.c * y, place.b * x + place.d * y]
    const shadow = effects.shadow && { offset: vector(shadowOffset(effects.shadow.angle, effects.shadow.distance)), sigma: (effects.shadow.blur / 2) * k }
    const inner = effects.innerShadow && { offset: vector(shadowOffset(effects.innerShadow.angle, effects.innerShadow.distance)), sigma: (effects.innerShadow.blur / 2) * k }
    const glowSigma = effects.outerGlow ? (effects.outerGlow.size / 2) * k : 0
    const innerGlowSigma = effects.innerGlow ? (effects.innerGlow.size / 2) * k : 0
    const stroke = effects.stroke && { reach: effects.stroke.size * k, inside: effects.stroke.inside }
    const margin =
      2 +
      Math.max(shadow ? Math.hypot(...shadow.offset) + shadow.sigma * 3 : 0, glowSigma * 3, stroke && !stroke.inside ? stroke.reach + 1 : 0, inner ? 2 : 0, innerGlowSigma ? 2 : 0)
    const box = boundsOf(layer.transform)
    const s = frame.scale
    // In the whole document's frame: where this frame starts, and the work tile around the layer.
    // The tile reaches past the frame as far as the effects carry (a layer just outside still
    // casts its shadow in), within the GPU's limit, and starts on the tile grid so its blurs
    // halve the same pixels however the document is cut into tiles.
    const fx = Math.round((frame.docOffset?.[0] ?? 0) * s)
    const fy = Math.round((frame.docOffset?.[1] ?? 0) * s)
    const reach = Math.max(0, Math.min(Math.ceil(margin) + TILE_ALIGN, Math.floor((compositor.gpu.maxTextureSize - Math.max(frame.width, frame.height)) / 2) - TILE_ALIGN))
    const down = (value: number) => Math.floor(value / TILE_ALIGN) * TILE_ALIGN
    const x0 = down(Math.max(Math.floor(box.x * s - margin), fx - reach))
    const y0 = down(Math.max(Math.floor(box.y * s - margin), fy - reach))
    const x1 = Math.min(Math.ceil((box.x + box.width) * s + margin), fx + frame.width + reach)
    const y1 = Math.min(Math.ceil((box.y + box.height) * s + margin), fy + frame.height + reach)

    if (x1 <= x0 || y1 <= y0 || x1 <= fx || y1 <= fy || x0 >= fx + frame.width || y0 >= fy + frame.height) {
      return false
    }

    const tile: FrameInfo = {
      width: x1 - x0,
      height: y1 - y0,
      scale: s,
      docToTarget: multiply(translate(fx - x0, fy - y0), frame.docToTarget),
      precise: frame.precise,
      docOffset: [x0 / s, y0 / s],
      draft: frame.draft
    }
    const format = frame.precise ? 'precise' : 'bytes'
    // The layer's own pixels in the tile, through its own mask: what the effects follow.
    const content = compositor.temporary(tile.width, tile.height, format)
    compositor.drawLayer(compositor.layerShader, layer, tile, 1, null, null)
    const shape: Rect = { x: box.x * s - x0, y: box.y * s - y0, width: box.width * s, height: box.height * s }
    const blurred = (sigma: number): Scaled => filters.blur(content, sigma, format, shape)
    const shadowTex = shadow ? blurred(shadow.sigma) : null
    const innerTex = inner ? blurred(inner.sigma) : null
    const glowTex = effects.outerGlow ? blurred(glowSigma) : null
    const innerGlowTex = effects.innerGlow ? blurred(innerGlowSigma) : null
    const region = { x: 0, y: 0, width: tile.width, height: tile.height }
    const seeds = stroke ? filters.nearestSeeds(content, !stroke.inside, stroke.reach, region) : null

    const unit = compositor.temporary(tile.width, tile.height, format)
    const program = this.effects.use().texture('u_content', 0, content.texture)
    const sampled = (name: string, unitIndex: number, scaled: Scaled | null) => {
      if (scaled) {
        gpu.setSampling(scaled.target.texture, 'linear')
      }

      program
        .texture(`u_${name}`, unitIndex, scaled?.target.texture ?? blank)
        .vec2(`u_${name}Size`, scaled?.size[0] ?? 1, scaled?.size[1] ?? 1)
        .float(`u_${name}Pad`, scaled?.offset ?? 0)
    }
    sampled('shadow', 1, shadowTex)
    sampled('innerShadow', 2, innerTex)
    sampled('glow', 3, glowTex)
    sampled('innerGlow', 4, innerGlowTex)
    program
      .int('u_hasShadow', Boolean(shadow))
      .vec2('u_shadowOffset', ...(shadow?.offset ?? [0, 0]))
      .vec4('u_shadowColor', ...colour(effects.shadow ?? { red: 0, green: 0, blue: 0, opacity: 0 }))
      .int('u_hasInnerShadow', Boolean(inner))
      .vec2('u_innerShadowOffset', ...(inner?.offset ?? [0, 0]))
      .vec4('u_innerShadowColor', ...colour(effects.innerShadow ?? { red: 0, green: 0, blue: 0, opacity: 0 }))
      .int('u_hasGlow', Boolean(glowTex))
      .vec4('u_glowColor', ...colour(effects.outerGlow ?? { red: 0, green: 0, blue: 0, opacity: 0 }))
      .int('u_hasInnerGlow', Boolean(innerGlowTex))
      .vec4('u_innerGlowColor', ...colour(effects.innerGlow ?? { red: 0, green: 0, blue: 0, opacity: 0 }))
      .int('u_hasOverlay', Boolean(effects.colorOverlay))
      .vec4('u_overlay', ...colour(effects.colorOverlay ?? { red: 0, green: 0, blue: 0, opacity: 0 }))
      .texture('u_seeds', 5, (seeds ?? this.noSeeds).texture)
      .int('u_hasStroke', Boolean(stroke))
      .int('u_strokeInside', Boolean(stroke?.inside))
      .float('u_strokeSize', stroke?.reach ?? 0)
      .vec4('u_strokeColor', ...colour(effects.stroke ?? { red: 0, green: 0, blue: 0, opacity: 0 }))
    gpu.drawQuad()

    gpu.bindTarget(into, frame.width, frame.height, false)
    this.unit
      .use()
      .texture('u_backdrop', 0, backdrop.texture)
      .texture('u_unit', 4, unit.texture)
      .ivec2('u_tileOrigin', x0 - fx, y0 - fy)
      .ivec2('u_tileSize', tile.width, tile.height)
      .int('u_mode', blendModeIndex(layer.blendMode))
      .vec2('u_size', frame.width, frame.height)
      .float('u_scale', s)
      .vec2('u_docOffset', ...(frame.docOffset ?? [0, 0]))
      .float('u_opacity', coverage.opacity)
      .texture('u_mask', 1, blank)
      .int('u_maskMode', 0)
      .vec4('u_maskWindow', ...WHOLE)
      .texture('u_folderMask', 2, coverage.folderMask?.texture ?? blank)
      .int('u_hasFolderMask', Boolean(coverage.folderMask))
      .texture('u_clip', 3, coverage.clip?.texture ?? blank)
      .int('u_hasClip', Boolean(coverage.clip))
    gpu.drawQuad()

    compositor.release(content, unit, seeds, ...[shadowTex, innerTex, glowTex, innerGlowTex].map((scaled) => (scaled?.owned ? scaled.target : null)))

    return true
  }

  dispose(): void {
    this.compositor.gpu.deleteTarget(this.noSeeds)
  }
}
