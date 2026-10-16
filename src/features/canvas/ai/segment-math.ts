/*
 * The image maths around Veritas Canvas's segmentation models, kept free of the window so a worker
 * runs it and tests check it: pixels into a model's input, its low-resolution answer back up to
 * the layer's size with edges that follow the picture, and the threshold and feather the person
 * picks.
 */

/** Source indices and weights for each output position of a 1D resample (area when shrinking, linear when growing). */
function taps(from: number, to: number): { start: Int32Array; count: Int32Array; index: Int32Array; weight: Float32Array } {
  const scale = from / to
  const start = new Int32Array(to)
  const count = new Int32Array(to)
  const indices: number[] = []
  const weights: number[] = []

  for (let o = 0; o < to; o++) {
    start[o] = indices.length

    if (scale > 1) {
      const s0 = o * scale
      const s1 = s0 + scale

      for (let s = Math.floor(s0); s < Math.min(from, Math.ceil(s1)); s++) {
        indices.push(s)
        weights.push((Math.min(s + 1, s1) - Math.max(s, s0)) / scale)
      }
    } else {
      const position = Math.max(0, Math.min(from - 1, (o + 0.5) * scale - 0.5))
      const s0 = Math.floor(position)
      const s1 = Math.min(from - 1, s0 + 1)
      const t = position - s0
      indices.push(s0, s1)
      weights.push(1 - t, t)
    }

    count[o] = indices.length - start[o]
  }

  return { start, count, index: Int32Array.from(indices), weight: Float32Array.from(weights) }
}

/** A planar float image (`channels` planes of width×height) resampled to a new size. */
export function resamplePlanes(source: Float32Array, width: number, height: number, channels: number, outWidth: number, outHeight: number): Float32Array {
  if (width === outWidth && height === outHeight) {
    return source.slice()
  }

  const across = taps(width, outWidth)
  const down = taps(height, outHeight)
  const middle = new Float32Array(outWidth * height * channels)
  const out = new Float32Array(outWidth * outHeight * channels)

  for (let c = 0; c < channels; c++) {
    const plane = c * width * height
    const mid = c * outWidth * height

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < outWidth; x++) {
        let sum = 0

        for (let k = across.start[x], end = k + across.count[x]; k < end; k++) {
          sum += source[plane + y * width + across.index[k]] * across.weight[k]
        }

        middle[mid + y * outWidth + x] = sum
      }
    }

    const target = c * outWidth * outHeight

    for (let y = 0; y < outHeight; y++) {
      for (let k = down.start[y], end = k + down.count[y]; k < end; k++) {
        const row = mid + down.index[k] * outWidth
        const w = down.weight[k]
        const at = target + y * outWidth

        for (let x = 0; x < outWidth; x++) {
          out[at + x] += middle[row + x] * w
        }
      }
    }
  }

  return out
}

/** Straight-alpha RGBA as three planes of 0 to 1, laid over white where it is see-through (models expect opaque pictures). */
export function rgbPlanes(rgba: ArrayLike<number>, width: number, height: number): Float32Array {
  const count = width * height
  const out = new Float32Array(count * 3)

  for (let i = 0; i < count; i++) {
    const alpha = rgba[i * 4 + 3] / 255
    const white = 1 - alpha

    for (let c = 0; c < 3; c++) {
      out[c * count + i] = (rgba[i * 4 + c] / 255) * alpha + white
    }
  }

  return out
}

/** A model's input: RGB planes resized to its size, each channel as (value − mean) ÷ std. */
export function modelInput(rgba: ArrayLike<number>, width: number, height: number, outWidth: number, outHeight: number, mean: readonly number[] = [0, 0, 0], std: readonly number[] = [1, 1, 1]): Float32Array {
  const planes = resamplePlanes(rgbPlanes(rgba, width, height), width, height, 3, outWidth, outHeight)
  const count = outWidth * outHeight

  for (let c = 0; c < 3; c++) {
    for (let i = c * count, end = i + count; i < end; i++) {
      planes[i] = (planes[i] - mean[c]) / std[c]
    }
  }

  return planes
}

