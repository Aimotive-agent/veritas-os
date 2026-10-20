import { atom } from 'nanostores'
import type { AgentSnapshot } from '../../shared/ipc.ts'

/** Live snapshot of the extra agents (OpenCode and any registered in ~/.config/veritas-os/agents.json). */
export const $agentPages = atom<AgentSnapshot[]>([])

let bound = false

/** Start mirroring the agent list once; safe to call from several components. */
export function bindAgentPages(): void {
  if (bound) {
    return
  }

  bound = true
  void window.heraldOS.agents.list().then(agents => $agentPages.set(agents))
  window.heraldOS.agents.onChanged(agents => $agentPages.set(agents))
}

/** Re-read the agent list from main; the onChanged subscription keeps it fresh the rest of the time. */
export async function refreshAgentPages(): Promise<void> {
  $agentPages.set(await window.heraldOS.agents.list())
}

/** A page id for one agent's inline surface, e.g. `agent:opencode`. */
export const agentPageId = (id: string): `agent:${string}` => `agent:${id}`

/** The agent id behind a page id, or null when the page is not an agent page. */
export function agentIdFromPage(page: string): string | null {
  return page.startsWith('agent:') ? page.slice('agent:'.length) : null
}
