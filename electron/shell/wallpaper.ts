import { type ChildProcess, execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc.ts'
import { log } from '../log.ts'
import type { PanelShell } from './panels.ts'

/**
 * Panels mode has no window behind everything to paint the wallpaper on, so the shell renders one
 * frame of its procedural wallpaper offscreen, writes a PNG, and hands it to swaybg (a layer-shell
 * client the compositor keeps beneath every window). A custom image wallpaper is passed straight through.
 */
const UNIT = 'herald-os-wallpaper'

export class WallpaperService {
  private swaybg: ChildProcess | null = null
  private current: string | null = null
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly shell: PanelShell) {}

  get file(): string {
    return path.join(os.homedir(), '.local', 'share', 'herald-os', 'wallpaper.png')
  }

  start(customImage: string | undefined): void {
    ipcMain.handle(IPC.shellWallpaperFrame, (_event, dataUrl: string) => this.receiveFrame(dataUrl))
    this.apply(customImage)
  }

  /** Called at start and whenever the wallpaper preference changes. */
  apply(customImage: string | undefined): void {
    const custom = customImage?.replace(/^file:\/\//, '')

    if (custom && fs.existsSync(custom)) {
      this.show(custom)

      return
    }

    if (fs.existsSync(this.file)) {
      // Show the last render immediately; a fresh frame replaces it shortly after.
      this.show(this.file)
    }

    this.shell.open('wallpaper')
  }

  stop(): void {
    this.swaybg?.kill()
    this.swaybg = null
    execFile('systemctl', ['--user', 'stop', UNIT], () => undefined)
  }

  private receiveFrame(dataUrl: string): void {
    const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl)

    if (!match) {
      return
    }

    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, Buffer.from(match[1], 'base64'))
    log('wallpaper', `rendered ${this.file}`)
    this.shell.close('wallpaper')
    this.show(this.file, true)
  }

  private show(file: string, force = false): void {
    if (this.current === file && !force) {
      return
    }

    this.current = file
    this.queue = this.queue.then(() => this.run(file))
  }

  /**
   * swaybg runs as a transient user unit rather than as our child: a child inherits Electron's open
   * sockets (the DevTools port among them) and outlives a crashed shell, one more after every restart.
   * Starting the unit first stops whatever the last shell left running.
   */
  private async run(file: string): Promise<void> {
    await succeeds('systemctl', ['--user', 'stop', UNIT])
    const started = await succeeds('systemd-run', ['--user', '--quiet', '--collect', `--unit=${UNIT}`, `--setenv=WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY ?? ''}`, 'swaybg', '-m', 'fill', '-i', file])

    if (!started) {
      this.spawnChild(file)
    }
  }

  /** Without a systemd user instance, swaybg is our child and dies with a clean quit only. */
  private spawnChild(file: string): void {
    this.swaybg?.kill()
    const child = spawn('swaybg', ['-m', 'fill', '-i', file], { stdio: 'ignore' })
    child.on('error', error => log('wallpaper', `swaybg unavailable: ${error.message}`))
    child.on('exit', () => {
      if (this.swaybg === child) {
        this.swaybg = null
      }
    })
    this.swaybg = child
  }
}

function succeeds(command: string, args: string[]): Promise<boolean> {
  return new Promise(resolve => execFile(command, args, error => resolve(!error)))
}
