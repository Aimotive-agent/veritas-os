import type { SessionListRow } from '@herald-os/client'
import { atom } from 'nanostores'
import { gatewayRequest, isGatewayOpen } from './gateway.ts'

export const $sessions = atom<SessionListRow[]>([])
export const $sessionsLoading = atom(false)

/** stored id -> runtime id, so the sidebar can highlight the live chat. */
export const $runtimeIds = atom<Record<string, string>>({})

export function rememberRuntimeId(storedId: string, runtimeId: string): void {
  $runtimeIds.set({ ...$runtimeIds.get(), [storedId]: runtimeId })
}

let inflight: Promise<void> | null = null

export function refreshSessions(): Promise<void> {
  if (!isGatewayOpen()) {
    return Promise.resolve()
  }

  if (inflight) {
    return inflight
  }

  $sessionsLoading.set(true)
  inflight = gatewayRequest('session.list', { limit: 60 })
    .then(result => {
      // Merge, don't clobber: keep rows we know about that a truncated list dropped.
      const incoming = result.sessions ?? []
      const seen = new Set(incoming.map(row => row.id))
      const kept = $sessions.get().filter(row => !seen.has(row.id))
      const merged = [...incoming, ...kept].sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))
      $sessions.set(merged)
    })
    .catch(() => {
      // Keep the cached list; the next refresh retries.
    })
    .finally(() => {
      $sessionsLoading.set(false)
      inflight = null
    })

  return inflight
}

export async function deleteSession(storedId: string): Promise<void> {
  await gatewayRequest('session.delete', { session_id: storedId })
  $sessions.set($sessions.get().filter(row => row.id !== storedId))
}
