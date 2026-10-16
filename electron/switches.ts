import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type BrowserWindow, ipcMain, powerMonitor, powerSaveBlocker } from 'electron'
import { type HeraldOSPrefs, type IdleTimings, IPC, type SwitchName, type SwitchState } from '../shared/ipc.ts'
import { log } from './log.ts'
import { run } from './platform/exec.ts'
import { readPrefs, writePrefs } from './prefs.ts'

const STAY_AWAKE_MARKER = path.join(os.homedir(), '.local', 'state', 'herald-os', 'stay-awake')
const IDLE_CONF = path.join(os.homedir(), '.config', 'herald-os', 'idle.conf')
export const IDLE_DEFAULTS: IdleTimings = { lockAfter: 10, screenOffAfter: 15, suspendAfter: 0 }
const SCREENSAVER_DEFAULT_MINUTES = 5
const IDLE_POLL_MS = 10_000

/** idle.conf for linux/bin/herald-os-idle: seconds, 0 for never. */
export function renderIdleConf(prefs: Pick<HeraldOSPrefs, 'idle' | 'screensaver'>): string {
  const idle = { ...IDLE_DEFAULTS, ...prefs.idle }
  const seconds = (minutes: number) => Math.max(0, Math.round(minutes * 60))
  const screensaver = prefs.screensaver?.enabled ? seconds(prefs.screensaver.afterMinutes || SCREENSAVER_DEFAULT_MINUTES) : 0

  return ['# Written by Veritas OS from Settings; seconds of inactivity, 0 for never.', `screensaver=${screensaver}`, `lock=${seconds(idle.lockAfter)}`, `screen_off=${seconds(idle.screenOffAfter)}`, `suspend=${seconds(idle.suspendAfter)}`, ''].join('\n')
}

/**
 * The quick switches. In the Veritas OS Linux session the `herald-os` CLI owns the system side
 * (wlsunset for night light, the swayidle unit for staying awake), so the menu bar, the hotkeys and
 * a terminal all agree; elsewhere staying awake is Electron's power-save blocker, which macOS and
 * the D-Bus idle inhibitor (hypridle on Omarchy) honour. Do not disturb and the screensaver are the
 * shell's own.
 */
export class SwitchService {
  private blocker: number | null = null
  private screensaverUp = false

  constructor(
    private readonly options: {
      /** The Veritas OS Linux session (niri, the herald-os CLI). */
      session: boolean
      getWindows: () => BrowserWindow[]
      /** Preferences changed here (do not disturb, the screensaver): every window follows. */
      onPrefs: (prefs: HeraldOSPrefs) => void
      /** Desktop mode: show the screensaver over the shell. */
      showScreensaver: () => void
    }
  ) {}

  start(): void {
    ipcMain.handle(IPC.switchesGet, () => this.state())
    ipcMain.handle(IPC.switchesSet, (_event, name: SwitchName, enabled: boolean) => this.set(name, Boolean(enabled)))

    if (this.options.session) {
      this.writeIdleConf(readPrefs())
    } else {
      // The session's swayidle runs the screensaver on Veritas OS Linux; elsewhere the shell watches.
      setInterval(() => this.checkIdle(), IDLE_POLL_MS).unref()
    }
  }

  async state(): Promise<SwitchState> {
    const prefs = readPrefs()
    const nightLight = this.options.session ? (await run('systemctl', ['--user', 'is-active', '--quiet', 'herald-os-nightlight'], 5000)).code === 0 : null

    return {
      nightLight,
      doNotDisturb: Boolean(prefs.doNotDisturb),
      stayAwake: this.options.session ? fs.existsSync(STAY_AWAKE_MARKER) : this.blocker !== null,
      screensaver: Boolean(prefs.screensaver?.enabled)
    }
  }

  async set(name: SwitchName, enabled: boolean): Promise<SwitchState> {
    switch (name) {
      case 'nightLight':
        if (!this.options.session) {
          throw new Error('Night light is switched by the system here (Night Shift on macOS).')
        }

        await this.cli(['toggle', 'nightlight', enabled ? 'on' : 'off'])
        break
      case 'stayAwake':
        if (this.options.session) {
          await this.cli(['toggle', 'idle', enabled ? 'on' : 'off'])
        } else if (enabled && this.blocker === null) {
          this.blocker = powerSaveBlocker.start('prevent-display-sleep')
        } else if (!enabled && this.blocker !== null) {
          powerSaveBlocker.stop(this.blocker)
          this.blocker = null
        }

        break
      case 'doNotDisturb':
        this.options.onPrefs(writePrefs({ doNotDisturb: enabled }))
        break
      case 'screensaver': {
        const current = readPrefs().screensaver
        const next = writePrefs({ screensaver: { enabled, afterMinutes: current?.afterMinutes || SCREENSAVER_DEFAULT_MINUTES } })
        this.options.onPrefs(next)
        await this.applyIdle(next)
        break
      }
    }

    return this.broadcast()
  }

  /** Settings changed the idle timings or the screensaver delay. */
  async applyIdle(prefs: HeraldOSPrefs): Promise<void> {
    if (!this.options.session) {
      return
    }

    this.writeIdleConf(prefs)

    // Staying awake means the idle unit is stopped on purpose; it picks the file up when it restarts.
    if (!fs.existsSync(STAY_AWAKE_MARKER)) {
      await run('herald-os-idle', ['restart'], 10_000)
    }
  }

  /** Something outside the shell (the CLI, a hotkey) changed a switch: tell every window. */
  async broadcast(): Promise<SwitchState> {
    const state = await this.state()

    for (const win of this.options.getWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.switchesChanged, state)
      }
    }

    return state
  }

  private writeIdleConf(prefs: HeraldOSPrefs): void {
    try {
      fs.mkdirSync(path.dirname(IDLE_CONF), { recursive: true })
      fs.writeFileSync(IDLE_CONF, renderIdleConf(prefs))
    } catch (error) {
      log('switches', `could not write ${IDLE_CONF}: ${(error as Error).message}`)
    }
  }

  private async cli(args: string[]): Promise<void> {
    const result = await run('herald-os', args, 20_000)

    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `herald-os ${args.join(' ')} failed`)
    }
  }

  private checkIdle(): void {
    const screensaver = readPrefs().screensaver
    const idleSeconds = powerMonitor.getSystemIdleTime()

    if (idleSeconds < 5) {
      this.screensaverUp = false

      return
    }

    if (!screensaver?.enabled || this.blocker !== null || this.screensaverUp) {
      return
    }

    if (idleSeconds >= (screensaver.afterMinutes || SCREENSAVER_DEFAULT_MINUTES) * 60) {
      this.screensaverUp = true
      this.options.showScreensaver()
    }
  }
}
