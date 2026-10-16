// Self-healing speech providers: when the configured STT/TTS provider cannot run (no API key, a
// managed gateway the account is not entitled to, a missing local package), switch the Hermes
// config to the free provider that needs nothing, say so once, and retry. The conversation must
// not fail because `hermes tools` was left pointing at a service the user never set up.
import { rest } from '../rest.ts'

export type SpeechKind = 'stt' | 'tts'

/** Providers that work with no key and no account: faster-whisper (installed with the voice extra) and Edge voices. */
export const FREE_PROVIDER: Record<SpeechKind, string> = { stt: 'local', tts: 'edge' }

const CONFIG_ERROR =
  /api[_ ]?key|not set|not available|not entitled|unreachable|configuration error|no credentials|unauthorized|401|403|is not installed|not installed|ModuleNotFoundError|No module named|quota|insufficient_quota|billing/i

/** True when the failure is about the provider's setup rather than the audio itself. */
export function isProviderConfigError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)

  return CONFIG_ERROR.test(message)
}

const switched = new Set<SpeechKind>()

/** Which provider `kind` is currently configured, or null when the config cannot be read. */
export async function currentProvider(kind: SpeechKind): Promise<string | null> {
  try {
    const config = await rest.get<Record<SpeechKind, { provider?: string } | undefined>>('/api/config')

    return config?.[kind]?.provider ?? null
  } catch {
    return null
  }
}

/**
 * Run `attempt`; if it fails with a provider-setup error and the free provider is not already in
 * use, switch the Hermes config to it and run `attempt` once more. `onSwitched` reports the change.
 */
export async function withProviderFallback<T>(kind: SpeechKind, attempt: () => Promise<T>, onSwitched?: (from: string | null, to: string) => void): Promise<T> {
  try {
    return await attempt()
  } catch (error) {
    if (!isProviderConfigError(error) || switched.has(kind)) {
      throw error
    }

    const from = await currentProvider(kind)
    const to = FREE_PROVIDER[kind]

    if (from === to) {
      throw error
    }

    // Same deep-merge write the Settings page uses; `hermes tools` sees the same value.
    await rest.put('/api/config', { config: { [kind]: { provider: to } } })
    switched.add(kind)
    onSwitched?.(from, to)

    return attempt()
  }
}

/** Test seam. */
export function resetProviderFallback(): void {
  switched.clear()
}
