import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc.ts'
import { launch, openUrl, status, tabs } from '../browseros.ts'

/** BrowserOS channels: state, start, open a URL, list tabs. */
export function registerBrowserIpc(): void {
  ipcMain.handle(IPC.browserStatus, () => status())
  ipcMain.handle(IPC.browserLaunch, () => launch())
  ipcMain.handle(IPC.browserOpen, (_event, url: string) => openUrl(String(url)))
  ipcMain.handle(IPC.browserTabs, () => tabs())
}
