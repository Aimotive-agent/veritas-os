import { type ChildProcess, execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { AgentPairResult, AgentSnapshot, AgentSpec } from '../../shared/ipc.ts'
import { log } from '../log.ts'

/*
 * Extra agents beyond the primary Hermes backend. Each entry is a local process that serves an HTTP
 * API (and, for agents that ship one, its own web UI). The shell spawns, monitors and restarts them,
 * and the renderer opens their UI inside a Veritas OS window through the existing web views.
 *
 * Built-ins are Hermes (managed by BackendManager, surfaced here read-only) and OpenCode. Users add
 * more by dropping specs into ~/.config/veritas-os/agents.json.
 */

const READY_TIMEOUT_MS = 90_000
const MAX_RESTARTS = 4
const BACKOFF_MS = [1_000, 3_000, 7_000, 15_000]
const LOG_TAIL_LINES = 200

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

interface OpencodeService {
  url: string
  port: number
  password?: string
}

/** Where the CLI and desktop app register the shared service (`XDG_STATE_HOME`, default `~/.local/state`). */
function opencodeServiceFiles(): string[] {
  const roots = [process.env.XDG_STATE_HOME, path.join(os.homedir(), '.local/state'), path.join(os.homedir(), '.config/ai.opencode.desktop')].filter(Boolean) as string[]

  return roots.map(root => path.join(root, 'opencode/service.json'))
}

/** The running shared service, when one is registered. */
export function discoverOpencodeService(): OpencodeService | null {
  for (const file of opencodeServiceFiles()) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { url?: string; password?: string; pid?: number }
      if (!raw.url) continue
      const url = new URL(raw.url)
      const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
      // A stale file for a dead process must not look ready.
      if (raw.pid && !isAlive(raw.pid)) continue
      return { url: raw.url.replace(/\/+$/, ''), port, password: raw.password }
    } catch {
      // No registration here.
    }
  }
  return null
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function opencodeBin(): string {
  const candidates = [path.join(os.homedir(), '.opencode/bin/opencode'), path.join(os.homedir(), '.local/bin/opencode')]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }
  return 'opencode'
}

export function builtInAgentSpecs(): AgentSpec[] {
  return [
    {
      id: 'opencode',
      name: 'OpenCode',
      kind: 'opencode',
      /**
       * OpenCode's CLI, desktop app and pairing all share ONE background service
       * (`opencode serve --service`, registered in <state>/opencode/service.json). Attaching to it
       * is what makes pairing links and the embedded UI agree; a private `serve` would 401 them.
       */
      command: [opencodeBin(), 'serve', '--service'],
      attach: 'opencode-service',
      env: {},
      readyUrl: 'http://127.0.0.1:{port}/health',
      /** Its own web UI is a complete chat, so the shell embeds it rather than re-rendering it. */
      embedUrl: 'http://127.0.0.1:{port}/',
      /** One-time links that connect another browser or app; `opencode pair` targets the shared service. */
      pairCommand: [opencodeBin(), 'pair'],
      /** Missions run as a prompt to the shared service, so the agent page shows the work. */
      runCommand: [opencodeBin(), 'run', '{goal}'],
      defaultEnabled: true
    },
    {
      id: 'unsloth',
      name: 'Unsloth Studio',
      kind: 'unsloth',
      /** The studio is a local web app (model runner + trainer) served on its own port. */
      command: ['unsloth', 'studio', 'run', '--model', 'unsloth/LFM2.5-1.2B-Instruct-GGUF', '--port', '{port}'],
      env: {},
      readyUrl: 'http://127.0.0.1:{port}/api/health',
      embedUrl: 'http://127.0.0.1:{port}/',
      defaultEnabled: false
    }
  ]
}

function userAgentsPath(): string {
  return path.join(os.homedir(), '.config/veritas-os/agents.json')
}

function loadUserAgentSpecs(): AgentSpec[] {
  try {
    const raw = JSON.parse(fs.readFileSync(userAgentsPath(), 'utf8')) as { agents?: AgentSpec[] } | AgentSpec[]
    const list = Array.isArray(raw) ? raw : (raw.agents ?? [])

    return list.filter(spec => typeof spec?.id === 'string' && Array.isArray(spec.command))
  } catch {
    return []
  }
}

/** One extra agent: its process, readiness, logs and restart policy. */
class Agent {
  readonly spec: AgentSpec
  private state: AgentSnapshot
  private child: ChildProcess | null = null
  private port: number | null = null
  private stopping = false
  private generation = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private readonly tail: string[] = []

  constructor(spec: AgentSpec, private readonly onChange: () => void, private readonly emitLog: (line: string) => void) {
    this.spec = spec
    this.state = { id: spec.id, name: spec.name, kind: spec.kind, phase: 'stopped', attempt: 0, port: null, embedUrl: null }
  }

