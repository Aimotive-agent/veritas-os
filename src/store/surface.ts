import { atom } from 'nanostores'
import type { HermesAppId } from '../shell/apps.ts'
import { openApp } from './windows.ts'

export const $commandBarOpen = atom(false)
export const $applicationsOpen = atom(false)

/** Desktop mode's "Ask Hermes" panel with files attached (a screen region); panels mode uses the command surface. */
export const $askDraft = atom<{ text: string; attachments: string[] } | null>(null)

export function openAsk(draft: { text?: string; attachments?: string[] }): void {
  $askDraft.set({ text: draft.text ?? '', attachments: draft.attachments ?? [] })
}

/** Compatibility shim for callers that still think in surfaces: routes to the window manager. */
export type SurfaceId = HermesAppId | 'home' | 'chat' | 'tasks' | 'skills' | 'apps' | 'agents'

const LEGACY: Record<string, HermesAppId | 'applications'> = {
  home: 'overview',
  chat: 'hermes',
  tasks: 'automations',
  skills: 'settings',
  agents: 'missions',
  apps: 'applications'
}

export function showSurface(id: SurfaceId): void {
  const target = LEGACY[id] ?? (id as HermesAppId)

  if (target === 'applications') {
    $applicationsOpen.set(true)

    return
  }

  openApp(target)
}

export function toggleCommandBar(open?: boolean): void {
  $commandBarOpen.set(open ?? !$commandBarOpen.get())
}
