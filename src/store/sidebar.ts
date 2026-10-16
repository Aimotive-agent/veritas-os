import { atom } from 'nanostores'
import { $prefs, updatePrefs } from './backend.ts'

export interface SidebarState {
  /** Expanded width in px; kept while collapsed so expanding restores it. */
  width: number
  collapsed: boolean
}

export const SIDEBAR_DEFAULT = 132
export const SIDEBAR_MIN = 112
export const SIDEBAR_MAX = 260
/** Width of the icon-only rail. */
export const SIDEBAR_COLLAPSED = 60
/** Dragging narrower than this snaps to the collapsed rail. */
export const SIDEBAR_SNAP = 92

export const $sidebar = atom<SidebarState>({ width: SIDEBAR_DEFAULT, collapsed: false })

let lastPersisted = ''
let persistTimer = 0

function clampWidth(width: number): number {
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)))
}

function schedulePersist(): void {
  window.clearTimeout(persistTimer)
  persistTimer = window.setTimeout(() => {
    const state = $sidebar.get()
    lastPersisted = JSON.stringify(state)
    void updatePrefs({ sidebar: state })
  }, 300)
}

export function setSidebarWidth(width: number): void {
  $sidebar.set({ width: clampWidth(width), collapsed: false })
  schedulePersist()
}

export function setSidebarCollapsed(collapsed: boolean): void {
  const state = $sidebar.get()

  if (state.collapsed === collapsed) {
    return
  }

  $sidebar.set({ ...state, collapsed })
  schedulePersist()
}

export function toggleSidebar(): void {
  setSidebarCollapsed(!$sidebar.get().collapsed)
}

/** Hydrate from persisted prefs (and follow external changes, e.g. Settings resetting layout). */
export function bindSidebarPrefs(): () => void {
  return $prefs.subscribe(prefs => {
    const stored = prefs.sidebar

    if (!stored) {
      return
    }

    const serialized = JSON.stringify(stored)

    if (serialized !== lastPersisted) {
      lastPersisted = serialized
      $sidebar.set({ width: clampWidth(stored.width), collapsed: Boolean(stored.collapsed) })
    }
  })
}
