import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc.ts'
import type { ShellAutomationDraft } from '../../shared/ipc.ts'
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

  ipcMain.handle(IPC.agentsList, () => manager.list())
  ipcMain.handle(IPC.agentsStart, (_event, id: string) => manager.start(String(id)).then(() => manager.list()))
  ipcMain.handle(IPC.agentsStop, (_event, id: string) => manager.stop(String(id)).then(() => manager.list()))
  ipcMain.handle(IPC.agentsRestart, (_event, id: string) => manager.restart(String(id)).then(() => manager.list()))
  ipcMain.handle(IPC.agentsPair, (_event, id: string) => manager.pair(String(id)))
  ipcMain.handle(IPC.agentsRun, (_event, id: string, goal: string) => manager.run(String(id), String(goal)))

  ipcMain.handle(IPC.shellAutomationsList, () => automations.list())
  ipcMain.handle(IPC.shellAutomationsCreate, (_event, draft: ShellAutomationDraft) => automations.create(draft).id)
  ipcMain.handle(IPC.shellAutomationsUpdate, (_event, id: string, patch: Record<string, unknown>) => automations.update(String(id), patch))
  ipcMain.handle(IPC.shellAutomationsRemove, (_event, id: string) => automations.remove(String(id)))
  ipcMain.handle(IPC.shellAutomationsRun, (_event, id: string) => automations.run(String(id)))
}
