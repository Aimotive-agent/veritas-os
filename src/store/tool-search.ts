import { rest } from '../lib/rest.ts'
import { $backend } from './backend.ts'
import { notify } from './notifications.ts'

/*
 * Hermes's Tool Search (`tools.tool_search.enabled`) keeps plugin and MCP tools behind a lookup to
 * save prompt tokens. It is one setting for every Hermes session, and Veritas OS turns it off at setup
 * so its system tools stay directly callable (ADR-010); Settings and `toolSearch.set` turn it back on.
 */

interface ToolsConfig {
  tools?: { tool_search?: { enabled?: unknown } | boolean | null }
}

/** Whether Hermes runs Tool Search with this config, read the way Hermes reads it (pure; tested). */
export function toolSearchOn(config: ToolsConfig | null | undefined): boolean {
  const raw = config?.tools?.tool_search
  const value = raw !== null && typeof raw === 'object' ? raw.enabled : raw === false ? 'off' : 'auto'

  return !['off', 'false', '0', 'no'].includes(String(value ?? 'auto').trim().toLowerCase())
}

export async function readToolSearch(): Promise<boolean> {
  return toolSearchOn(await rest.get<ToolsConfig>('/api/config'))
}

/** On is Hermes's own default (`auto`); new sessions pick the change up. */
export async function setToolSearch(on: boolean): Promise<void> {
  await rest.put('/api/config', { config: { tools: { tool_search: { enabled: on ? 'auto' : 'off' } } } })
}

/** Say once per backend start that the system tools could not be set up in Hermes. */
export function bindBridgeSetupNotice(): () => void {
  let said = ''

  return $backend.subscribe(state => {
    if (state.phase !== 'ready' || !state.bridgeError || state.bridgeError === said) {
      return
    }

    said = state.bridgeError
    notify({ key: 'bridge-setup', title: 'Hermes cannot use the system tools yet', body: `${state.bridgeError}. Veritas OS tries again at its next start.`, level: 'error' })
  })
}