  snapshot(): AgentSnapshot {
    return { ...this.state, canPair: Boolean(this.spec.pairCommand?.length), canRun: Boolean(this.spec.runCommand?.length), logTail: this.tail.slice(-LOG_TAIL_LINES) }
  }

  async start(): Promise<void> {
    this.stopping = false
    await this.launch(0)
  }

  async restart(): Promise<void> {
    this.clearRestartTimer()
    await this.kill()
    this.stopping = false
    await this.launch(0)
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.clearRestartTimer()
    await this.kill()
    this.set({ phase: 'stopped', port: null, embedUrl: null })
  }

  private async launch(attempt: number): Promise<void> {
    const generation = ++this.generation
    this.set({ phase: attempt === 0 ? 'starting' : 'restarting', attempt, error: undefined })

    if (this.spec.attach === 'opencode-service') {
      await this.attachService(generation, attempt)
      return
    }

    const port = await freePort()
    const vars: Record<string, string> = { port: String(port) }
    const fill = (value: string) => value.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? '')
    const [command, ...args] = this.spec.command
    if (!command) {
      this.set({ phase: 'failed', error: 'no command configured' })
      return
    }
    const env: NodeJS.ProcessEnv = { ...process.env, ...Object.fromEntries(Object.entries(this.spec.env ?? {}).map(([key, value]) => [key, fill(String(value))])) }
    delete env.ELECTRON_RUN_AS_NODE

    this.record(`spawning: ${[command, ...args].join(' ')} ${this.spec.cwd ?? ''}`)
    const child = spawn(command, args.map(fill), { cwd: this.spec.cwd ? fill(this.spec.cwd) : undefined, env, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => chunk.split('\n').forEach(line => line.trim() && this.record(`[out] ${line}`)))
    child.stderr?.on('data', (chunk: string) => chunk.split('\n').forEach(line => line.trim() && this.record(`[err] ${line}`)))
    child.on('exit', (code, signal) => {
      this.record(`exited code=${code} signal=${signal}`)
      if (this.child === child) {
        this.child = null
      }
      if (!this.stopping && generation === this.generation) {
        this.scheduleRestart(attempt, `agent exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`)
      }
    })
    child.on('error', error => this.record(`spawn error: ${error.message}`))

    const url = fill(this.spec.readyUrl)
    const started = Date.now()
    const poll = setInterval(async () => {
      if (generation !== this.generation || this.stopping) {
        clearInterval(poll)
        return
      }
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2500) })
        // OpenCode answers /health with its SPA for unknown routes; any 2xx/3xx means serving.
        if (response.status < 400) {
          clearInterval(poll)
          this.port = port
          this.set({ phase: 'ready', port, embedUrl: this.spec.embedUrl ? fill(this.spec.embedUrl) : null, error: undefined })
          log('agents', `${this.spec.id} ready on :${port}`)
        }
      } catch {
        // Not up yet.
      }
      if (Date.now() - started > READY_TIMEOUT_MS) {
        clearInterval(poll)
        this.set({ phase: 'failed', error: 'timed out waiting for the agent to become ready' })
      }
    }, 700)
  }

  /**
   * Attach to the shared OpenCode service, starting it when nothing is registered. The service is a
   * sibling of the CLI and the desktop app, so its UI, sessions and pairing links are all one world.
   */
  private async attachService(generation: number, attempt: number): Promise<void> {
    const existing = discoverOpencodeService()
    if (existing) {
      this.port = existing.port
      this.set({ phase: 'ready', port: existing.port, embedUrl: `${existing.url}/`, error: undefined })
      log('agents', `opencode attached to the shared service on :${existing.port}`)
      return
    }

    const [command, ...args] = this.spec.command
    this.record(`starting the shared service: ${[command, ...args].join(' ')}`)
    try {
      const child = spawn(command ?? '', args, { detached: true, stdio: 'ignore', env: { ...process.env } })
      child.unref()
    } catch (error) {
      this.record(`could not start the service: ${String(error)}`)
    }

    const started = Date.now()
    const poll = setInterval(() => {
      if (generation !== this.generation || this.stopping) {
        clearInterval(poll)
        return
      }
      const found = discoverOpencodeService()
      if (found) {
        clearInterval(poll)
        this.port = found.port
        this.set({ phase: 'ready', port: found.port, embedUrl: `${found.url}/`, error: undefined })
        log('agents', `opencode service ready on :${found.port}`)
        return
      }
      if (Date.now() - started > READY_TIMEOUT_MS) {
        clearInterval(poll)
        this.set({ phase: 'failed', error: 'timed out waiting for the OpenCode service' })
      }
    }, 700)
  }

  private scheduleRestart(previousAttempt: number, reason: string): void {
    const next = previousAttempt + 1
    if (next > MAX_RESTARTS) {
      this.set({ phase: 'failed', error: reason, port: null, embedUrl: null })
      return
    }
    const delay = BACKOFF_MS[Math.min(next - 1, BACKOFF_MS.length - 1)]
    this.clearRestartTimer()
    this.restartTimer = setTimeout(() => void this.launch(next), delay)
    this.set({ phase: 'restarting', attempt: next, error: reason, port: null, embedUrl: null })
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }

  private async kill(): Promise<void> {
    const child = this.child
    this.child = null
    this.generation++
    // Attached agents own no process: the shared service outlives Veritas OS on purpose.
    if (this.spec.attach === 'opencode-service') {
      return
    }
    if (!child || child.exitCode !== null) {
      return
    }
    await new Promise<void>(resolve => {
      const force = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
        resolve()
      }, 4000)
      child.once('exit', () => {
        clearTimeout(force)
        resolve()
      })
      try {
        child.kill('SIGTERM')
      } catch {
        clearTimeout(force)
        resolve()
      }
    })
  }

  private record(line: string): void {
    this.tail.push(line)
    if (this.tail.length > LOG_TAIL_LINES * 2) {
      this.tail.splice(0, this.tail.length - LOG_TAIL_LINES)
    }
    this.emitLog(`${this.spec.id}: ${line}`)
  }

  private set(patch: Partial<AgentSnapshot>): void {
    this.state = { ...this.state, ...patch }
    this.onChange()
  }
}

