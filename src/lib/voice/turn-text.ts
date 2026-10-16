// Pure projection of a chat's messages onto "what Hermes has said since the user's utterance".
// Narration between tool calls counts too, so the voice reads "Let me check." before the result.
import type { ChatMessage } from '../chat-model.ts'

/** Concatenated assistant text of every assistant message after `fromIndex` (exclusive). */
export function assistantTextSince(messages: readonly ChatMessage[], fromIndex: number): string {
  const parts: string[] = []

  for (let i = fromIndex + 1; i < messages.length; i++) {
    const message = messages[i]

    if (message.role === 'assistant' && message.text) {
      parts.push(message.text)
    }
  }

  return parts.join('\n\n')
}

/** Names of tools still running after `fromIndex`. */
export function runningToolsSince(messages: readonly ChatMessage[], fromIndex: number): string[] {
  const names: string[] = []

  for (let i = fromIndex + 1; i < messages.length; i++) {
    const message = messages[i]

    if (message.role === 'tool' && message.running) {
      names.push(message.name)
    }
  }

  return names
}

/** Names of every tool the turn used after `fromIndex`, running or finished. */
export function toolsSince(messages: readonly ChatMessage[], fromIndex: number): string[] {
  const names: string[] = []

  for (let i = fromIndex + 1; i < messages.length; i++) {
    const message = messages[i]

    if (message.role === 'tool') {
      names.push(message.name)
    }
  }

  return names
}

/** The delta between two growing texts; empty when `next` does not extend `previous`. */
export function textDelta(previous: string, next: string): string {
  if (next.length <= previous.length) {
    return ''
  }

  return next.startsWith(previous) ? next.slice(previous.length) : ''
}
