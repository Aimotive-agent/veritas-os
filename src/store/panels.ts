import { useStore } from '@nanostores/react'
import { map } from 'nanostores'

const STORAGE_KEY = 'herald-os.panels'

function load(): Record<string, boolean> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as unknown

    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

/** Collapsed state of secondary panels (Overview "Today" column, artifact panes, …), keyed by panel id. */
export const $panels = map<Record<string, boolean>>(load())

$panels.listen(value => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Storage may be unavailable; the state still works for this session.
  }
})

export function setPanelCollapsed(id: string, collapsed: boolean): void {
  $panels.setKey(id, collapsed)
}

export function togglePanel(id: string): void {
  $panels.setKey(id, !$panels.get()[id])
}

export function usePanelCollapsed(id: string, fallback = false): boolean {
  const panels = useStore($panels)

  return panels[id] ?? fallback
}
