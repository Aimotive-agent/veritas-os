// Local speech recognition tuning. Hermes's default local model ("base") mishears short commands
// ("open Herod app", "www.openhello.pdf"); "small.en" with a Veritas OS vocabulary prompt gets them right
// at roughly 0.8 s per utterance on a laptop CPU. See docs/VOICE.md.

export const RECOMMENDED_LOCAL_MODEL = 'small.en'

export const LOCAL_STT_MODELS = [
  { id: 'base', label: 'Fast (base)' },
  { id: 'small.en', label: 'Accurate, English (small.en)' },
  { id: 'small', label: 'Accurate, any language (small)' },
  { id: 'medium.en', label: 'Most accurate, English (medium.en)' },
  { id: 'large-v3-turbo', label: 'Most accurate, any language (large-v3-turbo)' }
] as const

/** Words Whisper should expect: page names, command verbs and file words. */
export const STT_VOCABULARY =
  'Veritas OS voice commands: hey Hermes, open Apps, Missions, Memory, Files, Automations, Connections, Settings, Terminal, System, Overview. ' +
  'Open hello.pdf, open the Downloads folder, type, paste, copy, select all, minimize, maximize, close window.'

export interface LocalSttConfig {
  stt?: { provider?: string; local?: { model?: string; initial_prompt?: string } }
}

/**
 * The config patch that tunes local transcription, or null when there is nothing to do: another
 * provider is configured, or the user already picked a model or wrote their own prompt.
 */
export function sttTuningPatch(config: LocalSttConfig): { stt: { local: Record<string, string> } } | null {
  const provider = config.stt?.provider ?? 'local'

  if (provider !== 'local') {
    return null
  }

  const local = config.stt?.local ?? {}
  const patch: Record<string, string> = {}

  if (!local.model || local.model === 'base') {
    patch.model = RECOMMENDED_LOCAL_MODEL
  }

  if (!local.initial_prompt?.trim()) {
    patch.initial_prompt = STT_VOCABULARY
  }

  return Object.keys(patch).length ? { stt: { local: patch } } : null
}
