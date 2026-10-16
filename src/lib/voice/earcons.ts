// Tiny synthesized cues so the user knows where the conversation is without looking: listening
// started, utterance captured, conversation ended, something failed. No audio assets needed.
let context: AudioContext | null = null

function ctx(): AudioContext {
  if (!context || context.state === 'closed') {
    context = new AudioContext()
  }

  if (context.state === 'suspended') {
    void context.resume()
  }

  return context
}

function tone(frequencies: number[], durationMs: number, gainValue = 0.06): void {
  try {
    const audio = ctx()
    const now = audio.currentTime
    const gain = audio.createGain()
    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(gainValue, now + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000)
    gain.connect(audio.destination)

    frequencies.forEach((frequency, index) => {
      const osc = audio.createOscillator()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(frequency, now + index * 0.06)
      osc.connect(gain)
      osc.start(now + index * 0.06)
      osc.stop(now + durationMs / 1000 + 0.05)
    })
  } catch {
    // Audio output unavailable; cues are optional.
  }
}

export const earcons = {
  /** The mic is listening for you. */
  listen: () => tone([660, 880], 180),
  /** Your utterance was captured and is on its way. */
  captured: () => tone([880, 660], 140, 0.045),
  /** Wake word heard. */
  wake: () => tone([523, 784, 1046], 240),
  /** Conversation ended. */
  end: () => tone([440], 160, 0.04),
  /** Something went wrong. */
  error: () => tone([220, 196], 220, 0.05)
}
