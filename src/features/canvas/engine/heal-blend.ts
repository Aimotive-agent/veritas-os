/*
 * The Healing Brush's blend: the copied texture keeps its detail, while its colour and tone are
 * corrected to the destination's by a membrane. Along the edge of what was painted, the difference
 * between the destination and the copy is known; inside, the correction is the smoothest surface
 * that meets those edge values (a solution of Laplace's equation, as in Poisson image editing),
 * solved on halved grids first and settled with a few relaxation sweeps at each finer one.
 */

/** Below this side a grid is solved directly. */
const COARSEST = 16

/**
 * The membrane over a region: `known` holds the values (one plane a channel) where `fixed` is set,
 * `inside` marks the pixels to solve for. Returns the planes with the inside filled.
 */
export function membrane(known: Float32Array[], fixed: Uint8Array, inside: Uint8Array, width: number, height: number): Float32Array[] {
  return known.map((plane) => solve(plane, fixed, inside, width, height))
}

function solve(known: Float32Array, fixed: Uint8Array, inside: Uint8Array, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height)

  if (Math.max(width, height) <= COARSEST) {
    let sum = 0
    let count = 0

    for (let i = 0; i < out.length; i++) {
      if (fixed[i]) {
        sum += known[i]
        count++
      }
    }

    const start = count ? sum / count : 0

    for (let i = 0; i < out.length; i++) {
      out[i] = fixed[i] ? known[i] : start
    }

    relax(out, fixed, inside, width, height, 60)

    return out
  }

  // The same problem on a grid half the size: a cell is fixed when any of its pixels is.
  const w = Math.ceil(width / 2)
  const h = Math.ceil(height / 2)
  const coarseKnown = new Float32Array(w * h)
  const coarseFixed = new Uint8Array(w * h)
  const coarseInside = new Uint8Array(w * h)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const o = (y >> 1) * w + (x >> 1)

      if (fixed[i]) {
        coarseKnown[o] += known[i]
        coarseFixed[o]++
      } else if (inside[i]) {
        coarseInside[o] = 1
      }
    }
  }

  for (let o = 0; o < w * h; o++) {
    if (coarseFixed[o]) {
      coarseKnown[o] /= coarseFixed[o]
      coarseFixed[o] = 1
      coarseInside[o] = 0
    }
  }

  const coarse = solve(coarseKnown, coarseFixed, coarseInside, w, h)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      out[i] = fixed[i] ? known[i] : coarse[(y >> 1) * w + (x >> 1)]
    }
  }

  relax(out, fixed, inside, width, height, 16)

  return out
}

/** Over-relaxed Gauss–Seidel sweeps of Laplace's equation over the inside pixels; fixed pixels hold their values. */
function relax(plane: Float32Array, fixed: Uint8Array, inside: Uint8Array, width: number, height: number, sweeps: number): void {
  const omega = 1.6

  for (let s = 0; s < sweeps; s++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x

        if (!inside[i] || fixed[i]) {
          continue
        }

        let sum = 0
        let count = 0

        // Only the region's own pixels count: what lies beyond its edge plays no part.
        if (x > 0 && (inside[i - 1] || fixed[i - 1])) {
          sum += plane[i - 1]
          count++
        }

        if (x < width - 1 && (inside[i + 1] || fixed[i + 1])) {
          sum += plane[i + 1]
          count++
        }

        if (y > 0 && (inside[i - width] || fixed[i - width])) {
          sum += plane[i - width]
          count++
        }

        if (y < height - 1 && (inside[i + width] || fixed[i + width])) {
          sum += plane[i + width]
          count++
        }

        if (count) {
          plane[i] += omega * (sum / count - plane[i])
        }
      }
    }
  }
}

/**
 * Heal an area: `destination` (straight RGBA, before the stroke), `copy` (the source texture laid
 * there) and `cover` (0 to 1, how much the stroke covered each pixel), all `width`×`height`. The
 * pixels just outside the stroke give the difference to carry in; the result is the copy plus the
 * membrane, mixed over the destination by the cover. Where the copy is clear nothing changes.
 */
export function heal(destination: Uint8ClampedArray, copy: Uint8ClampedArray, cover: Float32Array, width: number, height: number): Uint8ClampedArray {
  const count = width * height
  const inside = Uint8Array.from(cover, (value, i) => (value > 0 && copy[i * 4 + 3] > 0 ? 1 : 0))
  const fixed = new Uint8Array(count)

  // The ring just outside the stroke: where the destination's colour is known to be right.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x

      if (inside[i]) {
        continue
      }

      if ((x > 0 && inside[i - 1]) || (x < width - 1 && inside[i + 1]) || (y > 0 && inside[i - width]) || (y < height - 1 && inside[i + width])) {
        fixed[i] = 1
      }
    }
  }

  const out = destination.slice()
  const known = [0, 1, 2].map((c) => Float32Array.from({ length: count }, (_, i) => (fixed[i] ? destination[i * 4 + c] - copy[i * 4 + c] : 0)))
  // With nothing around to match (the stroke covers the whole area), the copy goes down as it is.
  const correction = fixed.some(Boolean) ? membrane(known, fixed, inside, width, height) : known

  for (let i = 0; i < count; i++) {
    if (!inside[i]) {
      continue
    }

    for (let c = 0; c < 3; c++) {
      const healed = copy[i * 4 + c] + correction[c][i]
      out[i * 4 + c] = destination[i * 4 + c] + (healed - destination[i * 4 + c]) * cover[i]
    }

    out[i * 4 + 3] = destination[i * 4 + 3] + (copy[i * 4 + 3] - destination[i * 4 + 3]) * cover[i]
  }

  return out
}
