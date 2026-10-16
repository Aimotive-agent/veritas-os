import fs from 'node:fs'
import path from 'node:path'
import { ipcMain } from 'electron'
import { IPC } from '../shared/ipc.ts'
import { heraldOsDataDir } from './paths.ts'

/** The notification history outlives a restart, for a week and up to this many entries. */
const KEEP_MS = 7 * 24 * 60 * 60_000
const KEEP_MAX = 200

interface StoredNotification {
  id: string
  ts: number
  [key: string]: unknown
}

function historyFile(): string {
  return path.join(heraldOsDataDir(), 'notifications.json')
}

/** Drop entries older than a week and anything that is not a notification. */
export function keepRecent(items: unknown, now = Date.now()): StoredNotification[] {
  if (!Array.isArray(items)) {
    return []
  }

  return items
    .filter((item): item is StoredNotification => Boolean(item) && typeof item === 'object' && typeof (item as StoredNotification).id === 'string' && typeof (item as StoredNotification).ts === 'number')
    .filter(item => now - item.ts < KEEP_MS)
    .slice(0, KEEP_MAX)
}

export function registerNotificationHistoryIpc(): void {
  ipcMain.handle(IPC.notificationsLoad, () => {
    try {
      return keepRecent(JSON.parse(fs.readFileSync(historyFile(), 'utf8')))
    } catch {
      return []
    }
  })
  ipcMain.handle(IPC.notificationsSave, (_event, items: unknown) => {
    fs.mkdirSync(heraldOsDataDir(), { recursive: true })
    const file = historyFile()
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(keepRecent(items)))
    fs.renameSync(`${file}.tmp`, file)
  })
}
