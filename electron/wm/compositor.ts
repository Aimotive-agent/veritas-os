import type { WmAction, WmState, WmWindow } from '../../shared/ipc.ts'
import { HyprlandClient } from './hyprland.ts'
import { NiriClient } from './niri.ts'

/**
 * What the shell needs from the compositor it runs in: a mirror of windows and workspaces, the
 * focused window (context for "ask about this window") and actions. niri runs the Veritas OS session;
 * Hyprland is where Veritas runs as an app (Omarchy).
 */
export interface Compositor {
  readonly name: CompositorName
  readonly available: boolean
  start(): void
  stop(): void
  state(): WmState
  onState(listener: (state: WmState) => void): () => void
  focusedWindow(): WmWindow | null
  /** One of this process's windows, by title. */
  ourWindow(title: string): WmWindow | undefined
  action(action: WmAction): Promise<void>
  /** Compositor-specific arguments (`niri msg action …`, `hyprctl dispatch …`). */
  raw(args: string[]): Promise<void>
}

export type CompositorName = 'niri' | 'hyprland'

/** The compositor this session runs under, from the sockets each one advertises. */
export function detectCompositor(env: NodeJS.ProcessEnv = process.env): CompositorName | null {
  if (env.NIRI_SOCKET) {
    return 'niri'
  }

  if (env.HYPRLAND_INSTANCE_SIGNATURE) {
    return 'hyprland'
  }

  return null
}

export function createCompositor(name: CompositorName | null): Compositor | null {
  if (name === 'niri') {
    return new NiriClient()
  }

  if (name === 'hyprland') {
    return new HyprlandClient()
  }

  return null
}
