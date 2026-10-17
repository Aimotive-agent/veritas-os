import { atom } from 'nanostores'
import { showPage } from './windows.ts'

/** A coding agent to start in a new Terminal tab (desktop mode; panels mode sends a command instead). */
export const $terminalRequest = atom<{ program: string; label: string; at: number } | null>(null)

/** A terminal coding agent the user has opened, pinned in the sidebar beside the connected agents. */
export interface TerminalAgent {
  id: string
  label: string
}

/** Terminal coding agents always pinned in the sidebar — first-class, like OpenCode. */
const DEFAULT_TERMINAL_AGENTS: readonly TerminalAgent[] = [
  { id: 'codex', label: 'Codex' }
]

export const $terminalAgents = atom<TerminalAgent[]>([...DEFAULT_TERMINAL_AGENTS])

/**
 * A per-agent counter that increments each time the agent is (re)opened. The embedded terminal page
 * keys its PTY on it, so "open" after a close starts a fresh process.
 */
export const $terminalRuns = atom<Record<string, number>>({})

/** Remember that a terminal agent was opened (deduped by id) so the sidebar can offer it again. */
export function pinTerminalAgent(id: string, label: string): void {
  const current = $terminalAgents.get()

  if (!current.some(agent => agent.id === id)) {
    $terminalAgents.set([...current, { id, label }])
  }
}

/** Forget a closed terminal agent so it leaves the sidebar. */
export function unpinTerminalAgent(id: string): void {
  $terminalAgents.set($terminalAgents.get().filter(agent => agent.id !== id))
}

/** A page id for one terminal agent's embedded surface, e.g. `terminal:copilot-cli`. */
export const terminalPageId = (id: string): `terminal:${string}` => `terminal:${id}`

/** The terminal agent id behind a page id, or null when the page is not a terminal agent page. */
export function terminalIdFromPage(page: string): string | null {
  return page.startsWith('terminal:') ? page.slice('terminal:'.length) : null
}

/** Open a catalog coding agent (claude, codex, …): pin it and show its embedded terminal page. */
export function openTerminalProgram(program: string, label: string): void {
  pinTerminalAgent(program, label)

  const runs = $terminalRuns.get()
  $terminalRuns.set({ ...runs, [program]: (runs[program] ?? 0) + 1 })

  showPage(terminalPageId(program))
}
