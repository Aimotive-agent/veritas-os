// The Studio's view of one Hermes session while it builds: which files it is writing and editing
// (with the changed lines), the commands it runs, its background processes' live output, and the
// site to preview. Pure: `reduceStudioEvent` folds gateway events into a `StudioState`.
import { parseUnifiedDiff } from './unified-diff.ts'

export type StudioFileStatus = 'writing' | 'editing' | 'written' | 'edited' | 'failed' | 'changed'

export interface StudioFile {
  path: string
  status: StudioFileStatus
  /** 1-based lines added or changed by the latest edit. */
  changedLines: number[]
  /** Content Hermes is writing right now (from the tool arguments), before it lands on disk. */
  pending?: string
  updatedAt: number
}

export type StudioCommandStatus = 'running' | 'done' | 'failed' | 'background'

export interface StudioCommand {
  id: string
  command: string
  status: StudioCommandStatus
  output: string
  exitCode: number | null
  processId?: string
  startedAt: number
}

export interface StudioProcess {
  id: string
  command: string
  output: string
  running: boolean
}

export interface StudioState {
  sessionId: string
  home: string
  cwd: string | null
  files: Record<string, StudioFile>
  activeFile: string | null
  commands: StudioCommand[]
  processes: Record<string, StudioProcess>
  previewUrl: string | null
  /** 'explicit' previews (Hermes or the user chose them) are never replaced by a detected URL. */
  previewSource: 'auto' | 'explicit' | null
  /** Bumped whenever something on disk changed, so the tree and preview refresh. */
  revision: number
  status: string
  running: boolean
  /** Hermes is composing a tool call's arguments (a whole file for write_file) before it runs. */
  generating: { tool: string; since: number } | null
}

export interface StudioEvent {
  type: string
  payload?: unknown
}

const MAX_PROCESS_OUTPUT = 200_000
const MAX_COMMAND_OUTPUT = 20_000
const MAX_COMMANDS = 200

export function emptyStudio(sessionId: string, home: string, cwd: string | null = null): StudioState {
  return { sessionId, home, cwd, files: {}, activeFile: null, commands: [], processes: {}, previewUrl: null, previewSource: null, revision: 0, status: '', running: false, generating: null }
}

