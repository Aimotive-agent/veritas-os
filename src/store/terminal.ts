import { atom } from 'nanostores'
import { isPanels } from './shell.ts'
import { openApp } from './windows.ts'

/** A coding agent to start in a new Terminal tab (desktop mode; panels mode sends a command instead). */
export const $terminalRequest = atom<{ program: string; label: string; at: number } | null>(null)

/** Open the Terminal with a new tab running a catalog coding agent (claude, codex, …). */
export function openTerminalProgram(program: string, label: string): void {
  if (isPanels) {
    window.heraldOS.shell.open('window:terminal', { type: 'terminal-program', args: [program, label] }).catch(() => undefined)

    return
  }

  $terminalRequest.set({ program, label, at: Date.now() })
  openApp('terminal')
}
