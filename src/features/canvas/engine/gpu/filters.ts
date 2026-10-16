/*
 * Neighbourhood filters on the GPU, shared by adjustment layers and layer effects: a gaussian blur
 * that stays cheap at any radius (the image halved a few times, blurred a little there, and read
 * back stretched), a motion blur in a few passes whatever its length, and a jump-flooding distance
 * field, where each pixel finds its nearest seed in about log2(reach) passes.
 */

import { blurPlan, gaussianTaps, MAX_TAPS, MOTION_TAPS, motionDirection, motionPasses } from '../adjust-math.ts'
import type { Rect } from '../raster.ts'
import type { Compositor } from './compositor.ts'
import type { Program, Target } from './gl.ts'
import { FULL_VERTEX } from './shaders.ts'

/** A filtered image, maybe smaller than the frame: read it at frame pixel p as texture(t, (p + offset) / size). */
export interface Scaled {
  target: Target
  /** Frame pixels per texel. */
  factor: number
  /** The texture's extent in frame pixels (its own size times the factor). */
  size: [number, number]
  /** Frame pixels the texture reaches past the frame's left and top edges. */
  offset: number
  /** Made for this result (release it when done), rather than the source passed through. */
  owned: boolean
}

/**
 * Halve an image: each texel the average of the 2×2 below it. `u_pad` source pixels of border are
 * added on the left and top (and as many past the right and bottom), the edge pixels repeated, so a
 * reduced blur near the edge sees what a full-size one would.
 */
const DOWNSAMPLE_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_source;
uniform ivec2 u_sourceSize;
uniform int u_pad;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * 2 - u_pad;
  ivec2 last = u_sourceSize - 1;
  o = 0.25 * (texelFetch(u_source, clamp(p, ivec2(0), last), 0) + texelFetch(u_source, clamp(p + ivec2(1, 0), ivec2(0), last), 0)
    + texelFetch(u_source, clamp(p + ivec2(0, 1), ivec2(0), last), 0) + texelFetch(u_source, clamp(p + ivec2(1, 1), ivec2(0), last), 0));
}
`

/** One direction of a gaussian: each tap reads two texels at once through linear filtering. */
const GAUSS_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_source;
uniform vec2 u_texel;
uniform vec2 u_direction;
uniform int u_count;
uniform float u_offsets[${MAX_TAPS}];
uniform float u_weights[${MAX_TAPS}];
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy * u_texel;
  vec4 sum = texture(u_source, uv) * u_weights[0];
  for (int i = 1; i < ${MAX_TAPS}; i++) {
    if (i >= u_count) break;
    vec2 d = u_direction * u_offsets[i] * u_texel;
    sum += (texture(u_source, uv - d) + texture(u_source, uv + d)) * u_weights[i];
  }
  o = sum;
}
`

/** One pass of a motion blur: `u_count` evenly spaced samples along the streak, centred on the pixel. */
const MOTION_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_source;
uniform vec2 u_texel;
uniform vec2 u_step;
uniform int u_count;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy * u_texel;
  float centre = float(u_count - 1) * 0.5;
  vec4 sum = vec4(0.0);
  for (int i = 0; i < ${MOTION_TAPS}; i++) {
    if (i >= u_count) break;
    sum += texture(u_source, uv + u_step * (float(i) - centre) * u_texel);
  }
  o = sum / float(u_count);
}
`

/**
 * Seeds for jump flooding: a pixel at least half covered (or less than half, for `u_inside` false)
 * holds its own position plus one (zero is "none yet") and its coverage.
 */
const SEED_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_source;
uniform bool u_inside;
out uvec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float a = clamp(texelFetch(u_source, p, 0).a, 0.0, 1.0);
  bool seed = u_inside ? a >= 0.5 : a < 0.5;
  o = seed ? uvec4(uvec2(p) + 1u, uint(round(a * 65535.0)), 0u) : uvec4(0u);
}
`

