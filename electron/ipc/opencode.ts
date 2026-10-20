import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc.ts'
import { listOpencodeMcpServers } from '../opencode.ts'

/** Register the read-only OpenCode MCP surface (the Connections page shows it beside Hermes). */
export function registerOpencodeIpc(): void {
  ipcMain.handle(IPC.opencodeMcpList, () => listOpencodeMcpServers())
}
