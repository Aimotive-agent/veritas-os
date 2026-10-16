import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { log } from '../log.ts'
import type { AgentManager } from './manager.ts'
import type { ShellAutomation, ShellAutomationDraft } from '../../shared/ipc.ts'

/*
 * Automations that run on an agent other than Hermes.
 *
 * Hermes owns its own cron (jobs created through its API run on the Hermes backend). When a person
 * picks a different agent for an automation, the shell owns it instead: this scheduler keeps the
 * list in ~/.config/veritas-os/automations.json and, when a job is due, hands the prompt to that
 * agent through the same path a mission uses.
 */

const TICK_MS = 30_000
const STORE_VERSION = 1

interface StoredFile {
  version: number
  automations: ShellAutomation[]
}

function storePath(): string {
  return path.join(os.homedir(), '.config/veritas-os/automations.json')
}

// ---- cron (5-field: minute hour day-of-month month day-of-week) --------------------------------

function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  for (const part of field.split(',')) {
    const [range, stepRaw] = part.split('/')
    const step = stepRaw === undefined ? 1 : Number(stepRaw)

    if (!Number.isFinite(step) || step < 1) {
      continue
    }

    let lo = min
    let hi = max

    if (range !== '*') {
      const bounds = (range ?? '').split('-')
      lo = Number(bounds[0])
      hi = bounds.length > 1 ? Number(bounds[1]) : lo

      if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
        continue
      }
    }

    for (let candidate = Math.max(lo, min); candidate <= Math.min(hi, max); candidate += step) {
      if (candidate === value) {
        return true
      }
    }
  }

  return false
}

/** Whether a standard 5-field crontab expression fires at this minute. */
export function cronMatches(expression: string, date: Date): boolean {
  const parts = expression.trim().split(/\s+/)

  if (parts.length !== 5) {
    return false
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [string, string, string, string, string]

  return (
    fieldMatches(minute, date.getMinutes(), 0, 59) &&
    fieldMatches(hour, date.getHours(), 0, 23) &&
    fieldMatches(dayOfMonth, date.getDate(), 1, 31) &&
    fieldMatches(month, date.getMonth() + 1, 1, 12) &&
    fieldMatches(dayOfWeek, date.getDay(), 0, 6)
  )
}

// ---- store ------------------------------------------------------------------------------------

function readStore(): ShellAutomation[] {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), 'utf8')) as StoredFile | ShellAutomation[]

    return Array.isArray(raw) ? raw : (raw.automations ?? [])
  } catch {
    return []
  }
}

function writeStore(automations: ShellAutomation[]): void {
  const file = storePath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const payload: StoredFile = { version: STORE_VERSION, automations }
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
}

// ---- scheduler --------------------------------------------------------------------------------

export class ShellAutomations {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly ranAt = new Map<string, number>()

  constructor(private readonly agents: AgentManager, private readonly onChange: () => void) {}

  start(): void {
    if (this.timer) {
      return
    }

    this.timer = setInterval(() => void this.tick(), TICK_MS)
    void this.tick()
    log('automations', `shell automations scheduler started (${this.list().length} stored)`)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  list(): ShellAutomation[] {
    return readStore().sort((a, b) => a.name.localeCompare(b.name))
  }

  create(draft: ShellAutomationDraft): ShellAutomation {
    const automation: ShellAutomation = {
      id: `sa_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      name: draft.name.trim() || draft.prompt.trim().slice(0, 60) || 'Automation',
      schedule: draft.schedule.trim(),
      agentId: draft.agentId,
      prompt: draft.prompt.trim(),
      enabled: draft.enabled ?? true,
      runCount: 0,
      createdAt: Date.now()
    }

    if (!cronMatches(automation.schedule, new Date()) && automation.schedule.split(/\s+/).length !== 5) {
      // The expression is stored as given; an unparseable one simply never fires.
      log('automations', `stored an automation with a non-standard schedule: ${automation.schedule}`)
    }

    writeStore([...readStore(), automation])
    this.onChange()

    return automation
  }

  update(id: string, patch: Partial<Pick<ShellAutomation, 'name' | 'schedule' | 'prompt' | 'agentId' | 'enabled'>>): ShellAutomation[] {
    const next = readStore().map(automation => (automation.id === id ? { ...automation, ...patch } : automation))
    writeStore(next)
    this.onChange()

    return this.list()
  }

  remove(id: string): ShellAutomation[] {
    writeStore(readStore().filter(automation => automation.id !== id))
    this.onChange()

    return this.list()
  }

  /** Run one now, exactly as the scheduler would. */
  async run(id: string): Promise<ShellAutomation[]> {
    const automation = readStore().find(candidate => candidate.id === id)

    if (!automation) {
      throw new Error(`no automation ${id}`)
    }

    await this.execute(automation)

    return this.list()
  }

  private async tick(): Promise<void> {
    const now = new Date()
    const minuteKey = Math.floor(now.getTime() / 60_000)

    for (const automation of readStore()) {
      if (!automation.enabled || !cronMatches(automation.schedule, now)) {
        continue
      }
      if (this.ranAt.get(automation.id) === minuteKey) {
        continue
      }

      this.ranAt.set(automation.id, minuteKey)
      void this.execute(automation)
    }
  }

  private async execute(automation: ShellAutomation): Promise<void> {
    try {
      await this.agents.run(automation.agentId, automation.prompt)
      this.record(automation.id, { lastRunAt: Date.now(), lastError: undefined })
      log('automations', `ran "${automation.name}" on ${automation.agentId}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.record(automation.id, { lastRunAt: Date.now(), lastError: message })
      log('automations', `"${automation.name}" failed: ${message}`)
    }
  }

  private record(id: string, patch: Partial<ShellAutomation>): void {
    const next = readStore().map(automation =>
      automation.id === id ? { ...automation, ...patch, runCount: (automation.runCount ?? 0) + (patch.lastRunAt ? 1 : 0) } : automation
    )
    writeStore(next)
    this.onChange()
  }
}
