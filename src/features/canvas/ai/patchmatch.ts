/*
 * Content-aware fill: a hole in a picture filled from the rest of it, in the manner of Barnes et
 * al. (PatchMatch, 2009) and Wexler et al. (space-time completion, 2007). On a pyramid from coarse
 * to fine, every patch touching the hole gets a nearest neighbour among the patches wholly outside
 * it (random at first, then improved by propagation from its neighbours and a random search), and
 * each hole pixel becomes the weighted vote of the patches covering it; a few rounds of that per
 * level make the fill agree with itself and with its surroundings.
 */

export interface InpaintOptions {
  /** Patches are (2r+1)² pixels. */
  patchRadius?: number
  /** Seeds the random search, so a fill can be repeated. */
  seed?: number
  /** Where copies may come from (non-zero), the hole aside; everywhere else when left out. */
  source?: Uint8Array
  /** Called as the work goes, from 0 to 1. */
  onProgress?: (fraction: number) => void
}

interface Level {
  width: number
  height: number
  /** RGBA, 0 to 255; hole pixels hold the current guess. */
  image: Float32Array
  hole: Uint8Array
  /** 1 where a whole patch around the pixel is outside the hole and in the source. */
  valid: Uint8Array
  validList: Int32Array
  /** Centres of the patches that touch the hole. */
  targets: Int32Array
  isTarget: Uint8Array
  nnf: Int32Array
  cost: Float32Array
  /** How far into the hole each pixel is (0 outside it), in pixels. */
  depth: Float32Array
}

/** Each pixel's distance into a hole, from its edge (a two-pass chamfer, 1 across and √2 diagonally). */
function holeDepth(hole: Uint8Array, width: number, height: number): Float32Array {
  const depth = Float32Array.from(hole, (value) => (value ? 1e9 : 0))
  const diagonal = Math.SQRT2

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x

      if (!depth[i]) continue
      if (x > 0) depth[i] = Math.min(depth[i], depth[i - 1] + 1)
      if (y > 0) depth[i] = Math.min(depth[i], depth[i - width] + 1)
      if (x > 0 && y > 0) depth[i] = Math.min(depth[i], depth[i - width - 1] + diagonal)
      if (x < width - 1 && y > 0) depth[i] = Math.min(depth[i], depth[i - width + 1] + diagonal)
    }
  }

  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x

      if (!depth[i]) continue
      if (x < width - 1) depth[i] = Math.min(depth[i], depth[i + 1] + 1)
      if (y < height - 1) depth[i] = Math.min(depth[i], depth[i + width] + 1)
      if (x < width - 1 && y < height - 1) depth[i] = Math.min(depth[i], depth[i + width + 1] + diagonal)
      if (x > 0 && y < height - 1) depth[i] = Math.min(depth[i], depth[i + width - 1] + diagonal)
    }
  }

  return depth
}

/** A small seeded random number generator (xorshift32). */
function random(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9

  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0

    return state / 4_294_967_296
  }
}

