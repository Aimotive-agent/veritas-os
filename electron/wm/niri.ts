import { type ChildProcess, execFile, spawn } from 'node:child_process'
import type { WmAction, WmState, WmWindow, WmWorkspace } from '../../shared/ipc.ts'
import { log } from '../log.ts'
import type { Compositor } from './compositor.ts'

/**
 * Client for niri's IPC: keeps a mirror of windows and workspaces from `niri msg -j event-stream`
 * (the stream sends the full state first, then deltas) and issues `niri msg action ...`.
 * Windows belonging to this process (the shell's own) are flagged `ours` by pid.
 */
export class NiriClient implements Compositor {
  readonly name = 'niri' as const
  private stream: ChildProcess | null = null
  private windows = new Map<number, WmWindow>()
  private workspaces = new Map<number, WmWorkspace>()
  private focusedWindowId: number | null = null
  private listeners = new Set<(state: WmState) => void>()
  private stopped = false
  private notifyTimer: NodeJS.Timeout | null = null
  private openedAt = new Map<number, number>()
  private untiled = new Set<number>()
  private outputSizes: Array<[number, number]> = []

  get available(): boolean {
    return this.stream !== null
  }

  state(): WmState {
    return {
      available: this.available,
      windows: [...this.windows.values()].sort((a, b) => a.id - b.id),
      workspaces: [...this.workspaces.values()].sort((a, b) => a.idx - b.idx),
      focusedWindowId: this.focusedWindowId
    }
  }

  onState(listener: (state: WmState) => void): () => void {
    this.listeners.add(listener)

    return () => this.listeners.delete(listener)
  }

  focusedWindow(): WmWindow | null {
    return this.focusedWindowId === null ? null : (this.windows.get(this.focusedWindowId) ?? null)
  }

  /** Our windows by title (titles are the identity niri rules use too). */
  ourWindow(title: string): WmWindow | undefined {
    return [...this.windows.values()].find(w => w.ours && w.title === title)
  }

  start(): void {
    if (this.stream || this.stopped) {
      return
    }

    const child = spawn('niri', ['msg', '-j', 'event-stream'], { stdio: ['ignore', 'pipe', 'pipe'] })
    this.stream = child
    this.refreshOutputs()
    let buffer = ''

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf('\n')

      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)

        if (line) {
          this.handle(line)
        }

