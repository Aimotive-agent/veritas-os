import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { VeritasEntry, VeritasProject, VeritasStatus } from '../../shared/ipc.ts'
import { log } from '../log.ts'
import { opencodeBin } from '../opencode.ts'

/*
 * The Veritas agent is OpenCode (the best CLI agent), run headless. It works inside projects: each
 * project has its own folder and its own session, so the agent keeps separate memory per project and
 * operates in the right place. Messages may carry attachments, which are handed to OpenCode with
 * --file (repeatable, so text files and images both work).
 */

const TIMEOUT_MS = 180_000
const MAX_REPLY = 4000
const MAX_TRANSCRIPT = 500
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'])

interface VeritasConfig {
  telegram: { botToken: string; allowedChatIds: number[]; enabled: boolean }
  /** The model the agent runs on. */
  model: string
  /** The model used when an image is attached (the default one cannot read images). */
  visionModel: string
  projects: VeritasProject[]
  currentProject: string
}

const DEFAULTS: Omit<VeritasConfig, 'projects' | 'currentProject'> = {
  telegram: { botToken: '', allowedChatIds: [], enabled: false },
  model: 'deepseek/deepseek-v4-pro',
  visionModel: 'omniroute/auto/best-vision'
}

/** A fresh OpenCode session id (they must start with "ses"). */
function newSessionId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let id = ''

  for (let i = 0; i < 24; i++) {
    id += alphabet[Math.floor(Math.random() * alphabet.length)]
  }

  return `ses_${id}`
}

function slug(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

  return base || 'project'
}

function configPath(): string {
  return path.join(os.homedir(), '.config', 'veritas-os', 'veritas.json')
}

function transcriptPath(): string {
  return path.join(os.homedir(), '.config', 'veritas-os', 'transcript.json')
}

/** The shared conversation: the page and Telegram are one thread, kept on disk so it survives restarts. */
function loadTranscript(): VeritasEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(transcriptPath(), 'utf8')) as VeritasEntry[]
    return Array.isArray(raw) ? raw.slice(-MAX_TRANSCRIPT) : []
  } catch {
    return []
  }
}

function saveTranscript(entries: VeritasEntry[]): void {
  const file = transcriptPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(entries.slice(-MAX_TRANSCRIPT), null, 2), 'utf8')
}

function isImage(file: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase())
}

export class VeritasAgent extends EventEmitter {
  private config: VeritasConfig = loadConfig()
  private transcript = loadTranscript()
  private busy = false
  private lastError: string | undefined

  getTelegramConfig(): VeritasConfig['telegram'] {
    return this.config.telegram
  }

  /** The project messages go to right now. */
  currentProject(): VeritasProject {
    return this.config.projects.find(project => project.id === this.config.currentProject) ?? this.config.projects[0]
  }

  status(): VeritasStatus {
    return {
      telegramConfigured: Boolean(this.config.telegram.botToken.trim() && this.config.telegram.allowedChatIds.length > 0),
      telegramEnabled: this.config.telegram.enabled,
      allowedChatIds: [...this.config.telegram.allowedChatIds],
      model: this.config.model,
      visionModel: this.config.visionModel,
      projects: this.config.projects.map(project => ({ ...project })),
      currentProject: this.config.currentProject,
      transcript: [...this.transcript],
      busy: this.busy,
      ...(this.lastError ? { lastError: this.lastError } : {})
    }
  }

  configure(patch: {
    telegram?: Partial<VeritasConfig['telegram']>
    model?: string
    visionModel?: string
    currentProject?: string
    addProject?: { name: string; path: string }
    removeProject?: string
  }): VeritasStatus {
    const projects = [...this.config.projects]

    if (patch.addProject) {
      const name = patch.addProject.name.trim() || 'Project'
      const id = `${slug(name)}-${Math.random().toString(36).slice(2, 6)}`
      projects.push({ id, name, path: path.resolve(patch.addProject.path.trim() || os.homedir()), sessionId: newSessionId() })
    }

    if (patch.removeProject) {
      const index = projects.findIndex(project => project.id === patch.removeProject)
      if (index >= 0 && projects.length > 1) {
        projects.splice(index, 1)
      }
    }

    this.config = {
      telegram: { ...this.config.telegram, ...(patch.telegram ?? {}) },
      model: patch.model?.trim() ? patch.model : this.config.model,
      visionModel: patch.visionModel?.trim() ? patch.visionModel : this.config.visionModel,
      projects,
      currentProject: projects.some(project => project.id === patch.currentProject) ? patch.currentProject! : this.config.currentProject
    }

    persist(this.config)
    this.emit('changed')

    return this.status()
  }

