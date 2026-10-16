import type { ServerRequest } from '@herald-os/client'

/**
 * Compatibility with Hermes runtimes before the server->client request contract (<= 0.21.0):
 * those backends emit `approval.request` / `clarify.request` / `sudo.request` / `secret.request`
 * EVENTS and expect the answer through `<kind>.respond` RPCs. This module folds that shape into the
 * same `ServerRequest` the newer wire delivers, so the cards do not know which backend they face.
 */

export type LegacyKind = 'approval' | 'clarify' | 'sudo' | 'secret'

export const LEGACY_REQUEST_EVENTS: Record<string, LegacyKind> = {
  'approval.request': 'approval',
  'clarify.request': 'clarify',
  'sudo.request': 'sudo',
  'secret.request': 'secret'
}

export const LEGACY_EXPIRE_EVENTS = new Set(['clarify.expire', 'sudo.expire', 'secret.expire', 'approval.received'])

export type RpcCall = (method: string, params: Record<string, unknown>) => Promise<unknown>

/** Build the RPC calls that answer one legacy request (pure; tested). */
export function legacyResponseCalls(kind: LegacyKind, sessionId: string, params: Record<string, unknown>, result: Record<string, unknown>): Array<{ method: string; params: Record<string, unknown> }> {
  const requestId = typeof params.request_id === 'string' ? params.request_id : undefined

  switch (kind) {
    case 'approval':
      return [{ method: 'approval.respond', params: { session_id: sessionId, choice: result.choice ?? 'deny', all: Boolean(result.all), ...(requestId ? { request_id: requestId } : {}) } }]
    case 'clarify': {
      const answers = result.answers as Record<string, string> | undefined
      const questions = params.questions as Array<{ qid: string }> | undefined

      if (questions?.length) {
        // Batch: the legacy backend locks one answer per question id; the final lock releases the tool.
        return questions.map(question => ({ method: 'clarify.respond', params: { session_id: sessionId, request_id: requestId, question_id: question.qid, answer: answers?.[question.qid] ?? '' } }))
      }

      return [{ method: 'clarify.respond', params: { session_id: sessionId, request_id: requestId, answer: typeof result.answer === 'string' ? result.answer : '' } }]
    }
    case 'sudo':
      return [{ method: 'sudo.respond', params: { session_id: sessionId, request_id: requestId, password: typeof result.value === 'string' ? result.value : '' } }]
    case 'secret':
      return [{ method: 'secret.respond', params: { session_id: sessionId, request_id: requestId, value: typeof result.value === 'string' ? result.value : '' } }]
  }
}

/** Wrap a legacy event as a ServerRequest whose respond() drives the legacy RPCs. */
export function legacyRequestFromEvent(kind: LegacyKind, sessionId: string, payload: Record<string, unknown>, call: RpcCall): ServerRequest {
  const requestId = typeof payload.request_id === 'string' ? payload.request_id : `legacy-${kind}-${sessionId}-${Date.now().toString(36)}`
  const params = { ...payload, session_id: sessionId, request_id: requestId }
  let answered = false

  return {
    id: `legacy:${requestId}`,
    method: kind,
    params,
    respond: result => {
      if (answered) {
        return
      }

      answered = true

      for (const rpc of legacyResponseCalls(kind, sessionId, params, result)) {
        void call(rpc.method, rpc.params).catch(() => undefined)
      }
    },
    fail: () => {
      if (answered) {
        return
      }

      answered = true
      const decline = kind === 'approval' ? { choice: 'deny' } : kind === 'clarify' ? { answer: '' } : { value: '' }

      for (const rpc of legacyResponseCalls(kind, sessionId, params, decline)) {
        void call(rpc.method, rpc.params).catch(() => undefined)
      }
    }
  }
}
