// Pure PCM helpers shared by capture (mic -> 16 kHz int16 for STT and the wake detector) and
// playback (speak-stream int16 -> Float32 for WebAudio). No DOM access: unit-tested in node.

/** Sample rate every backend audio path expects (wake.feed only accepts 16 kHz). */
export const TARGET_SAMPLE_RATE = 16_000

export function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length)

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    out[i] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff)
  }

  return out
}

export function int16ToFloat(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length)

  for (let i = 0; i < samples.length; i++) {
    out[i] = samples[i] / (samples[i] < 0 ? 0x8000 : 0x7fff)
  }

  return out
}

/** Linear-interpolation resampler; good enough for speech going to STT/wake detectors. */
export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) {
    return input
  }

  const ratio = fromRate / toRate
  const length = Math.max(1, Math.floor(input.length / ratio))
  const out = new Float32Array(length)

  for (let i = 0; i < length; i++) {
    const position = i * ratio
    const index = Math.floor(position)
    const next = Math.min(index + 1, input.length - 1)
    const frac = position - index
    out[i] = input[index] + (input[next] - input[index]) * frac
  }

  return out
}

/** Root mean square of a frame, 0..1 for float input. */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) {
    return 0
  }

  let sum = 0

  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i]
  }

  return Math.sqrt(sum / samples.length)
}

export function int16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
  let binary = ''

  // Chunked so very long frames do not blow the argument limit of String.fromCharCode.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }

  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64')
}

/** Concatenate int16 frames into one buffer. */
export function concatInt16(frames: Int16Array[]): Int16Array {
  const total = frames.reduce((sum, frame) => sum + frame.length, 0)
  const out = new Int16Array(total)
  let offset = 0

  for (const frame of frames) {
    out.set(frame, offset)
    offset += frame.length
  }

  return out
}

/** RIFF/WAVE container around mono 16-bit PCM. */
export function encodeWav(samples: Int16Array, sampleRate = TARGET_SAMPLE_RATE): Uint8Array {
  const dataBytes = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i))
    }
  }

  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, dataBytes, true)

  for (let i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * 2, samples[i], true)
  }

  return new Uint8Array(buffer)
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''

  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }

  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64')
}

/** Cut a long int16 stream into fixed-size frames, carrying the remainder forward. */
export class FrameSlicer {
  private carry = new Int16Array(0)

  constructor(readonly frameLength: number) {}

  push(samples: Int16Array): Int16Array[] {
    const merged = concatInt16([this.carry, samples])
    const frames: Int16Array[] = []
    let offset = 0

    while (merged.length - offset >= this.frameLength) {
      frames.push(merged.slice(offset, offset + this.frameLength))
      offset += this.frameLength
    }

    this.carry = merged.slice(offset)

    return frames
  }

  reset(): void {
    this.carry = new Int16Array(0)
  }
}