function makeLevel(width: number, height: number, image: Float32Array, hole: Uint8Array, allowed: Uint8Array, radius: number): Level {
  const count = width * height
  // A source patch must be all known and allowed: erode the known area by the patch radius.
  const known = new Uint8Array(count)

  for (let i = 0; i < count; i++) {
    known[i] = !hole[i] && allowed[i] ? 1 : 0
  }

  const across = new Uint8Array(count)

  for (let y = 0; y < height; y++) {
    let run = 0

    for (let x = 0; x < width; x++) {
      run = known[y * width + x] ? run + 1 : 0
      across[y * width + x] = run > 2 * radius ? 1 : 0
    }
  }

  const valid = new Uint8Array(count)

  for (let x = 0; x < width; x++) {
    let run = 0

    for (let y = 0; y < height; y++) {
      // `across` marks the right end of a full row of the patch; its centre is `radius` to the left.
      run = across[y * width + x] ? run + 1 : 0

      if (run > 2 * radius) {
        valid[(y - radius) * width + x - radius] = 1
      }
    }
  }

  const validList: number[] = []
  const isTarget = new Uint8Array(count)
  const targets: number[] = []

  for (let i = 0; i < count; i++) {
    if (valid[i]) {
      validList.push(i)
    }
  }

  // Targets: every pixel within the patch radius of the hole.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!hole[y * width + x]) {
        continue
      }

      for (let dy = -radius; dy <= radius; dy++) {
        const ty = y + dy

        if (ty < 0 || ty >= height) {
          continue
        }

        for (let dx = -radius; dx <= radius; dx++) {
          const tx = x + dx

          if (tx >= 0 && tx < width && !isTarget[ty * width + tx]) {
            isTarget[ty * width + tx] = 1
          }
        }
      }
    }
  }

  for (let i = 0; i < count; i++) {
    if (isTarget[i]) {
      targets.push(i)
    }
  }

  return {
    width,
    height,
    image,
    hole,
    valid,
    validList: Int32Array.from(validList),
    targets: Int32Array.from(targets),
    isTarget,
    nnf: new Int32Array(count).fill(-1),
    cost: new Float32Array(count),
    depth: holeDepth(hole, width, height)
  }
}

/** Half the size: colour averaged over the known children, a hole wherever any child is one, allowed where every child is. */
function halve(width: number, height: number, image: Float32Array, hole: Uint8Array, allowed: Uint8Array): { width: number; height: number; image: Float32Array; hole: Uint8Array; allowed: Uint8Array } {
  const w = Math.ceil(width / 2)
  const h = Math.ceil(height / 2)
  const out = new Float32Array(w * h * 4)
  const outHole = new Uint8Array(w * h)
  const outAllowed = new Uint8Array(w * h)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum0 = 0
      let sum1 = 0
      let sum2 = 0
      let sum3 = 0
      let n = 0
      let anyHole = 0
      let allAllowed = 1

      for (let dy = 0; dy < 2; dy++) {
        const sy = 2 * y + dy

        if (sy >= height) {
          continue
        }

        for (let dx = 0; dx < 2; dx++) {
          const sx = 2 * x + dx

          if (sx >= width) {
            continue
          }

          const i = sy * width + sx

          if (hole[i]) {
            anyHole = 1
            continue
          }

          if (!allowed[i]) {
            allAllowed = 0
          }

          sum0 += image[i * 4]
          sum1 += image[i * 4 + 1]
          sum2 += image[i * 4 + 2]
          sum3 += image[i * 4 + 3]
          n++
        }
      }

      const o = y * w + x
      outHole[o] = anyHole
      outAllowed[o] = allAllowed && n > 0 ? 1 : 0

      if (n) {
        out[o * 4] = sum0 / n
        out[o * 4 + 1] = sum1 / n
        out[o * 4 + 2] = sum2 / n
        out[o * 4 + 3] = sum3 / n
      }
    }
  }

  return { width: w, height: h, image: out, hole: outHole, allowed: outAllowed }
}

/** A first guess for the coarsest hole: peeled in from its edge, each pixel the mean of the known ones around it. */
function peel(level: Level): void {
  const { width, height, image, hole } = level
  const known = Uint8Array.from(hole, (value) => (value ? 0 : 1))
  let left = hole.reduce((sum, value) => sum + value, 0)

  while (left > 0) {
    const fresh: number[] = []

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x

        if (known[i]) {
          continue
        }

        let n = 0
        const sum = [0, 0, 0, 0]

        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx
            const ny = y + dy

            if ((dx || dy) && nx >= 0 && ny >= 0 && nx < width && ny < height && known[ny * width + nx]) {
              const j = (ny * width + nx) * 4
              sum[0] += image[j]
              sum[1] += image[j + 1]
              sum[2] += image[j + 2]
              sum[3] += image[j + 3]
              n++
            }
          }
        }

        if (n) {
          image.set([sum[0] / n, sum[1] / n, sum[2] / n, sum[3] / n], i * 4)
          fresh.push(i)
        }
      }
    }

    // A hole with nothing known around it at all stays as it is.
    if (!fresh.length) {
      break
    }

    for (const i of fresh) {
      known[i] = 1
    }

    left -= fresh.length
  }
}

