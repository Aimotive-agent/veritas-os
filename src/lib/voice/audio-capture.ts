// One microphone graph for every voice consumer (wake detector feed, utterance recorder, barge-in
// monitor). Consumers subscribe to 16 kHz mono int16 frames; the mic is opened when the first
// subscriber arrives and released when the last one leaves, so the privacy indicator maps 1:1
// onto "the mic is actually open".
import { atom } from 'nanostores'
import { floatToInt16, resampleLinear, rms, TARGET_SAMPLE_RATE } from './pcm.ts'

export interface CaptureFrame {
  /** 16 kHz mono int16 samples. */
  pcm: Int16Array
  /** RMS of the frame, 0..1. */
  level: number
  /** Duration of the frame in milliseconds. */
  ms: number
}

type FrameListener = (frame: CaptureFrame) => void

/** True while the microphone is open (drives the menu-bar indicator). */
export const $micOpen = atom(false)
/** Latest input level, 0..1, for the orb. */
export const $micLevel = atom(0)

export class MicrophoneUnavailableError extends Error {
  constructor(
    readonly reason: 'denied' | 'no-device' | 'unsupported' | 'failed',
    message: string
  ) {
    super(message)
    this.name = 'MicrophoneUnavailableError'
  }
}

let context: AudioContext | null = null
let stream: MediaStream | null = null
let worklet: AudioWorkletNode | null = null
let source: MediaStreamAudioSourceNode | null = null
let opening: Promise<void> | null = null
const listeners = new Set<FrameListener>()

async function open(): Promise<void> {
  if (context && stream) {
    return
  }

  if (opening) {
    return opening
  }

  opening = (async () => {
    const permission = await window.heraldOS.voice.microphoneStatus().catch(() => 'unknown' as const)

    if (permission === 'not-determined') {
      const granted = await window.heraldOS.voice.requestMicrophone().catch(() => 'unknown' as const)

      if (granted === 'denied' || granted === 'restricted') {
        throw new MicrophoneUnavailableError('denied', 'Microphone access was denied. Allow Veritas OS in System Settings > Privacy & Security > Microphone.')
      }
    } else if (permission === 'denied' || permission === 'restricted') {
      throw new MicrophoneUnavailableError('denied', 'Microphone access is denied. Allow Veritas OS in System Settings > Privacy & Security > Microphone.')
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new MicrophoneUnavailableError('unsupported', 'This window cannot capture audio.')
    }

    let media: MediaStream

    try {
      media = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      })
    } catch (error) {
      const name = error instanceof Error ? error.name : ''

      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw new MicrophoneUnavailableError('denied', 'Microphone access was denied.')
      }

      if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        throw new MicrophoneUnavailableError('no-device', 'No microphone was found.')
      }

      throw new MicrophoneUnavailableError('failed', error instanceof Error ? error.message : String(error))
    }

    const ctx = new AudioContext({ latencyHint: 'interactive' })

    try {
      await ctx.audioWorklet.addModule(new URL('voice-capture-worklet.js', document.baseURI).toString())
    } catch (error) {
      media.getTracks().forEach(track => track.stop())
      await ctx.close()
      throw new MicrophoneUnavailableError('failed', `Audio worklet failed to load: ${error instanceof Error ? error.message : String(error)}`)
    }

    const node = new AudioWorkletNode(ctx, 'hermes-capture', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 })
    const src = ctx.createMediaStreamSource(media)
    src.connect(node)
    const inputRate = ctx.sampleRate

    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const floats = event.data
      const resampled = resampleLinear(floats, inputRate, TARGET_SAMPLE_RATE)
      const frame: CaptureFrame = { pcm: floatToInt16(resampled), level: rms(floats), ms: (floats.length / inputRate) * 1000 }
      $micLevel.set(frame.level)

      for (const listener of listeners) {
        listener(frame)
      }
    }

    context = ctx
    stream = media
    worklet = node
    source = src
    $micOpen.set(true)
  })()

  try {
    await opening
  } finally {
    opening = null
  }
}

function close(): void {
  source?.disconnect()
  worklet?.port.close()
  worklet?.disconnect()
  stream?.getTracks().forEach(track => track.stop())
  void context?.close().catch(() => undefined)
  source = null
  worklet = null
  stream = null
  context = null
  $micOpen.set(false)
  $micLevel.set(0)
}

/**
 * Start receiving microphone frames. Resolves once the mic is open; the returned function stops
 * this subscription and closes the mic when nobody else listens.
 */
export async function subscribeMicrophone(listener: FrameListener): Promise<() => void> {
  listeners.add(listener)

  try {
    await open()
  } catch (error) {
    listeners.delete(listener)

    if (listeners.size === 0) {
      close()
    }

    throw error
  }

  let active = true

  return () => {
    if (!active) {
      return
    }

    active = false
    listeners.delete(listener)

    if (listeners.size === 0) {
      close()
    }
  }
}

/** The raw MediaStream for consumers that need a track (WebRTC). Opens the mic if needed. */
export async function microphoneStream(): Promise<MediaStream> {
  await open()

  if (!stream) {
    throw new MicrophoneUnavailableError('failed', 'Microphone stream unavailable.')
  }

  return stream
}

/** Mute at the track level so every consumer (including a WebRTC sender) goes silent. */
export function setMicrophoneMuted(muted: boolean): void {
  stream?.getAudioTracks().forEach(track => {
    track.enabled = !muted
  })
}

export function isMicrophoneOpen(): boolean {
  return $micOpen.get()
}
