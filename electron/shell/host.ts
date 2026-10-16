import { type BrowserWindow, ipcMain } from 'electron'
import { IPC, type ShellCommand, type ShellSurface, type WmAction } from '../../shared/ipc.ts'
import type { Compositor } from '../wm/compositor.ts'

/** What the `herald-os` CLI socket drives: the panels session (niri) or the one Veritas window. */
export interface ShellHost {
  /** The compositor's mirror, when there is one to talk to. */
  readonly wm: Compositor | null
  open(surface: ShellSurface, command?: ShellCommand): void
  relay(target: ShellSurface, command: ShellCommand): void
  focusInCompositor(surface: ShellSurface): Promise<void>
  openWebApp(url: string, name: string, slug: string): void
}

/**
 * The single-window shell on Linux: Veritas as an app inside Hyprland or Omarchy, or the cage kiosk.
 * Every surface is the one window, so overlays and panels become commands its renderer handles.
 */
export class DesktopHost implements ShellHost {
  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    readonly wm: Compositor | null
  ) {}

  start(): void {
    if (!this.wm) {
      return
    }

    this.wm.start()
    this.wm.onState(state => this.getWindow()?.webContents.send(IPC.wmState, state))
    ipcMain.handle(IPC.wmGetState, () => this.wm?.state())
    ipcMain.handle(IPC.wmAction, (_event, action: WmAction) => this.wm?.action(action))
  }

  stop(): void {
    this.wm?.stop()
  }

  open(surface: ShellSurface, command?: ShellCommand): void {
    const win = this.getWindow()

    if (!win) {
      return
    }

    win.show()
    win.focus()

    if (command) {
      win.webContents.send(IPC.shellCommand, command)
    } else if (surface.startsWith('window:')) {
      win.webContents.send(IPC.shellCommand, { type: 'open-app', args: [surface.slice('window:'.length)] } satisfies ShellCommand)
    } else if (surface === 'screensaver') {
      win.webContents.send(IPC.shellCommand, { type: 'screensaver' } satisfies ShellCommand)
    } else if (surface === 'command') {
      win.webContents.send(IPC.shellCommand, { type: 'command' } satisfies ShellCommand)
    }
  }

  relay(_target: ShellSurface, command: ShellCommand): void {
    this.getWindow()?.webContents.send(IPC.shellCommand, command)
  }

  async focusInCompositor(): Promise<void> {
    const win = this.getWindow()
    const ours = this.wm?.state().windows.find(w => w.ours)

    if (ours && this.wm) {
      await this.wm.action({ type: 'focus-window', id: ours.id }).catch(() => undefined)
    }

    win?.show()
    win?.focus()
  }

  openWebApp(url: string, name: string): void {
    this.open('main', { type: 'webapp', args: [url, name] })
  }
}
