// Energy-based endpointing: decides when an utterance starts and ends from per-frame RMS levels.
// Pure and clock-free (durations are accumulated from frame lengths) so it is unit-testable and
// deterministic; the capture layer feeds it one frame at a time.

export interface EndpointerOptions {
  /** Silence after speech that closes the utterance. */
  silenceMs: number
  /** Speech shorter than this is ignored as a click or cough. */
  minSpeechMs: number
  /** Give up waiting for speech after this long (0 disables). */
  maxWaitMs: number
  /** Cap on utterance length; the utterance is closed even if the user keeps talking. */
  maxSpeechMs: number
  /** Speech must exceed the noise floor by this factor. */
  ratio: number
  /** Absolute minimum RMS treated as speech, regardless of the floor. */
  minLevel: number
}

export const DEFAULT_ENDPOINTER: EndpointerOptions = {
  silenceMs: 700,
  minSpeechMs: 250,
  maxWaitMs: 12_000,
  maxSpeechMs: 45_000,
  ratio: 2.6,
  minLevel: 0.012
}

/** For interrupting playback: shorter confirmation, higher bar (the speaker is bleeding into the mic). */
export const BARGE_IN_ENDPOINTER: EndpointerOptions = {
  ...DEFAULT_ENDPOINTER,
  minSpeechMs: 350,
  ratio: 4,
  minLevel: 0.03
}

export type EndpointEvent = 'speech-start' | 'speech-end' | 'timeout' | null

export class Endpointer {
  private floor = 0.004
  private speaking = false
  private speechMs = 0
  private silenceMs = 0
  private waitedMs = 0
  private lastLevel = 0

  constructor(private readonly options: EndpointerOptions = DEFAULT_ENDPOINTER) {}

  get isSpeaking(): boolean {
    return this.speaking
  }

  get level(): number {
    return this.lastLevel
  }

  get noiseFloor(): number {
    return this.floor
  }

  reset(): void {
    this.speaking = false
    this.speechMs = 0
    this.silenceMs = 0
    this.waitedMs = 0
  }

  /** Enter the speaking state directly (another detector already confirmed speech, e.g. barge-in). */
  markSpeaking(): void {
    this.speaking = true
    this.speechMs = this.options.minSpeechMs
    this.silenceMs = 0
    this.waitedMs = 0
  }

  /** Feed one frame's RMS and its duration; returns a transition when one happens. */
  feed(level: number, frameMs: number): EndpointEvent {
    this.lastLevel = level
    const threshold = Math.max(this.options.minLevel, this.floor * this.options.ratio)
    const loud = level > threshold

    if (!this.speaking) {
      // Track the noise floor only while nobody talks, slowly so speech cannot drag it up.
      if (!loud) {
        this.floor = this.floor * 0.95 + level * 0.05
      }

      if (loud) {
        this.speechMs += frameMs

        if (this.speechMs >= this.options.minSpeechMs) {
          this.speaking = true
          this.silenceMs = 0

          return 'speech-start'
        }
      } else {
        this.speechMs = 0
        this.waitedMs += frameMs

        if (this.options.maxWaitMs > 0 && this.waitedMs >= this.options.maxWaitMs) {
          this.waitedMs = 0

          return 'timeout'
        }
      }

      return null
    }

    this.speechMs += frameMs

    if (loud) {
      this.silenceMs = 0
    } else {
      this.silenceMs += frameMs
    }

    if (this.silenceMs >= this.options.silenceMs || this.speechMs >= this.options.maxSpeechMs) {
      this.speaking = false
      this.speechMs = 0
      this.silenceMs = 0
      this.waitedMs = 0

      return 'speech-end'
    }

    return null
  }
}
