import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc.ts'
import type { AgentSpec, ShellAutomationDraft } from '../../shared/ipc.ts'
import type { ShellAutomations } from './automations.ts'
import type { AgentManager } from './manager.ts'

/** Register the extra-agent channels and fan state changes out to every shell window. */
export function registerAgentsIpc(manager: AgentManager, automations: ShellAutomations): void {
  const broadcast = () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC.agentsChanged, manager.list())
      }
    }
  }

  manager.on('state', broadcast)

  // Shell-tracked missions (non-Hermes agents) get their own channel.
  const broadcastMissions = () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC.shellMissionsChanged, manager.listMissions())
      }
    }
  }

  manager.on('missions', broadcastMissions)

  ipcMain.handle(IPC.agentsList, () => manager.list())
  ipcMain.handle(IPC.shellMissionsList, () => manager.listMissions())
  ipcMain.handle(IPC.agentsStart, (_event, id: string) => manager.start(String(id)).then(() => manager.list()))
  ipcMain.handle(IPC.agentsStop, (_event, id: string) => manager.stop(String(id)).then(() => manager.list()))
  ipcMain.handle(IPC.agentsRestart, (_event, id: string) => manager.restart(String(id)).then(() => manager.list()))
  ipcMain.handle(IPC.agentsPair, (_event, id: string) => manager.pair(String(id)))
  ipcMain.handle(IPC.agentsRun, (_event, id: string, goal: string) => manager.run(String(id), String(goal)))
  ipcMain.handle(IPC.agentsAdd, (_event, spec: AgentSpec) => manager.add(spec).then(() => manager.list()))
  ipcMain.handle(IPC.agentsRemove, (_event, id: string) => manager.remove(String(id)).then(() => manager.list()))

  ipcMain.handle(IPC.shellAutomationsList, () => automations.list())
  ipcMain.handle(IPC.shellAutomationsCreate, (_event, draft: ShellAutomationDraft) => automations.create(draft).id)
  ipcMain.handle(IPC.shellAutomationsUpdate, (_event, id: string, patch: Record<string, unknown>) => automations.update(String(id), patch))
  ipcMain.handle(IPC.shellAutomationsRemove, (_event, id: string) => automations.remove(String(id)))
  ipcMain.handle(IPC.shellAutomationsRun, (_event, id: string) => automations.run(String(id)))
}
