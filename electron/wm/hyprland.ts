import { execFile, spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import type { WmAction, WmState, WmWindow, WmWorkspace } from '../../shared/ipc.ts'
import { log } from '../log.ts'
import type { Compositor } from './compositor.ts'

/**
 * Client for Hyprland: windows and workspaces from `hyprctl -j`, refreshed whenever the event socket
 * (`.socket2.sock`) reports a change, and actions through `hyprctl dispatch`. Hyprland names windows
 * by address (`0x55d3…`); the mirror uses the address as a number so ids look like niri's.
 */
export class HyprlandClient implements Compositor {
  readonly name = 'hyprland' as const
  private socket: net.Socket | null = null
  private snapshot: WmState = { available: false, windows: [], workspaces: [], focusedWindowId: null }
  private urgent = new Set<number>()
  private listeners = new Set<(state: WmState) => void>()
  private stopped = false
  private refreshTimer: NodeJS.Timeout | null = null
  /** Whether this Hyprland takes Lua dispatchers; unknown until one works. */
  private lua: boolean | null = null

  get available(): boolean {
    return this.socket !== null
  }

  state(): WmState {
    return { ...this.snapshot, available: this.available }
  }

  onState(listener: (state: WmState) => void): () => void {
    this.listeners.add(listener)

    return () => this.listeners.delete(listener)
  }

  focusedWindow(): WmWindow | null {
    return this.snapshot.windows.find(w => w.id === this.snapshot.focusedWindowId) ?? null
  }

  ourWindow(title: string): WmWindow | undefined {
    return this.snapshot.windows.find(w => w.ours && w.title === title)
  }

  start(): void {
    if (this.socket || this.stopped) {
      return
    }

    const signature = process.env.HYPRLAND_INSTANCE_SIGNATURE

    if (!signature) {
      return
    }

    // Hyprland 0.40+ keeps its sockets under $XDG_RUNTIME_DIR/hypr; older builds used /tmp/hypr.
    const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`
    const candidates = [path.join(runtime, 'hypr', signature, '.socket2.sock'), path.join('/tmp/hypr', signature, '.socket2.sock')]
    this.connect(candidates)
  }

  stop(): void {
    this.stopped = true
    this.socket?.destroy()
    this.socket = null
  }

  async action(action: WmAction): Promise<void> {
    if (action.type === 'screenshot') {
      // Hyprland has no screenshot UI of its own; Veritas's capture does it with grim and slurp.
      spawn('herald-os', ['capture', 'screenshot', action.what === 'select' ? 'region' : action.what], { detached: true, stdio: 'ignore' }).unref()

      return
    }

    if (action.type === 'raw') {
      return this.raw(action.args)
    }

    // A Lua config (Hyprland 0.55+, Omarchy 4) takes only Lua dispatchers; hyprland.conf only the
    // classic ones. Neither form does anything under the other, so trying Lua first is safe.
    if (this.lua !== false) {
      try {
        for (const expression of dispatchLua(action)) {
          await this.raw([expression])
        }

        this.lua = true

        return
      } catch (error) {
        if (this.lua) {
          throw error
        }

        try {
          await this.classic(action)
        } catch {
          throw error
        }

        return
      }
    }

    await this.classic(action)
  }

  private async classic(action: WmAction): Promise<void> {
    for (const args of dispatchArgs(action)) {
      await this.raw(args)
    }

    this.lua = false
  }

  raw(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile('hyprctl', ['dispatch', ...args], { timeout: 5000 }, (error, stdout, stderr) => {
        // hyprctl exits 0 and prints the error for a dispatcher it does not know.
        const reply = `${stdout}`.trim()

        if (error || (reply && reply !== 'ok')) {
          reject(new Error(stderr.trim() || reply || error?.message || 'hyprctl failed'))
        } else {
          resolve()
        }
      })
    })
  }

  private connect(candidates: string[], index = 0): void {
    const target = candidates[index]

    if (!target) {
      log('hyprland', 'event socket not found; retrying in 3s')
      setTimeout(() => !this.stopped && this.connect(candidates), 3000)

      return
    }

    const socket = net.createConnection(target)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.once('connect', () => {
      this.socket = socket
      this.scheduleRefresh(0)
    })
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')

      while (newline >= 0) {
        this.handle(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
    })
    socket.once('error', () => {
      socket.destroy()

      if (this.socket !== socket) {
        this.connect(candidates, index + 1)
      }
    })
    socket.once('close', () => {
      if (this.socket === socket) {
        this.socket = null
        this.emit()

        if (!this.stopped) {
          setTimeout(() => this.connect(candidates), 3000)
        }
      }
    })
  }

  private handle(line: string): void {
    const event = parseEvent(line)

    if (!event) {
      return
    }

    if (event.name === 'urgent') {
      const id = addressToId(event.data)

      if (id !== null) {
        this.urgent.add(id)
      }
    }

    if (REFRESH_EVENTS.has(event.name)) {
      this.scheduleRefresh(40)
    }
  }

  private scheduleRefresh(delay: number): void {
    if (this.refreshTimer) {
      return
    }

    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      void this.refresh()
    }, delay)
  }

  private async refresh(): Promise<void> {
    const [clients, workspaces, monitors, active] = await Promise.all([hyprJson('clients'), hyprJson('workspaces'), hyprJson('monitors'), hyprJson('activewindow')])
    const next = toState(clients, workspaces, monitors, active, process.pid)

    if (next.focusedWindowId !== null) {
      this.urgent.delete(next.focusedWindowId)
    }

    for (const w of next.windows) {
      w.urgent = this.urgent.has(w.id)
    }

    this.snapshot = next
    this.emit()
  }

  private emit(): void {
    const state = this.state()

    for (const listener of this.listeners) {
      listener(state)
    }
  }
}

/** socket2 events that change windows, focus or workspaces. */
const REFRESH_EVENTS = new Set([
  'openwindow',
  'closewindow',
  'movewindow',
  'movewindowv2',
  'activewindow',
  'activewindowv2',
  'windowtitle',
  'windowtitlev2',
  'workspace',
  'workspacev2',
  'createworkspace',
  'createworkspacev2',
  'destroyworkspace',
  'destroyworkspacev2',
  'renameworkspace',
  'focusedmon',
  'focusedmonv2',
  'changefloatingmode',
  'fullscreen',
  'urgent',
  'monitoradded',
  'monitorremoved'
])

function hyprJson(what: string): Promise<unknown> {
  return new Promise(resolve => {
    execFile('hyprctl', ['-j', what], { timeout: 3000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve(null)

        return
      }

      try {
        resolve(JSON.parse(stdout))
      } catch {
        resolve(null)
      }
    })
  })
}

/** `event>>data` from the event socket. */
export function parseEvent(line: string): { name: string; data: string } | null {
  const split = line.indexOf('>>')

  return split > 0 ? { name: line.slice(0, split), data: line.slice(split + 2).trim() } : null
}

/** Hyprland addresses (`0x55d3a1b2c3d0`) fit in a double, so they can stand in for niri's numeric ids. */
export function addressToId(address: string | null | undefined): number | null {
  const match = /^(?:0x)?([0-9a-f]+)$/i.exec((address ?? '').trim())

  return match ? Number.parseInt(match[1] ?? '', 16) : null
}

export function idToAddress(id: number): string {
  return `address:0x${id.toString(16)}`
}

interface HyprClient {
  address?: string
  mapped?: boolean
  hidden?: boolean
  title?: string
  class?: string
  initialClass?: string
  pid?: number
  floating?: boolean
  workspace?: { id?: number; name?: string }
}

interface HyprWorkspace {
  id?: number
  name?: string
  monitor?: string
  lastwindow?: string
}

interface HyprMonitor {
  name?: string
  focused?: boolean
  activeWorkspace?: { id?: number }
}

/** The mirror from `hyprctl -j clients|workspaces|monitors|activewindow` (pure; tested). */
export function toState(clients: unknown, workspaces: unknown, monitors: unknown, active: unknown, ownPid: number): WmState {
  const focusedId = addressToId((active as HyprClient | null)?.address)
  const monitorList = Array.isArray(monitors) ? (monitors as HyprMonitor[]) : []
  const activeIds = new Map(monitorList.map(monitor => [monitor.activeWorkspace?.id, monitor]))
  const windows: WmWindow[] = (Array.isArray(clients) ? (clients as HyprClient[]) : [])
    .filter(client => client.mapped !== false && !client.hidden && client.workspace?.id !== undefined && !isSpecial(client.workspace))
    .map(client => {
      const id = addressToId(client.address) ?? 0

      return {
        id,
        title: client.title ?? '',
        appId: client.class || client.initialClass || '',
        pid: typeof client.pid === 'number' ? client.pid : null,
        workspaceId: client.workspace?.id ?? null,
        focused: id === focusedId,
        floating: Boolean(client.floating),
        urgent: false,
        ours: client.pid === ownPid
      }
    })
    .filter(window => window.id > 0)
    .sort((a, b) => a.id - b.id)
  const spaces: WmWorkspace[] = (Array.isArray(workspaces) ? (workspaces as HyprWorkspace[]) : [])
    .filter(space => typeof space.id === 'number' && !isSpecial(space))
    .map(space => {
      const monitor = activeIds.get(space.id)
      const id = space.id as number

      return {
        id,
        // Named workspaces count down from -1337; they go after the numbered ones, oldest first.
        idx: id > 0 ? id : 1000 - id,
        name: space.name && space.name !== String(space.id) ? space.name : null,
        output: space.monitor ?? null,
        active: Boolean(monitor),
        focused: Boolean(monitor?.focused),
        activeWindowId: addressToId(space.lastwindow)
      }
    })
    .sort((a, b) => a.idx - b.idx)

  return { available: true, windows, workspaces: spaces, focusedWindowId: windows.some(w => w.id === focusedId) ? focusedId : null }
}

/** Scratchpads (`special:…`), which Veritas leaves alone. Named workspaces have negative ids too. */
function isSpecial(space: { id?: number; name?: string }): boolean {
  return (space.name ?? '').startsWith('special:')
}

/** A workspace by number, or by name (Veritas's Spaces are named). */
function workspaceRef(ref: string | number): string {
  return /^\d+$/.test(String(ref)) ? String(ref) : `name:${ref}`
}

/** A Lua string literal (pure). */
export function luaString(text: string): string {
  return `"${text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/[\u0000-\u001f]/g, '')}"`
}

/** The same actions as Lua dispatchers, for Hyprland's Lua config (pure; tested). */
export function dispatchLua(action: WmAction): string[] {
  const window = (id: number) => `window = ${luaString(idToAddress(id))}`
  const workspace = (ref: string | number) => `workspace = ${luaString(workspaceRef(ref))}`

  switch (action.type) {
    case 'focus-window':
      return [`hl.dsp.focus({ ${window(action.id)} })`]
    case 'close-window':
      return [`hl.dsp.window.close({ ${window(action.id)} })`]
    case 'focus-workspace':
      return [`hl.dsp.focus({ ${workspace(action.ref)} })`]
    case 'move-window-to-workspace':
      return [`hl.dsp.window.move({ ${workspace(action.ref)}, ${window(action.id)}, follow = false })`]
    case 'toggle-floating':
      return [`hl.dsp.window.float({ action = "toggle", ${window(action.id)} })`]
    case 'fullscreen':
      return [`hl.dsp.focus({ ${window(action.id)} })`, 'hl.dsp.window.fullscreen({ mode = "fullscreen" })']
    case 'maximize-column':
      return ['hl.dsp.window.fullscreen({ mode = "maximized" })']
    case 'toggle-overview':
      return ['hl.dsp.exec_cmd("herald-os applications")']
    case 'screenshot':
      return []
    case 'raw':
      return [action.args.join(' ')]
  }
}

/** `hyprctl dispatch` argument lists for a shell action (pure; tested). */
export function dispatchArgs(action: WmAction): string[][] {
  switch (action.type) {
    case 'focus-window':
      return [['focuswindow', idToAddress(action.id)]]
    case 'close-window':
      return [['closewindow', idToAddress(action.id)]]
    case 'focus-workspace':
      return [['workspace', workspaceRef(action.ref)]]
    case 'move-window-to-workspace':
      return [['movetoworkspacesilent', `${workspaceRef(action.ref)},${idToAddress(action.id)}`]]
    case 'toggle-floating':
      return [['togglefloating', idToAddress(action.id)]]
    case 'fullscreen':
      return [['focuswindow', idToAddress(action.id)], ['fullscreen', '0']]
    case 'maximize-column':
      return [['fullscreen', '1']]
    case 'toggle-overview':
      // No overview without a plugin; the launcher is the closest thing.
      return [['exec', 'herald-os applications']]
    case 'screenshot':
      return []
    case 'raw':
      return [action.args]
  }
}