/** Resolve a tool path (absolute, `~/…`, or relative to the session folder) to an absolute path. */
export function resolvePath(raw: string, cwd: string | null, home: string): string {
  const value = raw.trim()
  const absolute = value.startsWith('/') ? value : value === '~' || value.startsWith('~/') ? home + value.slice(1) : `${cwd ?? home}/${value}`
  const parts: string[] = []

  for (const part of absolute.split('/')) {
    if (part === '' || part === '.') {
      continue
    }

    if (part === '..') {
      parts.pop()
    } else {
      parts.push(part)
    }
  }

  return `/${parts.join('/')}`
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?(?:\/[^\s'"<>)\]]*)?/i

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

/** The first local server address in some terminal output ("Local: http://localhost:5173/"). */
export function detectLocalUrl(text: string): string | null {
  const match = LOCAL_URL.exec(stripAnsi(text))

  if (!match) {
    return null
  }

  return match[0].replace(/\/\/(?:0\.0\.0\.0|\[::1?\])/, '//localhost').replace(/[.,;:]+$/, '')
}

const baseName = (path: string): string => path.split('/').pop() ?? path

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

function parseResult(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return record(JSON.parse(value))
    } catch {
      return { output: value }
    }
  }

  return record(value)
}

/** Files a V4A patch touches (`*** Update File: src/app.ts`). */
function patchPaths(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(match => match[1].trim())
}

function editPaths(name: string, args: Record<string, unknown>): string[] {
  if (typeof args.path === 'string' && args.path) {
    return [args.path]
  }

  if (name === 'patch' && typeof args.patch === 'string') {
    return patchPaths(args.patch)
  }

  return []
}

const FILE_TOOLS = new Set(['write_file', 'patch'])
const TERMINAL_TOOLS = new Set(['terminal'])

function withFile(state: StudioState, path: string, next: Partial<StudioFile>, now: number): StudioState {
  const previous = state.files[path]
  const file: StudioFile = { ...(previous ?? { path, status: 'changed', changedLines: [] }), ...next, path, updatedAt: now }

  return { ...state, files: { ...state.files, [path]: file } }
}

function withPreview(state: StudioState, url: string | null, source: 'auto' | 'explicit'): StudioState {
  if (!url || (source === 'auto' && state.previewSource === 'explicit') || (source === 'auto' && state.previewUrl === url)) {
    return state
  }

  return { ...state, previewUrl: url, previewSource: source }
}

function onToolStart(state: StudioState, payload: Record<string, unknown>, now: number): StudioState {
  const name = String(payload.name ?? '')
  const id = String(payload.tool_id ?? '')
  const args = record(payload.args)

  if (FILE_TOOLS.has(name)) {
    const paths = editPaths(name, args).map(p => resolvePath(p, state.cwd, state.home))
    let next = state

    for (const path of paths) {
      next = withFile(next, path, name === 'write_file' ? { status: 'writing', pending: typeof args.content === 'string' ? args.content : undefined } : { status: 'editing' }, now)
    }

    const first = paths[0]

    return first ? { ...next, activeFile: first, status: `${name === 'write_file' ? 'Writing' : 'Editing'} ${baseName(first)}` } : next
  }

  if (TERMINAL_TOOLS.has(name) && typeof args.command === 'string') {
    const command: StudioCommand = { id, command: args.command, status: 'running', output: '', exitCode: null, startedAt: now }

    return { ...state, commands: [...state.commands, command].slice(-MAX_COMMANDS), status: `Running ${args.command.split('\n')[0].slice(0, 60)}` }
  }

  if (name === 'read_file' && typeof args.path === 'string') {
    return { ...state, status: `Reading ${baseName(args.path)}` }
  }

  return name ? { ...state, status: `Using ${name.replace(/_/g, ' ')}` } : state
}

function onToolComplete(state: StudioState, payload: Record<string, unknown>, now: number): StudioState {
  const name = String(payload.name ?? '')
  const id = String(payload.tool_id ?? '')
  const args = record(payload.args)
  const result = parseResult(payload.result)

  if (FILE_TOOLS.has(name)) {
    const failed = Boolean(result.error) || result.success === false
    const diffs = parseUnifiedDiff(typeof payload.inline_diff === 'string' ? payload.inline_diff : null)
    const toolPaths = editPaths(name, args).map(p => resolvePath(p, state.cwd, state.home))
    let next = state

    if (failed) {
      for (const path of toolPaths) {
        next = withFile(next, path, { status: 'failed', pending: undefined }, now)
      }

      return next
    }

    const done: StudioFileStatus = name === 'write_file' ? 'written' : 'edited'

    if (diffs.length === 0) {
      for (const path of toolPaths) {
        next = withFile(next, path, { status: done, pending: undefined }, now)
      }
    } else {
      diffs.forEach((diff, index) => {
        // A single-file diff belongs to the tool's own path, however the diff spelled it.
        const path = diffs.length === 1 && toolPaths.length === 1 ? toolPaths[0] : resolvePath(diff.path, state.cwd, state.home)
        // A brand-new file is all "added"; marking every line would say nothing.
        next = withFile(next, path, { status: diff.created ? 'written' : done, changedLines: diff.created ? [] : diff.added, pending: undefined }, now)

        if (index === 0) {
          next = { ...next, activeFile: path }
        }
      })
    }

    return { ...next, revision: next.revision + 1 }
  }

  if (TERMINAL_TOOLS.has(name)) {
    const output = typeof result.output === 'string' ? result.output : ''
    const exitCode = typeof result.exit_code === 'number' ? result.exit_code : null
    const processId = typeof result.session_id === 'string' ? result.session_id : undefined
    const background = Boolean(processId) && (Boolean(args.background) || result.status === 'yielded_to_background')
    const status: StudioCommandStatus = background ? 'background' : result.error || (exitCode !== null && exitCode !== 0) ? 'failed' : 'done'
    const text = (output + (typeof result.error === 'string' && result.error ? `\n${result.error}` : '')).slice(-MAX_COMMAND_OUTPUT)
    const existing = state.commands.find(c => c.id === id)
    const command = typeof args.command === 'string' ? args.command : existing?.command ?? ''
    const entry: StudioCommand = { id, command, status, output: text, exitCode, processId, startedAt: existing?.startedAt ?? now }
    const commands = existing ? state.commands.map(c => (c.id === id ? entry : c)) : [...state.commands, entry].slice(-MAX_COMMANDS)
    let next: StudioState = { ...state, commands, revision: state.revision + 1 }

    if (processId && background) {
      const process = next.processes[processId]
      next = { ...next, processes: { ...next.processes, [processId]: { id: processId, command, output: process?.output ?? '', running: true } } }
    }

    return withPreview(next, detectLocalUrl(output), 'auto')
  }

  return state
}

function onTerminalOutput(state: StudioState, payload: Record<string, unknown>): StudioState {
  const id = String(payload.process_id ?? '')
  const chunk = typeof payload.chunk === 'string' ? payload.chunk : ''

  if (!id || !chunk) {
    return state
  }

  const previous = state.processes[id]
  const command = previous?.command ?? state.commands.find(c => c.processId === id)?.command ?? 'background process'
  const output = ((previous?.output ?? '') + chunk).slice(-MAX_PROCESS_OUTPUT)
  const next = { ...state, processes: { ...state.processes, [id]: { id, command, output, running: true } } }

  return withPreview(next, detectLocalUrl(chunk), 'auto')
}

export function reduceStudioEvent(state: StudioState, event: StudioEvent, now = Date.now()): StudioState {
  const payload = record(event.payload)

  switch (event.type) {
    case 'session.info': {
      const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : state.cwd
      const running = typeof payload.running === 'boolean' ? payload.running : state.running

      return cwd === state.cwd && running === state.running ? state : { ...state, cwd, running }
    }

    case 'message.start':
      return { ...state, running: true }

    case 'message.complete':
      return { ...state, running: false, status: '', generating: null }

    case 'tool.generating': {
      const tool = typeof payload.name === 'string' ? payload.name : ''
      const status = tool === 'write_file' ? 'Writing a file…' : tool === 'patch' ? 'Preparing an edit…' : tool === 'terminal' ? 'Preparing a command…' : state.status

      return { ...state, running: true, status, generating: { tool, since: now } }
    }

    case 'status.update':
      return typeof payload.text === 'string' && payload.text ? { ...state, status: payload.text } : state

    case 'tool.start':
      return onToolStart({ ...state, generating: null }, payload, now)

    case 'tool.complete':
      return onToolComplete(state, payload, now)

    case 'agent.terminal.output':
      return onTerminalOutput(state, payload)

    case 'terminal.close': {
      const id = String(payload.process_id ?? '')
      const process = state.processes[id]

      return process ? { ...state, processes: { ...state.processes, [id]: { ...process, running: false } } } : state
    }

    case 'preview.open':
      return typeof payload.url === 'string' ? withPreview(state, payload.url, 'explicit') : state

    default:
      return state
  }
}

/** Point the preview somewhere on purpose (Hermes via `studio.preview`, or the user). */
export function setStudioPreview(state: StudioState, url: string): StudioState {
  return withPreview(state, url, 'explicit')
}

/** A file changed on disk without a Hermes edit (a scaffolder, a formatter): list it and refresh. */
export function noteDiskChange(state: StudioState, paths: string[], now = Date.now()): StudioState {
  let next = state

  for (const path of paths) {
    if (!next.files[path] || !['writing', 'editing'].includes(next.files[path].status)) {
      next = withFile(next, path, { status: next.files[path]?.status ?? 'changed' }, now)
    }
  }

  return { ...next, revision: next.revision + 1 }
}
