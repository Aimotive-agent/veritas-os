import { computed } from 'nanostores'
import type { SpaceDef } from '../../shared/ipc.ts'
import { $prefs, updatePrefs } from './backend.ts'

export const $spaces = computed($prefs, prefs => prefs.spaces)
export const $activeSpace = computed($prefs, prefs => prefs.spaces.find(s => s.id === prefs.activeSpace) ?? prefs.spaces[0])

export function setActiveSpace(id: string): void {
  void updatePrefs({ activeSpace: id })
}

export function addSpace(name: string, color = '#4d92ff'): void {
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `space-${Date.now().toString(36)}`
  const next: SpaceDef = { id, name, color }
  void updatePrefs({ spaces: [...$prefs.get().spaces, next], activeSpace: id })
}

export function removeSpace(id: string): void {
  const spaces = $prefs.get().spaces.filter(s => s.id !== id)

  if (spaces.length === 0) {
    return
  }

  void updatePrefs({ spaces, activeSpace: $prefs.get().activeSpace === id ? spaces[0].id : $prefs.get().activeSpace })
}

/** Sessions created in a space carry this marker in their title so lists can filter without backend changes. */
export function spaceTag(id: string): string {
  return `[${id}]`
}
