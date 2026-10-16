import os from 'node:os'
import { type BrowserWindow, ipcMain, powerMonitor } from 'electron'
import { type ContextReturn, type ContextSnapshot, IPC } from '../../shared/ipc.ts'
import { takeSnapshot } from '../context/snapshot.ts'
import { log } from '../log.ts'
import { readPrefs } from '../prefs.ts'

/** Shorter breaks are not worth a catch-up. */
const MIN_AWAY_MS = 10 * 60_000
/** This long without input counts as away even when the screen never locked. */
const IDLE_AWAY_S = 15 * 60
const IDLE_POLL_MS = 60_000

export function registerContextIpc(getWindows: () => BrowserWindow[], onReturned?: (event: ContextReturn) => void): void {
  let inFlight: Promise<ContextSnapshot> | null = null

  ipcMain.handle(IPC.contextSnapshot, () => {
    const prefs = readPrefs()

    if (!prefs.continuity.enabled) {
      return { takenAt: Date.now(), files: [], projects: [], apps: [] } satisfies ContextSnapshot
    }

    // Several surface windows may ask at once; one scan answers them all.
    inFlight ??= takeSnapshot({
      exclude: prefs.continuity.exclude,
      hidden: prefs.hiddenRecents ?? [],
      projectsRoot: prefs.projectsRoot?.replace(/^~(?=\/|$)/, os.homedir())
    }).finally(() => {
      inFlight = null
    })

    return inFlight
  })

  let awaySince: number | null = null
  let idleAway = false

  const leave = (at = Date.now()) => {
    awaySince ??= at
  }

  const back = (reason: ContextReturn['reason']) => {
    if (awaySince === null) {
      return
    }

    const awayMs = Date.now() - awaySince
    awaySince = null

    if (awayMs < MIN_AWAY_MS) {
      return
    }

    log('context', `back after ${Math.round(awayMs / 60_000)} min (${reason})`)
    onReturned?.({ reason, awayMs })

    for (const win of getWindows()) {
      win.webContents.send(IPC.contextReturned, { reason, awayMs } satisfies ContextReturn)
    }
  }

  powerMonitor.on('suspend', () => leave())
  powerMonitor.on('lock-screen', () => leave())
  powerMonitor.on('resume', () => back('resume'))
  powerMonitor.on('unlock-screen', () => back('unlock'))

  setInterval(() => {
    const idle = powerMonitor.getSystemIdleTime()

    if (idle >= IDLE_AWAY_S && awaySince === null) {
      leave(Date.now() - idle * 1000)
      idleAway = true
    } else if (idleAway && idle < 60) {
      idleAway = false
      back('idle')
    }
  }, IDLE_POLL_MS).unref()
}
