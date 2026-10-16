/** Hermes's `model` config for a local server; both speak the OpenAI API on localhost. */
export function localModelConfig(kind: 'ollama' | 'lmstudio', model: string): Record<string, string> {
  // A stale key or API mode from a previous custom endpoint would be sent to the local server.
  return kind === 'ollama'
    ? { provider: 'custom', base_url: 'http://127.0.0.1:11434/v1', default: model, api_key: '', api_mode: '' }
    : { provider: 'lmstudio', base_url: 'http://127.0.0.1:1234/v1', default: model, api_key: '', api_mode: '' }
}

/** The `/model` argument that switches the live conversation to the same model. */
export function localModelSwitch(kind: 'ollama' | 'lmstudio', model: string): string {
  return `${kind === 'ollama' ? 'custom' : 'lmstudio'}:${model}`
}
