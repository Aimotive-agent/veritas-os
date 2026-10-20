import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc.ts'
import type { VeritasAgent } from '../veritas/agent.ts'

interface VeritasConfigurePatch {
  telegram?: { botToken?: string; allowedChatIds?: number[]; enabled?: boolean }
  model?: string
}

/** Register the Veritas channels and fan state changes out to every shell window. */
export function registerVeritasIpc(agent: VeritasAgent): void {
  const broadcast = () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC.veritasChanged, agent.status())
      }
    }
  }

  agent.on('changed', broadcast)

  ipcMain.handle(IPC.veritasStatus, () => agent.status())
  ipcMain.handle(IPC.veritasAsk, (_event, text: string) => agent.ask(String(text)))
  ipcMain.handle(IPC.veritasConfigure, (_event, patch: VeritasConfigurePatch) => agent.configure(patch))
}