/** Luminance (0 to 1) of RGB planes, the guide edge refinement follows. */
export function luminance(planes: Float32Array, count: number): Float32Array {
  const out = new Float32Array(count)

  for (let i = 0; i < count; i++) {
    out[i] = 0.299 * planes[i] + 0.587 * planes[count + i] + 0.114 * planes[2 * count + i]
  }

  return out
}

/** The mean over a (2r+1)² window at every pixel (the window cut by the edges), from running sums. */
export function boxMean(source: Float32Array, width: number, height: number, radius: number): Float32Array {
  const across = new Float32Array(source.length)
  const out = new Float32Array(source.length)

  for (let y = 0; y < height; y++) {
    const row = y * width
    let sum = 0

    for (let x = 0; x < Math.min(radius, width); x++) {
      sum += source[row + x]
    }

    for (let x = 0; x < width; x++) {
      if (x + radius < width) sum += source[row + x + radius]
      if (x - radius - 1 >= 0) sum -= source[row + x - radius - 1]
      across[row + x] = sum / (Math.min(width - 1, x + radius) - Math.max(0, x - radius) + 1)
    }
  }

  for (let x = 0; x < width; x++) {
    let sum = 0

    for (let y = 0; y < Math.min(radius, height); y++) {
      sum += across[y * width + x]
    }

    for (let y = 0; y < height; y++) {
      if (y + radius < height) sum += across[(y + radius) * width + x]
      if (y - radius - 1 >= 0) sum -= across[(y - radius - 1) * width + x]
      out[y * width + x] = sum / (Math.min(height - 1, y + radius) - Math.max(0, y - radius) + 1)
    }
  }

  return out
}

/**
 * The guided filter (He, Sun and Tang): `input` smoothed while keeping the edges of `guide`, so a
 * coarse mask snaps to the picture's own outlines. Returns the per-pixel linear coefficients, so a
 * caller working at low resolution can carry them up to a larger guide.
 */
export function guidedCoefficients(guide: Float32Array, input: Float32Array, width: number, height: number, radius: number, eps: number): { a: Float32Array; b: Float32Array } {
  const count = width * height
  const product = new Float32Array(count)
  const square = new Float32Array(count)

  for (let i = 0; i < count; i++) {
    product[i] = guide[i] * input[i]
    square[i] = guide[i] * guide[i]
  }

  const meanI = boxMean(guide, width, height, radius)
  const meanP = boxMean(input, width, height, radius)
  const meanIP = boxMean(product, width, height, radius)
  const meanII = boxMean(square, width, height, radius)
  const a = new Float32Array(count)
  const b = new Float32Array(count)

  for (let i = 0; i < count; i++) {
    const variance = meanII[i] - meanI[i] * meanI[i]
    const covariance = meanIP[i] - meanI[i] * meanP[i]
    a[i] = covariance / (variance + eps)
    b[i] = meanP[i] - a[i] * meanI[i]
  }

  return { a: boxMean(a, width, height, radius), b: boxMean(b, width, height, radius) }
}

export function guidedFilter(guide: Float32Array, input: Float32Array, width: number, height: number, radius: number, eps: number): Float32Array {
  const { a, b } = guidedCoefficients(guide, input, width, height, radius, eps)
  const out = new Float32Array(width * height)

  for (let i = 0; i < out.length; i++) {
    out[i] = a[i] * guide[i] + b[i]
  }

  return out
}

export interface MaskOptions {
  /** 0 to 1: the probability where the edge sits; 0.5 keeps the model's own edge. */
  threshold: number
  /** A soft edge, in output pixels. */
  feather: number
  /** Snap the edge to the picture (the guided filter). */
  refine: boolean
}

export const DEFAULT_MASK: MaskOptions = { threshold: 0.5, feather: 0, refine: true }

/** Settings over the defaults: one given as undefined (a command left it out) keeps its default rather than blanking the mask. */
export function maskOptions(options: Partial<MaskOptions> = {}): MaskOptions {
  return { threshold: options.threshold ?? DEFAULT_MASK.threshold, feather: options.feather ?? DEFAULT_MASK.feather, refine: options.refine ?? DEFAULT_MASK.refine }
}

