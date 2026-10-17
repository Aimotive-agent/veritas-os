import { atom } from 'nanostores'
import { isPanels } from './shell.ts'
import { openApp } from './windows.ts'

/** A coding agent to start in a new Terminal tab (desktop mode; panels mode sends a command instead). */
export const $terminalRequest = atom<{ program: string; label: string; at: number } | null>(null)

/** A terminal coding agent the user has opened, pinned in the sidebar beside the connected agents. */
export interface TerminalAgent {
  id: string
  label: string
}

export const $terminalAgents = atom<TerminalAgent[]>([])

/** Remember that a terminal agent was opened (deduped by id) so the sidebar can offer it again. */
export function pinTerminalAgent(id: string, label: string): void {
  const current = $terminalAgents.get()

  if (!current.some(agent => agent.id === id)) {
    $terminalAgents.set([...current, { id, label }])
  }
}

/** Open the Terminal with a new tab running a catalog coding agent (claude, codex, …). */
export function openTerminalProgram(program: string, label: string): void {
  pinTerminalAgent(program, label)

  if (isPanels) {
    window.heraldOS.shell.open('window:terminal', { type: 'terminal-program', args: [program, label] }).catch(() => undefined)

    return
  }

  $terminalRequest.set({ program, label, at: Date.now() })
  openApp('terminal')
}
