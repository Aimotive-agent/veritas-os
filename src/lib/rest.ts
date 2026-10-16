import type { RestRequest } from '../../shared/ipc.ts'

/** REST through Electron main (which holds the session token). */
export const rest = {
  get: <T,>(path: string, query?: RestRequest['query']) => window.heraldOS.backend.rest<T>({ method: 'GET', path, query }),
  post: <T,>(path: string, body?: unknown, query?: RestRequest['query']) => window.heraldOS.backend.rest<T>({ method: 'POST', path, body, query }),
  put: <T,>(path: string, body?: unknown, query?: RestRequest['query']) => window.heraldOS.backend.rest<T>({ method: 'PUT', path, body, query }),
  del: <T,>(path: string, query?: RestRequest['query']) => window.heraldOS.backend.rest<T>({ method: 'DELETE', path, query })
}

export interface CronJob {
  id: string
  name?: string
  prompt?: string
  schedule?: { kind?: string; display?: string; expr?: string; minutes?: number; run_at?: string }
  schedule_display?: string
  enabled?: boolean
  state?: string
  next_run_at?: string | number | null
  last_run_at?: string | number | null
  last_status?: string | null
  last_error?: string | null
  deliver?: string | null
  skills?: string[]
  profile?: string | null
  repeat?: { times?: number | null; completed?: number } | null
  [key: string]: unknown
}

export interface SkillRow {
  name: string
  description?: string
  category?: string
  enabled?: boolean
  usage?: number
  provenance?: 'hub' | 'bundled' | 'agent'
  [key: string]: unknown
}

export interface HermesStatusPayload {
  version?: string
  gateway_running?: boolean
  gateway_state?: string
  active_sessions?: number
  model?: string
  provider?: string
  [key: string]: unknown
}
