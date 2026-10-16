import { atom } from 'nanostores'
import type { ShellCommand, ShellMode, ShellSurface, WmAction, WmState, WmWindow } from '../../shared/ipc.ts'

/**
 * Which surface this renderer window is, and how the shell is composed.
 * - `desktop` mode (macOS, cage): one window, `surface === 'desktop'`.
 * - `panels` mode (niri): the menu bar, dock, Hermes window, command overlay and floating apps are
 *   separate windows; stores that act on another window go through `relay`.
 */
export const surface: ShellSurface = window.heraldOS?.shell?.surface ?? 'desktop'
export const shellMode: ShellMode = window.heraldOS?.shell?.mode ?? 'desktop'
export const isPanels = shellMode === 'panels'
export const isMainSurface = surface === 'desktop' || surface === 'main'

/** Compositor state (niri): every managed window and workspace. `available` is false in desktop mode. */
export const $wm = atom<WmState>({ available: false, windows: [], workspaces: [], focusedWindowId: null })

export function wmAction(action: WmAction): Promise<void> {
  return window.heraldOS.wm.action(action).catch(() => undefined)
}

/** The compositor's focused window, if it is not one of ours. */
export function foreignFocusedWindow(): WmWindow | null {
  const state = $wm.get()
  const win = state.windows.find(w => w.id === state.focusedWindowId)

  return win && !win.ours ? win : null
}

type CommandHandler = (command: ShellCommand) => void
const handlers = new Set<CommandHandler>()
/** Commands that arrived before any handler existed (main delivers them on `did-finish-load`, before lazy surfaces mount). */
const queued: ShellCommand[] = []

function dispatch(command: ShellCommand): void {
  if (handlers.size === 0) {
    queued.push(command)

    return
  }

  for (const handler of handlers) {
    handler(command)
  }
}

/** Receive commands addressed to this surface (from the `herald-os` CLI or another surface). */
export function onShellCommand(handler: CommandHandler): () => void {
  handlers.add(handler)

  if (queued.length > 0) {
    const backlog = queued.splice(0, queued.length)

    for (const command of backlog) {
      handler(command)
    }
  }

  return () => handlers.delete(handler)
}

/** Send a command to the Hermes window (no-op relay when this window is the Hermes window). */
export function relayToMain(command: ShellCommand): void {
  if (isMainSurface) {
    dispatch(command)

    return
  }

  window.heraldOS.shell.relay('main', command).catch(() => undefined)
}

export function openSurface(target: ShellSurface, command?: ShellCommand): void {
  window.heraldOS.shell.open(target, command).catch(() => undefined)
}

export function closeThisSurface(): void {
  window.heraldOS.shell.close().catch(() => undefined)
}

let bound = false

/** Wire compositor state and inbound commands once per renderer window. */
export function bindShell(): void {
  if (bound) {
    return
  }

  bound = true

  if (isPanels) {
    window.heraldOS.wm
      .getState()
      .then(state => $wm.set(state))
      .catch(() => undefined)
    window.heraldOS.wm.onState(state => $wm.set(state))
  }

  window.heraldOS.shell.onCommand(dispatch)
}