/** Squared colour distance between the patches at `p` (target) and `q` (source), given up once past `limit`. */
function patchCost(level: Level, p: number, q: number, radius: number, limit: number): number {
  const { width, height, image } = level
  const px = p % width
  const py = (p - px) / width
  const qx = q % width
  const qy = (q - qx) / width
  let sum = 0

  for (let dy = -radius; dy <= radius; dy++) {
    const ty = py + dy

    if (ty < 0 || ty >= height) {
      continue
    }

    const targetRow = ty * width
    const sourceRow = (qy + dy) * width

    for (let dx = -radius; dx <= radius; dx++) {
      const tx = px + dx

      if (tx < 0 || tx >= width) {
        continue
      }

      const t = (targetRow + tx) * 4
      const s = (sourceRow + qx + dx) * 4
      const d0 = image[t] - image[s]
      const d1 = image[t + 1] - image[s + 1]
      const d2 = image[t + 2] - image[s + 2]
      const d3 = image[t + 3] - image[s + 3]
      sum += d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3
    }

    if (sum >= limit) {
      return sum
    }
  }

  return sum
}

/** One PatchMatch sweep over the targets: propagation from the neighbours already visited, then a random search. */
function sweep(level: Level, radius: number, reverse: boolean, searchRadius: number, rand: () => number): void {
  const { width, height, targets, isTarget, valid, nnf, cost, validList } = level
  const step = reverse ? -1 : 1
  const n = targets.length

  for (let k = 0; k < n; k++) {
    const p = targets[reverse ? n - 1 - k : k]
    let best = nnf[p]
    let bestCost = cost[p]
    const px = p % width
    const py = (p - px) / width

    // The neighbour before this one along the row, and the one above (or below, going back).
    const left = px - step

    if (left >= 0 && left < width && isTarget[p - step]) {
      const q = nnf[p - step]
      const qx = (q % width) + step

      if (qx >= 0 && qx < width && valid[q + step]) {
        const c = patchCost(level, p, q + step, radius, bestCost)

        if (c < bestCost) {
          best = q + step
          bestCost = c
        }
      }
    }

    const up = py - step

    if (up >= 0 && up < height && isTarget[p - step * width]) {
      const q = nnf[p - step * width] + step * width

      if (q >= 0 && q < width * height && valid[q]) {
        const c = patchCost(level, p, q, radius, bestCost)

        if (c < bestCost) {
          best = q
          bestCost = c
        }
      }
    }

    // Random search around the best so far, at radii halving down to a pixel.
    let reach = searchRadius

    while (reach >= 1) {
      const bx = best % width
      const by = (best - bx) / width
      const cx = Math.min(width - 1, Math.max(0, bx + Math.round((rand() * 2 - 1) * reach)))
      const cy = Math.min(height - 1, Math.max(0, by + Math.round((rand() * 2 - 1) * reach)))
      const q = cy * width + cx

      if (q !== best && valid[q]) {
        const c = patchCost(level, p, q, radius, bestCost)

        if (c < bestCost) {
          best = q
          bestCost = c
        }
      }

      reach = Math.floor(reach / 2)
    }

    // Now and then a patch from anywhere, so a target never stays stuck in a poor corner.
    if (rand() < 0.05) {
      const q = validList[Math.floor(rand() * validList.length)]
      const c = patchCost(level, p, q, radius, bestCost)

      if (c < bestCost) {
        best = q
        bestCost = c
      }
    }

    nnf[p] = best
    cost[p] = bestCost
  }
}

