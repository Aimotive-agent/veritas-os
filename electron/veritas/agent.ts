import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { VeritasStatus } from '../../shared/ipc.ts'
import { log } from '../log.ts'
import { opencodeBin } from '../opencode.ts'

/*
 * The Veritas agent is OpenCode (the best CLI agent), run headless. This module owns its Telegram
 * config and the one-shot bridge: a message in -> `opencode run --agent veritas` in a stable session
 * -> the reply out. The agent itself (prompt, MCP tools) lives in OpenCode's config.
 */

const TIMEOUT_MS = 180_000
const MAX_REPLY = 4000

interface VeritasConfig {
  telegram: { botToken: string; allowedChatIds: number[]; enabled: boolean }
  /** Model the Veritas agent runs on (passed to `opencode run --model`). */
  model: string
}

const DEFAULTS: VeritasConfig = { telegram: { botToken: '', allowedChatIds: [], enabled: false }, model: 'deepseek/deepseek-v4-pro' }

function configPath(): string {
  return path.join(os.homedir(), '.config', 'veritas-os', 'veritas.json')
}

function loadConfig(): VeritasConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Partial<VeritasConfig>
    return {
      telegram: { ...DEFAULTS.telegram, ...(raw.telegram ?? {}) },
      model: typeof raw.model === 'string' && raw.model.trim() ? raw.model : DEFAULTS.model
    }
  } catch {
    return { telegram: { ...DEFAULTS.telegram }, model: DEFAULTS.model }
  }
}

function persist(config: VeritasConfig): void {
  const file = configPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

export class VeritasAgent extends EventEmitter {
  private config = loadConfig()
  private busy = false
  private lastError: string | undefined

  getTelegramConfig(): VeritasConfig['telegram'] {
    return this.config.telegram
  }

  status(): VeritasStatus {
    return {
      telegramConfigured: Boolean(this.config.telegram.botToken.trim() && this.config.telegram.allowedChatIds.length > 0),
      telegramEnabled: this.config.telegram.enabled,
      allowedChatIds: [...this.config.telegram.allowedChatIds],
      busy: this.busy,
      ...(this.lastError ? { lastError: this.lastError } : {})
    }
  }

  configure(patch: { telegram?: Partial<VeritasConfig['telegram']>; model?: string }): VeritasStatus {
    this.config = {
      telegram: { ...this.config.telegram, ...(patch.telegram ?? {}) },
      model: patch.model?.trim() ? patch.model : this.config.model
    }
    persist(this.config)
    this.emit('changed')
    return this.status()
  }

  /** Send one message to the Veritas agent and return its reply. */
  async ask(text: string): Promise<string> {
    const prompt = text.trim()

    if (!prompt) {
      throw new Error('Nothing to ask.')
    }

    if (this.busy) {
      throw new Error('Veritas is already working.')
    }

    this.busy = true
    this.lastError = undefined
    this.emit('changed')

    try {
      const reply = (await this.run(prompt)).slice(0, MAX_REPLY)
      log('veritas', `replied: ${reply.slice(0, 120)}`)

      return reply || '(no output)'
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastError = message
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
      const reply = (await this.run('Reply with the single word: ok')).slice(0, 120)
      log('veritas', `self test ok: ${reply}`)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('veritas', `self test failed: ${message.slice(0, 300)}`)
      return false
    }
  }

  /** Run one prompt through OpenCode and resolve with its reply. */
  private run(prompt: string): Promise<string> {
    const bin = opencodeBin()
    log('veritas', `running the agent via ${bin}`)

    return new Promise<string>((resolve, reject) => {
      // spawn, not execFile: execFile's output-capture path leaves the OpenCode CLI waiting, and the
      // request then times out with no output at all. spawn with an ignored stdin gives the CLI an
      // immediate EOF and the reply arrives in seconds.
      const child = spawn(bin, ['run', '--agent', 'veritas', '--model', this.config.model, '--auto', prompt], {
        cwd: os.homedir(),
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
}
