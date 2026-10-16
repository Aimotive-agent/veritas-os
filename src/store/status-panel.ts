import { atom, map } from 'nanostores'
import type { ControlAction, StatusPanelId, StatusPanelState } from '../../shared/ipc.ts'
import { isPanels, openSurface } from './shell.ts'

/** Desktop mode: which quick panel hangs under the menu bar (panels mode opens a panel window instead). */
export const $statusPanel = atom<StatusPanelId | null>(null)
/** The last state each panel loaded. */
export const $panelStates = map<Partial<Record<StatusPanelId, StatusPanelState>>>({})

export const PANEL_TITLES: Record<StatusPanelId, string> = { wifi: 'Wi-Fi', bluetooth: 'Bluetooth', audio: 'Sound', display: 'Displays', power: 'Battery and power', clock: 'Calendar' }

export function openStatusPanel(panel: StatusPanelId): void {
  if (isPanels) {
    openSurface('panel', { type: 'panel', args: [panel] })

    return
  }

  $statusPanel.set($statusPanel.get() === panel ? null : panel)
}

export async function loadPanel(panel: Exclude<StatusPanelId, 'clock'>): Promise<StatusPanelState> {
  const state = await window.heraldOS.controls.status(panel)
  $panelStates.setKey(panel, state)

  return state
}

export async function panelAction(action: ControlAction): Promise<StatusPanelState> {
  const state = await window.heraldOS.controls.act(action)
  $panelStates.setKey(action.panel, state)

  return state
}