/** Move a probability's half-way point to `threshold`, keeping the soft ramp around it (identity at 0.5). */
export function remap(probability: number, threshold: number): number {
  const t = Math.min(0.99, Math.max(0.01, threshold))
  const k = Math.min(t, 1 - t)

  return Math.min(1, Math.max(0, (probability - t) / (2 * k) + 0.5))
}

/** A three-pass box blur approximating a gaussian `radius` pixels wide, over 0 to 255 values. */
export function featherValues(values: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) {
    return values
  }

  let plane: Float32Array = Float32Array.from(values)

  for (let pass = 0; pass < 3; pass++) {
    plane = boxMean(plane, width, height, Math.max(1, Math.round(radius / 2)))
  }

  return Uint8Array.from(plane, (value) => Math.round(value))
}

/**
 * A model's low-resolution probability map (0 to 1, `sourceWidth`×`sourceHeight`, stretched over
 * the picture) as a mask the size of `rgba`: carried up with the guided filter's coefficients when
 * refining (worked out at most about 2 megapixels, then applied at full size), then moved to the
 * threshold and feathered.
 */
export function maskFromProbability(probability: Float32Array, sourceWidth: number, sourceHeight: number, rgba: ArrayLike<number>, width: number, height: number, options: MaskOptions): Uint8Array {
  const count = width * height
  let values: Float32Array

  if (options.refine) {
    const shrink = Math.min(1, Math.sqrt(2_000_000 / count))
    const lowWidth = Math.max(1, Math.round(width * shrink))
    const lowHeight = Math.max(1, Math.round(height * shrink))
    const planes = rgbPlanes(rgba, width, height)
    const guide = luminance(planes, count)
    const lowGuide = resamplePlanes(guide, width, height, 1, lowWidth, lowHeight)
    const lowInput = resamplePlanes(probability, sourceWidth, sourceHeight, 1, lowWidth, lowHeight)
    // The window spans about two of the model's own pixels, so its blocky edge is what gets redrawn.
    const radius = Math.max(2, Math.round((2 * Math.max(lowWidth / sourceWidth, lowHeight / sourceHeight)) + 1))
    const { a, b } = guidedCoefficients(lowGuide, lowInput, lowWidth, lowHeight, radius, 1e-3)
    const fullA = resamplePlanes(a, lowWidth, lowHeight, 1, width, height)
    const fullB = resamplePlanes(b, lowWidth, lowHeight, 1, width, height)
    values = new Float32Array(count)

    for (let i = 0; i < count; i++) {
      values[i] = fullA[i] * guide[i] + fullB[i]
    }
  } else {
    values = resamplePlanes(probability, sourceWidth, sourceHeight, 1, width, height)
  }

  const out = new Uint8Array(count)

  for (let i = 0; i < count; i++) {
    out[i] = Math.round(remap(values[i], options.threshold) * 255)
  }

  return featherValues(out, width, height, options.feather)
}

/** Scale a probability map so its lowest value is 0 and its highest 1 (the salient-object models answer in their own range). */
export function normalise(values: Float32Array): Float32Array {
  let min = Infinity
  let max = -Infinity

  for (const value of values) {
    if (value < min) min = value
    if (value > max) max = value
  }

  const span = max - min || 1

  return Float32Array.from(values, (value) => (value - min) / span)
}

/** The size a picture goes into a model at when its long side is at most `side` (never enlarged). */
export function fitSide(width: number, height: number, side: number): { width: number; height: number; scale: number } {
  const scale = Math.min(1, side / Math.max(width, height))

  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale }
}

/**
 * A mask from a segment-anything model's logits (`sourceWidth`×`sourceHeight`) at another size:
 * bilinear, with a one-pixel soft edge where the logit crosses 0.
 */
export function maskFromLogits(logits: Float32Array, sourceWidth: number, sourceHeight: number, width: number, height: number): Uint8Array {
  const values = resamplePlanes(logits, sourceWidth, sourceHeight, 1, width, height)
  // A logit changes by about this much from one output pixel to the next near the edge.
  const step = Math.max(0.05, 8 * Math.max(sourceWidth / width, sourceHeight / height))
  const out = new Uint8Array(width * height)

  for (let i = 0; i < out.length; i++) {
    out[i] = Math.round(Math.min(1, Math.max(0, values[i] / step + 0.5)) * 255)
  }

  return out
}
