import { ipcMain } from 'electron'
import { type ControlAction, IPC, type StatusPanelId, type StatusPanelState } from '../../shared/ipc.ts'
import { hostPlatform } from '../platform/index.ts'

const PANELS = new Set<StatusPanelId>(['wifi', 'bluetooth', 'audio', 'display', 'power'])
const MAC_ADDRESS = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/i

/**
 * The values here end up as command-line arguments (never through a shell); one starting with "-"
 * could still be read as an option by nmcli or pactl, so those are refused outright.
 */
export function controlActionProblem(action: ControlAction): string | null {
  if (!action || !PANELS.has(action.panel)) {
    return 'unknown panel'
  }

  const values: unknown[] = []

  if ('ssid' in action) {
    values.push(action.ssid)
  }

  if ('id' in action && action.id !== undefined) {
    values.push(action.id)
  }

  if ('name' in action) {
    values.push(action.name)
  }

  if ('profile' in action) {
    values.push(action.profile)

    if (!/^[a-z][a-z-]{0,31}$/.test(action.profile)) {
      return 'unknown power profile'
    }
  }

  if ('address' in action && !MAC_ADDRESS.test(action.address)) {
    return 'not a Bluetooth address'
  }

  if (values.some(value => typeof value !== 'string' || !value.trim() || value.startsWith('-'))) {
    return 'invalid name'
  }

  return null
}

export function registerControlsIpc(): void {
  ipcMain.handle(IPC.controlsStatus, (_event, panel: StatusPanelId): Promise<StatusPanelState> => {
    if (!PANELS.has(panel)) {
      throw new Error(`no ${String(panel)} panel`)
    }

    return hostPlatform().controlStatus(panel)
  })
  ipcMain.handle(IPC.controlsAction, async (_event, action: ControlAction): Promise<StatusPanelState> => {
    const problem = controlActionProblem(action)

    if (problem) {
      throw new Error(problem)
    }

    await hostPlatform().controlAction(action)

    return hostPlatform().controlStatus(action.panel)
  })
}
