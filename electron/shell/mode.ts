import type { ShellMode, ShellSurface } from '../../shared/ipc.ts'
import { osEnv } from '../env.ts'

/** `panels` only when the session asks for it (niri); everything else is the single-window desktop. */
export function shellMode(): ShellMode {
  return osEnv('SHELL_MODE') === 'panels' ? 'panels' : 'desktop'
}

/** Window titles double as the identity niri window rules match on; keep them stable. */
export const SURFACE_TITLE: Record<Exclude<ShellSurface, `window:${string}`>, string> = {
  desktop: 'Veritas OS',
  main: 'Veritas OS',
  menubar: 'Veritas OS · Menu Bar',
  dock: 'Veritas OS · Dock',
  command: 'Veritas OS · Command',
  panel: 'Veritas OS · Panel',
  screensaver: 'Veritas OS · Screensaver',
  wallpaper: 'Veritas OS · Wallpaper',
  emoji: 'Veritas OS · Emoji'
}

/** Floating Hermes apps that may open as their own window in panels mode. */
export const FLOATING_APPS: Record<string, { title: string; width: number; height: number }> = {
  terminal: { title: 'Veritas OS · Terminal', width: 900, height: 560 },
  system: { title: 'Veritas OS · System', width: 980, height: 640 },
  'chat-popout': { title: 'Veritas OS · Chat', width: 520, height: 720 },
  studio: { title: 'Veritas OS · Studio', width: 1280, height: 800 },
  'capture-editor': { title: 'Veritas OS · Markup', width: 960, height: 680 },
  camera: { title: 'Veritas OS · Camera', width: 240, height: 240 },
  widget: { title: 'Veritas OS · Widget', width: 360, height: 280 },
  canvas: { title: 'Veritas OS · Canvas', width: 1320, height: 840 }
}

export function surfaceTitle(surface: ShellSurface): string {
  if (surface.startsWith('window:')) {
    return FLOATING_APPS[surface.slice('window:'.length)]?.title ?? 'Veritas OS'
  }

  return SURFACE_TITLE[surface as keyof typeof SURFACE_TITLE]
}

export function parseSurface(value: string | null | undefined): ShellSurface {
  if (!value) {
    return 'desktop'
  }

  if (value.startsWith('window:') || value in SURFACE_TITLE) {
    return value as ShellSurface
  }

  return 'desktop'
}
