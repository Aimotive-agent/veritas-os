import { type BrowserWindow, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc.ts'
import { hostPlatform } from '../platform/index.ts'

const STATS_INTERVAL_MS = 2000

/**
 * System facts. Stats stream to the renderer only while at least one window has subscribed, and
 * the sampler stops when nothing is listening.
 */
export function registerSystemIpc(getWindows: () => BrowserWindow[]): void {
  const platform = hostPlatform()
  let subscribers = 0
  let timer: ReturnType<typeof setInterval> | null = null
  let sampling = false

  const tick = async () => {
    if (sampling) {
      return
    }

    sampling = true

    try {
      const stats = await platform.sampleStats()

      for (const win of getWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC.systemStatsPush, stats)
        }
      }
    } catch {
      // A failed sample is skipped; the next tick tries again.
    } finally {
      sampling = false
    }
  }

  ipcMain.handle(IPC.systemInfo, () => platform.systemInfo())
  ipcMain.handle(IPC.systemNetwork, () => platform.networkStatus())
  ipcMain.handle(IPC.calendarToday, () => platform.calendarToday())
  ipcMain.handle(IPC.systemStats, () => platform.sampleStats())
  ipcMain.handle(IPC.systemProcesses, (_event, sort: 'cpu' | 'memory', limit: number) =>
    platform.listProcesses(sort === 'memory' ? 'memory' : 'cpu', Math.max(1, Math.min(200, Number(limit) || 25)))
  )
  ipcMain.handle(IPC.systemStatsSubscribe, (_event, on: boolean) => {
    subscribers = Math.max(0, subscribers + (on ? 1 : -1))

    if (subscribers > 0 && !timer) {
      void tick()
      timer = setInterval(() => void tick(), STATS_INTERVAL_MS)
    } else if (subscribers === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  })
}