/** Owns every extra agent and broadcasts their state to the shell. */
export class AgentManager extends EventEmitter {
  private readonly agents = new Map<string, Agent>()

  constructor() {
    super()
    for (const spec of [...builtInAgentSpecs(), ...loadUserAgentSpecs()]) {
      this.agents.set(spec.id, new Agent(spec, () => this.emit('state'), line => log('agents', line)))
    }
  }

  list(): AgentSnapshot[] {
    return [...this.agents.values()].map(agent => agent.snapshot())
  }

  async start(id: string): Promise<void> {
    await this.agents.get(id)?.start()
  }

  async stop(id: string): Promise<void> {
    await this.agents.get(id)?.stop()
  }

  async restart(id: string): Promise<void> {
    await this.agents.get(id)?.restart()
  }

  /** Hand one mission goal to an agent that knows how to run one, detached from the shell. */
  async run(id: string, goal: string): Promise<void> {
    const agent = this.agents.get(id)
    if (!agent) {
      throw new Error(`no agent ${id}`)
    }
    const spec = agent.spec
    if (!spec.runCommand?.length) {
      throw new Error(`${spec.name} cannot run missions yet`)
    }
    const trimmed = goal.trim()
    if (!trimmed) {
      throw new Error('A mission needs a goal.')
    }
    const vars: Record<string, string> = { goal: trimmed, port: String(agent.snapshot().port ?? '') }
    const [command, ...args] = spec.runCommand.map(part => part.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? ''))
    const child = spawn(command ?? '', args, { detached: true, stdio: 'ignore', env: { ...process.env } })
    child.unref()
    log('agents', `${spec.id} running a mission: ${trimmed.slice(0, 80)}`)
  }

  /** Run the agent's pair command and return the one-time link(s) it printed. */
  pair(id: string): Promise<AgentPairResult> {
    const agent = this.agents.get(id)
    if (!agent || agent.snapshot().phase !== 'ready' || !agent.snapshot().port) {
      return Promise.reject(new Error(`agent ${id} is not ready`))
    }
    const spec = agent.spec
    if (!spec.pairCommand?.length) {
      return Promise.reject(new Error(`${spec.name} does not support pairing`))
    }
    const port = agent.snapshot().port as number
    const [command, ...args] = spec.pairCommand.map(part => part.replace('{port}', String(port)))

    return new Promise((resolve, reject) => {
      execFile(command ?? '', args, { timeout: 20_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        const output = `${stdout ?? ''}${stderr ?? ''}`.trim()
        const links = [...output.matchAll(/https?:\/\/[^\s"'<>]+/g)].map(match => match[0])
        if (error && !links.length) {
          reject(new Error(output || error.message))
          return
        }
        resolve({ links: [...new Set(links)], output })
      })
    })
  }

  async startDefaults(): Promise<void> {
    for (const agent of this.agents.values()) {
      if (agent.spec.defaultEnabled) {
        void agent.start().catch(() => undefined)
      }
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.agents.values()].map(agent => agent.stop().catch(() => undefined)))
  }
}