        index = buffer.indexOf('\n')
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => log('niri', chunk.trim()))
    child.on('error', error => {
      log('niri', `event stream unavailable: ${error.message}`)
      this.stream = null
      this.emit()
    })
    child.on('exit', code => {
      this.stream = null
      this.emit()

      if (!this.stopped) {
        log('niri', `event stream exited (${code}); retrying in 3s`)
        setTimeout(() => this.start(), 3000)
      }
    })
  }

  stop(): void {
    this.stopped = true
    this.stream?.kill()
    this.stream = null
  }

  async action(action: WmAction): Promise<void> {
    await this.raw(toArgs(action))
  }

  raw(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile('niri', ['msg', 'action', ...args], { timeout: 5000 }, (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message))
        } else {
          resolve()
        }
      })
    })
  }

  private handle(line: string): void {
    let event: Record<string, unknown>

    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }

    const [name, payload] = Object.entries(event)[0] ?? []

    if (!name || typeof payload !== 'object' || payload === null) {
      return
    }

    const p = payload as Record<string, unknown>

    switch (name) {
      case 'WorkspacesChanged': {
        // Outputs may have changed too (hotplug); workspaces are re-sent on such changes.
        this.refreshOutputs()
        this.workspaces.clear()

        for (const ws of (p.workspaces as RawWorkspace[]) ?? []) {
          this.workspaces.set(ws.id, toWorkspace(ws))
        }

        break
      }
      case 'WorkspaceActivated': {
        const id = p.id as number

        for (const ws of this.workspaces.values()) {
          if (ws.id === id) {
            ws.active = true
            ws.focused = Boolean(p.focused)
          } else if (ws.output === this.workspaces.get(id)?.output) {
            ws.active = false
            ws.focused = false
          }
        }

        break
      }
      case 'WorkspaceActiveWindowChanged': {
        const ws = this.workspaces.get(p.workspace_id as number)

        if (ws) {
          ws.activeWindowId = (p.active_window_id as number | null) ?? null
        }

        break
      }
      case 'WorkspaceUrgencyChanged':
        break
      case 'WindowsChanged': {
        this.windows.clear()

        for (const w of (p.windows as RawWindow[]) ?? []) {
          this.windows.set(w.id, toWindow(w))
        }

        this.focusedWindowId = [...this.windows.values()].find(w => w.focused)?.id ?? null
        break
      }
      case 'WindowOpenedOrChanged': {
        const raw = p.window as RawWindow
        const w = toWindow(raw)
        const isNew = !this.windows.has(w.id)
        this.windows.set(w.id, w)

        if (isNew) {
          this.openedAt.set(w.id, Date.now())
        }

        this.untileMaximizedToEdges(raw, w)

        if (w.focused) {
          for (const other of this.windows.values()) {
            other.focused = other.id === w.id
          }

          this.focusedWindowId = w.id
        }

        break
      }
      case 'WindowClosed': {
        const id = p.id as number
        this.windows.delete(id)
        this.openedAt.delete(id)
        this.untiled.delete(id)

        if (this.focusedWindowId === id) {
          this.focusedWindowId = null
        }

        break
      }
      case 'WindowFocusChanged': {
        const id = (p.id as number | null) ?? null
        this.focusedWindowId = id

        for (const w of this.windows.values()) {
          w.focused = w.id === id
        }

        break
      }
      case 'WindowUrgencyChanged': {
        const w = this.windows.get(p.id as number)

        if (w) {
          w.urgent = Boolean(p.urgent)
        }

        break
      }
      default:
        return
    }

    this.emit()
  }

  /**
   * Apps that remember being maximized (Firefox, GTK apps) ask for it right after mapping, which
   * niri honours as "maximize to edges": a borderless window covering the whole output, ignoring
   * struts. Window rules only affect the open state, so undo it here for foreign windows during
   * their first seconds; a user maximizing later is left alone.
   */
  private untileMaximizedToEdges(raw: RawWindow, w: WmWindow): void {
    if (w.ours || w.floating || this.untiled.has(w.id)) {
      return
    }

    const opened = this.openedAt.get(w.id) ?? 0

    if (Date.now() - opened > 5000) {
      return
    }

    const size = raw.layout?.window_size

    if (!size) {
      return
    }

    const coversOutput = this.outputSizes.some(([ow, oh]) => Math.abs(size[0] - ow) <= 2 && Math.abs(size[1] - oh) <= 2)

    if (coversOutput) {
      this.untiled.add(w.id)
      void this.raw(['maximize-window-to-edges', '--id', String(w.id)]).catch(() => undefined)
    }
  }

  private refreshOutputs(): void {
    execFile('niri', ['msg', '-j', 'outputs'], { timeout: 3000 }, (error, stdout) => {
      if (error) {
        return
      }

      try {
        const outputs = JSON.parse(stdout) as Record<string, { logical?: { width: number; height: number } | null }>
        this.outputSizes = Object.values(outputs)
          .map(o => o.logical)
          .filter((l): l is { width: number; height: number } => Boolean(l))
          .map(l => [l.width, l.height])
      } catch {
        // Ignore malformed output.
      }
    })
  }

  private emit(): void {
    // Coalesce bursts (the initial dump arrives as several events).
    if (this.notifyTimer) {
      return
    }

    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null
      const state = this.state()

      for (const listener of this.listeners) {
        listener(state)
      }
    }, 16)
  }
}

interface RawWindow {
  id: number
  title: string | null
  app_id: string | null
  pid: number | null
  workspace_id: number | null
  is_focused: boolean
  is_floating: boolean
  is_urgent: boolean
  layout?: { window_size?: [number, number] | null; tile_size?: [number, number] | null } | null
}

interface RawWorkspace {
  id: number
  idx: number
  name: string | null
  output: string | null
  is_active: boolean
  is_focused: boolean
  active_window_id: number | null
}

function toWindow(w: RawWindow): WmWindow {
  return {
    id: w.id,
    title: w.title ?? '',
    appId: w.app_id ?? '',
    pid: w.pid ?? null,
    workspaceId: w.workspace_id ?? null,
    focused: Boolean(w.is_focused),
    floating: Boolean(w.is_floating),
    urgent: Boolean(w.is_urgent),
    ours: w.pid === process.pid
  }
}

function toWorkspace(ws: RawWorkspace): WmWorkspace {
  return {
    id: ws.id,
    idx: ws.idx,
    name: ws.name ?? null,
    output: ws.output ?? null,
    active: Boolean(ws.is_active),
    focused: Boolean(ws.is_focused),
    activeWindowId: ws.active_window_id ?? null
  }
}

export function toArgs(action: WmAction): string[] {
  switch (action.type) {
    case 'focus-window':
      return ['focus-window', '--id', String(action.id)]
    case 'close-window':
      return ['close-window', '--id', String(action.id)]
    case 'focus-workspace':
      return ['focus-workspace', String(action.ref)]
    case 'move-window-to-workspace':
      return ['move-window-to-workspace', '--window-id', String(action.id), String(action.ref)]
    case 'toggle-floating':
      return ['toggle-window-floating', '--id', String(action.id)]
    case 'fullscreen':
      return ['fullscreen-window', '--id', String(action.id)]
    case 'maximize-column':
      return ['maximize-column']
    case 'toggle-overview':
      return ['toggle-overview']
    case 'screenshot':
      return [action.what === 'screen' ? 'screenshot-screen' : action.what === 'window' ? 'screenshot-window' : 'screenshot']
    case 'raw':
      return action.args
  }
}
