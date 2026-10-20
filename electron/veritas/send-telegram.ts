import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/*
 * Lets the Veritas agent proactively send a message to Chris's Telegram (the bot's first allowed
 * chat). This is the outbound half of the bridge; the inbound half is electron/veritas/telegram.ts.
 */

export async function sendTelegram(text: string): Promise<string> {
  const file = path.join(os.homedir(), '.config', 'veritas-os', 'veritas.json')
  let config: { telegram?: { botToken?: string; allowedChatIds?: number[] } }

  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof config
  } catch {
    throw new Error('Veritas Telegram is not configured.')
  }

  const token = config.telegram?.botToken?.trim()
  const chatId = config.telegram?.allowedChatIds?.[0]

  if (!token || !chatId) {
    throw new Error('Veritas Telegram is not configured (no bot token or chat id).')
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }),
    signal: AbortSignal.timeout(15_000)
  })

  if (!response.ok) {
    throw new Error(`Telegram send failed: ${response.status}`)
  }

  return 'Sent a message to your Telegram.'
}
