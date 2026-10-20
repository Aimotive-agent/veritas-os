import type { AgentManager } from '../agents/manager.ts'
import type { VeritasAgent } from './agent.ts'
import { log } from '../log.ts'

/*
 * Veritas's own Telegram channel: a separate bot from the CEO's. Long-polling, no webhook. Only the
 * allowed chat ids can talk to it; plain text goes to the OpenCode-backed Veritas agent.
 */

const API = 'https://api.telegram.org'
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

interface TelegramUpdate {
  update_id: number
  message?: { chat: { id: number }; from?: { id: number }; text?: string }
}

export class VeritasTelegram {
  private config: { botToken: string; allowedChatIds: number[]; enabled: boolean } = { botToken: '', allowedChatIds: [], enabled: false }
  private offset = 0
  private running = false

  constructor(
    private readonly agent: VeritasAgent,
    private readonly agents: AgentManager
  ) {
    agent.on('changed', () => this.apply(agent.getTelegramConfig()))
  }

  apply(config: { botToken: string; allowedChatIds: number[]; enabled: boolean }): void {
    const changed = JSON.stringify(config) !== JSON.stringify(this.config)
    this.config = config
    const ready = config.enabled && config.botToken.trim() !== '' && config.allowedChatIds.length > 0

    if (ready && (changed || !this.running)) {
      this.start()
    } else if (!ready) {
      this.stop()
    }
  }

  stop(): void {
    this.running = false
  }

  private start(): void {
    if (this.running) {
      return
    }

    this.running = true
    void this.loop()
    log('veritas', `telegram polling for ${this.config.allowedChatIds.length} allowed chat(s)`)
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.poll()
      } catch (error) {
        log('veritas', `telegram poll error: ${error instanceof Error ? error.message : String(error)}`)
        await sleep(2000)
      }
    }
  }

  private async poll(): Promise<void> {
    const updates = await this.getUpdates()

    for (const update of updates) {
      this.offset = Math.max(this.offset, update.update_id + 1)
      await this.handle(update)
    }
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const url = `${API}/bot${this.config.botToken}/getUpdates?timeout=25&offset=${this.offset}&allowed_updates=${encodeURIComponent(JSON.stringify(['message']))}`
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })

    if (!response.ok) {
      throw new Error(`telegram ${response.status}: ${(await response.text()).slice(0, 200)}`)
    }

    const data = (await response.json()) as { ok: boolean; result?: TelegramUpdate[] }

    return data.ok ? (data.result ?? []) : []
  }

  private async handle(update: TelegramUpdate): Promise<void> {
    const message = update.message

    if (!message?.text) {
      return
    }

    const chatId = message.chat.id
    const fromId = message.from?.id

    if (fromId === undefined || !this.config.allowedChatIds.includes(fromId)) {
      return
    }

    const text = message.text.trim()
    let reply: string

    if (text === '/start' || text === '/help') {
      reply = this.help()
    } else if (text === '/agents') {
      reply = this.agentStatus()
    } else {
      try {
        reply = await this.agent.ask(text, 'telegram')
      } catch (error) {
        reply = `⚠️ ${error instanceof Error ? error.message : String(error)}`
      }
    }

    await this.send(chatId, reply)
  }

  private agentStatus(): string {
    const rows = this.agents.list().map(agent => `${agent.name} (${agent.id}) — ${agent.phase}`)

    return rows.length ? `Agents:\n${rows.join('\n')}` : 'No agents are registered.'
  }

  private help(): string {
    return ['Veritas \u2014 your OpenCode operator, from anywhere.', '', '/agents \u2014 list your agents and their state', 'Anything else \u2014 ask Veritas (it can run agents, launch apps, run the machine)'].join('\n')
  }

  private async send(chatId: number, text: string): Promise<void> {
    const url = `${API}/bot${this.config.botToken}/sendMessage`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }),
      signal: AbortSignal.timeout(15_000)
    })

    if (!response.ok) {
      log('veritas', `telegram sendMessage failed: ${response.status}`)
    }
  }
}