/** One jump-flooding step: the nearest seed among this pixel's and those `u_step` pixels away in eight directions. */
const FLOOD_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform highp usampler2D u_seeds;
uniform int u_step;
uniform ivec2 u_size;
out uvec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  uvec4 best = texelFetch(u_seeds, p, 0);
  float nearest = best.x == 0u ? 1e20 : distance(vec2(best.xy) - 0.5, gl_FragCoord.xy);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      ivec2 q = p + ivec2(i, j) * u_step;
      if ((i == 0 && j == 0) || q.x < 0 || q.y < 0 || q.x >= u_size.x || q.y >= u_size.y) continue;
      uvec4 seed = texelFetch(u_seeds, q, 0);
      if (seed.x == 0u) continue;
      float d = distance(vec2(seed.xy) - 0.5, gl_FragCoord.xy);
      if (d < nearest) {
        nearest = d;
        best = seed;
      }
    }
  }
  o = best;
}
`

/** A rectangle grown by `margin` on every side, rounded out and cut to a size; null for the whole of it. */
export function grownRect(rect: Rect | null, margin: number, width: number, height: number, factor = 1): Rect | null {
  if (!rect) {
    return null
  }

  const x0 = Math.max(0, Math.floor((rect.x - margin) / factor))
  const y0 = Math.max(0, Math.floor((rect.y - margin) / factor))
  const x1 = Math.min(width, Math.ceil((rect.x + rect.width + margin) / factor))
  const y1 = Math.min(height, Math.ceil((rect.y + rect.height + margin) / factor))

  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) }
}

export class Filters {
  private readonly down: Program
  private readonly gauss: Program
  private readonly streak: Program
  private readonly seed: Program
  private readonly flood: Program

  constructor(private readonly compositor: Compositor) {
    const { gpu } = compositor
    this.down = gpu.program(FULL_VERTEX, DOWNSAMPLE_FRAGMENT)
    this.gauss = gpu.program(FULL_VERTEX, GAUSS_FRAGMENT)
    this.streak = gpu.program(FULL_VERTEX, MOTION_FRAGMENT)
    this.seed = gpu.program(FULL_VERTEX, SEED_FRAGMENT)
    this.flood = gpu.program(FULL_VERTEX, FLOOD_FRAGMENT)
  }

  /**
   * A gaussian blur of `sigma` pixels. When the source is clear outside `bounds` (a layer on its
   * own), only that area and the blur's reach are worked on.
   */
  blur(source: Target, sigma: number, format: Target['format'], bounds: Rect | null = null): Scaled {
    const { gpu } = this.compositor
    const plan = blurPlan(sigma)
    const taps = gaussianTaps(plan.sigma)
    const reach = Math.ceil(plan.sigma * 3) + 2
    // A border as wide as the blur reaches, in whole reduced texels so they stay on the pixel grid.
    const pad = plan.factor > 1 ? plan.factor * Math.ceil((Math.ceil(sigma * 3) + plan.factor) / plan.factor) : 0
    const area = bounds && { ...bounds, x: bounds.x + pad, y: bounds.y + pad }
    let level = source
    let factor = 1

    while (factor < plan.factor) {
      const border = level === source ? pad : 0
      const next = this.compositor.temporary(Math.max(1, Math.ceil((level.width + border * 2) / 2)), Math.max(1, Math.ceil((level.height + border * 2) / 2)), format)
      factor *= 2
      gpu.scissor(grownRect(area, factor + reach * factor, next.width, next.height, factor))
      this.down.use().texture('u_source', 0, level.texture).ivec2('u_sourceSize', level.width, level.height).int('u_pad', border)
      gpu.drawQuad()
      this.drop(level, source)
      level = next
    }

    if (taps.offsets.length > 1) {
      const count = Math.min(MAX_TAPS, taps.offsets.length)
      const offsets = new Float32Array(MAX_TAPS)
      const weights = new Float32Array(MAX_TAPS)
      offsets.set(taps.offsets.slice(0, count))
      weights.set(taps.weights.slice(0, count))

      for (const [dx, dy] of [
        [1, 0],
        [0, 1]
      ]) {
        const next = this.compositor.temporary(level.width, level.height, format)
        gpu.scissor(grownRect(area, reach * factor * 2, next.width, next.height, factor))
        gpu.setSampling(level.texture, 'linear')
        this.gauss
          .use()
          .texture('u_source', 0, level.texture)
          .vec2('u_texel', 1 / level.width, 1 / level.height)
          .vec2('u_direction', dx, dy)
          .int('u_count', count)
          .floats('u_offsets', offsets)
          .floats('u_weights', weights)
        gpu.drawQuad()
        this.drop(level, source)
        level = next
      }
    }

    gpu.scissor(null)

    return { target: level, factor, size: [level.width * factor, level.height * factor], offset: factor > 1 ? pad : 0, owned: level !== source }
  }

  /** An even streak `length` pixels long through each pixel, `degrees` counterclockwise from horizontal. */
  motion(source: Target, degrees: number, length: number, format: Target['format']): Scaled {
    const { gpu } = this.compositor
    const [dx, dy] = motionDirection(degrees)
    let level = source

    for (const { taps, spacing } of motionPasses(length)) {
      const next = this.compositor.temporary(source.width, source.height, format)
      gpu.setSampling(level.texture, 'linear')
      this.streak
        .use()
        .texture('u_source', 0, level.texture)
        .vec2('u_texel', 1 / source.width, 1 / source.height)
        .vec2('u_step', dx * spacing, dy * spacing)
        .int('u_count', taps)
      gpu.drawQuad()
      this.drop(level, source)
      level = next
    }

    return { target: level, factor: 1, size: [source.width, source.height], offset: 0, owned: level !== source }
  }

  /**
   * For each pixel within `reach` of the seeds in `region`, the nearest seed: pixels at least half
   * covered in `source` (`inside`), or less than half. Exact enough for strokes: jump flooding with
   * one extra single-pixel pass.
   */
  nearestSeeds(source: Target, inside: boolean, reach: number, region: Rect | null): Target {
    const { gpu } = this.compositor
    const { width, height } = source
    let seeds = this.compositor.temporary(width, height, 'seeds')
    gpu.scissor(region)
    this.seed.use().texture('u_source', 0, source.texture).int('u_inside', inside)
    gpu.drawQuad()
    let step = 2 ** Math.max(0, Math.ceil(Math.log2(Math.max(2, reach + 2))) - 1)
    const steps: number[] = []

    for (; step >= 1; step /= 2) {
      steps.push(step)
    }

    steps.push(1)

    for (const jump of steps) {
      const next = this.compositor.temporary(width, height, 'seeds')
      gpu.scissor(region)
      this.flood.use().texture('u_seeds', 0, seeds.texture).int('u_step', jump).ivec2('u_size', width, height)
      gpu.drawQuad()
      this.compositor.release(seeds)
      seeds = next
    }

    gpu.scissor(null)

    return seeds
  }

  /** Give a work target back, unless it is the caller's own source. */
  private drop(level: Target, source: Target): void {
    if (level !== source) {
      this.compositor.release(level)
    }
  }
}