/** Every target's cost against its neighbour now that the hole's guess has changed. */
function rescore(level: Level, radius: number): void {
  for (const p of level.targets) {
    level.cost[p] = patchCost(level, p, level.nnf[p], radius, Infinity)
  }
}

/** How much less a patch counts for each pixel its centre is deeper into the hole (Wexler et al.'s γ). */
const DEPTH_FALLOFF = 1 / 1.3

/**
 * The vote: each hole pixel becomes the weighted mean of what the patches covering it would put
 * there. A patch's weight falls with its distance, measured against the spread of distances, so
 * good matches lead, and with how deep in the hole it sits, so the known edge leads too; `uniform`
 * weighs every patch the same (for a first guess from a fresh field).
 */
function vote(level: Level, radius: number, uniform: boolean): void {
  const { width, height, image, hole, targets, nnf, cost, depth } = level
  const count = width * height
  const sums = new Float32Array(count * 4)
  const weights = new Float32Array(count)
  const area = (2 * radius + 1) ** 2 * 4
  let spread = 1

  if (!uniform) {
    const means = Float32Array.from(targets, (p) => cost[p] / area).sort()
    spread = Math.max(1, means[Math.floor(means.length * 0.75)] ?? 1)
  }

  for (const p of targets) {
    const q = nnf[p]
    // Only neighbours' weights are compared, so depths past 64 can share one (and never underflow).
    const weight = uniform ? 1 : Math.exp(-cost[p] / area / (2 * spread)) * DEPTH_FALLOFF ** Math.min(64, depth[p])
    const px = p % width
    const py = (p - px) / width
    const qx = q % width
    const qy = (q - qx) / width

    for (let dy = -radius; dy <= radius; dy++) {
      const ty = py + dy

      if (ty < 0 || ty >= height) {
        continue
      }

      for (let dx = -radius; dx <= radius; dx++) {
        const tx = px + dx

        if (tx < 0 || tx >= width) {
          continue
        }

        const t = ty * width + tx

        if (!hole[t]) {
          continue
        }

        const s = ((qy + dy) * width + qx + dx) * 4
        sums[t * 4] += image[s] * weight
        sums[t * 4 + 1] += image[s + 1] * weight
        sums[t * 4 + 2] += image[s + 2] * weight
        sums[t * 4 + 3] += image[s + 3] * weight
        weights[t] += weight
      }
    }
  }

  for (let t = 0; t < count; t++) {
    if (hole[t] && weights[t] > 0) {
      const w = weights[t]
      image[t * 4] = sums[t * 4] / w
      image[t * 4 + 1] = sums[t * 4 + 1] / w
      image[t * 4 + 2] = sums[t * 4 + 2] / w
      image[t * 4 + 3] = sums[t * 4 + 3] / w
    }
  }
}

/** A random valid source for every target. */
function scatter(level: Level, rand: () => number): void {
  for (const p of level.targets) {
    level.nnf[p] = level.validList[Math.floor(rand() * level.validList.length)]
  }
}

/** A coarser level's field carried up a level: each target starts from its parent's match, offset alike. */
function carry(coarse: Level, fine: Level, rand: () => number): void {
  for (const p of fine.targets) {
    const fx = p % fine.width
    const fy = (p - fx) / fine.width
    const parent = Math.min(coarse.height - 1, fy >> 1) * coarse.width + Math.min(coarse.width - 1, fx >> 1)
    const q = coarse.nnf[parent]
    let candidate = -1

    if (q >= 0) {
      const qx = Math.min(fine.width - 1, 2 * (q % coarse.width) + (fx & 1))
      const qy = Math.min(fine.height - 1, 2 * Math.floor(q / coarse.width) + (fy & 1))
      candidate = qy * fine.width + qx
    }

    fine.nnf[p] = candidate >= 0 && fine.valid[candidate] ? candidate : fine.validList[Math.floor(rand() * fine.validList.length)]
  }
}

/**
 * Fill the hole (non-zero in `hole`) of an RGBA picture from the rest of it. Soft hole values
 * blend the fill with what was there; the result is a new array, the picture's own size.
 */
