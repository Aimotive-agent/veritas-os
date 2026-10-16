import type { SubagentEventPayload } from '@herald-os/client'
import { atom } from 'nanostores'
import { onAnyGatewayEvent } from './gateway.ts'

export interface AgentActivity {
  id: string
  parentSessionId?: string
  goal: string
  status: 'running' | 'complete' | 'failed' | 'queued'
  lastEvent: string
  lastText?: string
  toolName?: string
  model?: string
  depth?: number
  apiCalls?: number
  inputTokens?: number
  outputTokens?: number
  startedAt: number
  updatedAt: number
  durationSeconds?: number
  summary?: string
}

export const $agents = atom<Record<string, AgentActivity>>({})

const SUBAGENT_EVENTS = new Set(['subagent.spawn_requested', 'subagent.start', 'subagent.progress', 'subagent.thinking', 'subagent.tool', 'subagent.complete'])

export function bindAgentEvents(): () => void {
  return onAnyGatewayEvent(event => {
    if (!SUBAGENT_EVENTS.has(event.type)) {
      return
    }

    const payload = event.payload as SubagentEventPayload | undefined

    if (!payload) {
      return
    }

    const id = payload.subagent_id ?? payload.delegation_id ?? `${event.session_id ?? 'root'}:${payload.task_index}`
    const previous = $agents.get()[id]
    const now = Date.now()
    const status: AgentActivity['status'] =
      event.type === 'subagent.complete'
        ? payload.status === 'failed' || payload.status === 'error'
          ? 'failed'
          : 'complete'
        : event.type === 'subagent.spawn_requested'
          ? 'queued'
          : 'running'

    $agents.set({
      ...$agents.get(),
      [id]: {
        id,
        parentSessionId: event.session_id ?? previous?.parentSessionId,
        goal: payload.goal || previous?.goal || 'Delegated task',
        status,
        lastEvent: event.type,
        lastText: payload.text ?? payload.tool_preview ?? previous?.lastText,
        toolName: payload.tool_name ?? previous?.toolName,
        model: payload.model ?? previous?.model,
        depth: payload.depth ?? previous?.depth,
        apiCalls: payload.api_calls ?? previous?.apiCalls,
        inputTokens: payload.input_tokens ?? previous?.inputTokens,
        outputTokens: payload.output_tokens ?? previous?.outputTokens,
        startedAt: previous?.startedAt ?? now,
        updatedAt: now,
        durationSeconds: payload.duration_seconds ?? previous?.durationSeconds,
        summary: payload.summary ?? previous?.summary
      }
    })
  })
}

export function clearFinishedAgents(): void {
  const next: Record<string, AgentActivity> = {}

  for (const [id, agent] of Object.entries($agents.get())) {
    if (agent.status === 'running' || agent.status === 'queued') {
      next[id] = agent
    }
  }

  $agents.set(next)
}