  /** Send one message to the Veritas agent and return its reply. */
  async ask(text: string, source: VeritasEntry['source'] = 'app', attachments: string[] = []): Promise<string> {
    const prompt = text.trim()

    if (!prompt) {
      throw new Error('Nothing to ask.')
    }

    if (this.busy) {
      throw new Error('Veritas is already working.')
    }

    const project = this.currentProject()

    this.busy = true
    this.lastError = undefined
    this.emit('changed')
    this.push({ role: 'user', text: prompt, ts: Date.now(), source, projectId: project.id })

    try {
      const reply = (await this.run(prompt, project, attachments)).slice(0, MAX_REPLY)
      this.push({ role: 'assistant', text: reply || '(no output)', ts: Date.now(), source, projectId: project.id })
      log('veritas', `replied: ${reply.slice(0, 120)}`)

      return reply || '(no output)'
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastError = message
      this.push({ role: 'assistant', text: `⚠️ ${message}`, ts: Date.now(), source, projectId: project.id })
      log('veritas', `error: ${message.slice(0, 300)}`)
      throw error
    } finally {
      this.busy = false
      this.emit('changed')
    }
  }

  /**
   * Prove the whole agent path works — binary, model, session, reply. Run at startup so a broken
   * setup shows up in the log at once instead of at the first request.
   */
  async selfTest(): Promise<boolean> {
    try {
      const reply = (await this.run('Reply with the single word: ok', this.currentProject(), [])).slice(0, 120)
      log('veritas', `self test ok: ${reply}`)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('veritas', `self test failed: ${message.slice(0, 300)}`)
      return false
    }
  }

  /** Run one prompt through OpenCode and resolve with its reply. */
  private run(prompt: string, project: VeritasProject, attachments: string[]): Promise<string> {
    const bin = opencodeBin()
    // An image needs a model that can read one; the default text model cannot.
    const wantsVision = attachments.some(isImage)
    const model = wantsVision ? this.config.visionModel : this.config.model
    const files = attachments.flatMap(file => ['--file', file])
    const args = ['run', '--agent', 'veritas', '--model', model, '--session', project.sessionId, '--auto', ...files, prompt]

    log('veritas', `running the agent via ${bin} (${project.name}${wantsVision ? ', vision model' : ''})`)

    return new Promise<string>((resolve, reject) => {
      // spawn, not execFile: execFile's output-capture path leaves the OpenCode CLI waiting, and the
      // request then times out with no output at all. spawn with an ignored stdin gives the CLI an
      // immediate EOF and the reply arrives in seconds.
      const child = spawn(bin, args, {
        cwd: project.path,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe']
      })

      let stdout = ''
      let stderr = ''
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', chunk => {
        stdout += chunk
      })
      child.stderr?.on('data', chunk => {
        stderr += chunk
      })

      const kill = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`timed out after ${TIMEOUT_MS / 1000}s`))
      }, TIMEOUT_MS)

      child.on('error', error => {
        clearTimeout(kill)
        reject(error)
      })

      child.on('close', (code, signal) => {
        clearTimeout(kill)
        const text = stdout.trim()

        if (code === 0) {
          resolve(text || '(no output)')

          return
        }

        const detail = stderr.trim()
        reject(new Error(detail || text || `opencode exited with code ${code}${signal ? ` (${signal})` : ''}`))
      })
    })
  }

  /** Add a line to the shared conversation and persist it. */
  private push(entry: VeritasEntry): void {
    this.transcript = [...this.transcript, entry].slice(-MAX_TRANSCRIPT)
    saveTranscript(this.transcript)
    this.emit('changed')
  }
}

function loadConfig(): VeritasConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Partial<VeritasConfig> & { sessionId?: string }
    const projects = Array.isArray(raw.projects) && raw.projects.length ? raw.projects : [{ id: 'general', name: 'General', path: os.homedir(), sessionId: raw.sessionId ?? newSessionId() }]
    const config: VeritasConfig = {
      telegram: { ...DEFAULTS.telegram, ...(raw.telegram ?? {}) },
      model: typeof raw.model === 'string' && raw.model.trim() ? raw.model : DEFAULTS.model,
      visionModel: typeof raw.visionModel === 'string' && raw.visionModel.trim() ? raw.visionModel : DEFAULTS.visionModel,
      projects,
      currentProject: projects.some(project => project.id === raw.currentProject) ? raw.currentProject! : projects[0].id
    }

    persist(config)

    return config
  } catch {
    const projects: VeritasProject[] = [{ id: 'general', name: 'General', path: os.homedir(), sessionId: newSessionId() }]
    const config: VeritasConfig = { ...DEFAULTS, projects, currentProject: projects[0].id }
    persist(config)

    return config
  }
}

function persist(config: VeritasConfig): void {
  const file = configPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}