export function inpaint(rgba: ArrayLike<number>, width: number, height: number, hole: Uint8Array, options: InpaintOptions = {}): Uint8ClampedArray {
  const radius = options.patchRadius ?? 3
  const rand = random(options.seed ?? 1)
  const count = width * height
  // Barely covered pixels are kept out of the sources but not redrawn.
  const fill = Uint8Array.from(hole, (value) => (value >= 8 ? 1 : 0))
  const excluded = Uint8Array.from(hole, (value) => (value ? 1 : 0))
  const allowed = new Uint8Array(count)

  for (let i = 0; i < count; i++) {
    allowed[i] = !excluded[i] && (!options.source || options.source[i]) ? 1 : 0
  }

  const out = Uint8ClampedArray.from(rgba)

  if (!fill.some(Boolean)) {
    return out
  }

  // The pyramid, finest first: halved while the hole is wider than a patch and the picture stays six patches across.
  const side = 2 * radius + 1
  let bounds = extentOf(fill, width, height)
  const pyramid: ReturnType<typeof halve>[] = [{ width, height, image: Float32Array.from(rgba), hole: fill, allowed }]

  while (Math.max(bounds.width, bounds.height) > side && Math.min(pyramid.at(-1)!.width, pyramid.at(-1)!.height) > 6 * side) {
    const top = pyramid.at(-1)!
    pyramid.push(halve(top.width, top.height, top.image, top.hole, top.allowed))
    bounds = extentOf(pyramid.at(-1)!.hole, pyramid.at(-1)!.width, pyramid.at(-1)!.height)
  }

  const levels = pyramid.map((entry) => makeLevel(entry.width, entry.height, entry.image, entry.hole, entry.allowed, radius))

  if (levels.some((level) => !level.validList.length)) {
    throw new Error('There is not enough of the picture around the hole to fill it from')
  }

  // Most rounds at the coarsest level, where the fill's structure is settled; the finest only sharpens it.
  const plan = levels.map((level, l) => ({ rounds: l === levels.length - 1 ? 12 : l === 0 ? 2 : 6, sweeps: l === levels.length - 1 ? 3 : 2, level }))
  // Progress counts target visits.
  const total = plan.reduce((sum, entry) => sum + entry.rounds * entry.sweeps * entry.level.targets.length, 0)
  let done = 0

  for (let l = levels.length - 1; l >= 0; l--) {
    const level = levels[l]
    const { rounds, sweeps } = plan[l]

    if (l === levels.length - 1) {
      peel(level)
      scatter(level, rand)
    } else {
      carry(levels[l + 1], level, rand)
      vote(level, radius, true)
    }

    // The coarsest level searches the whole picture; finer ones start from good matches and look nearer.
    const searchRadius = l === levels.length - 1 ? Math.max(level.width, level.height) : Math.max(4, Math.min(Math.max(level.width, level.height), 4 * side))

    for (let round = 0; round < rounds; round++) {
      rescore(level, radius)

      for (let pass = 0; pass < sweeps; pass++) {
        sweep(level, radius, pass % 2 === 1, searchRadius, rand)
        done += level.targets.length
        options.onProgress?.(done / total)
      }

      vote(level, radius, false)
    }
  }

  const finest = levels[0]

  for (let i = 0; i < count; i++) {
    if (!fill[i]) {
      continue
    }

    const strength = hole[i] / 255

    for (let c = 0; c < 4; c++) {
      out[i * 4 + c] = Math.round(rgba[i * 4 + c] * (1 - strength) + finest.image[i * 4 + c] * strength)
    }
  }

  return out
}

/** The box around the non-zero pixels of a mask. */
export function extentOf(mask: Uint8Array, width: number, height: number): { x: number; y: number; width: number; height: number } {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }

  return maxX < 0 ? { x: 0, y: 0, width: 0, height: 0 } : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}
