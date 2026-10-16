import { type CronJob, rest } from '../../lib/rest.ts'
import { scheduleToString } from './cron-humanize.ts'

/*
 * Thin typed wrappers over the Hermes cron REST (hermes_cli/web_routers/cron.py). The page owns
 * these locally; `CronJob` itself comes from lib/rest.ts.
 */

/** A run session row from GET /api/cron/jobs/{id}/runs (same shape as /api/sessions rows). */
export interface CronRun {
  id: string
  started_at?: number | null
  ended_at?: number | null
  last_active?: number | null
  title?: string | null
  message_count?: number | null
  end_reason?: string | null
  is_active?: boolean
  profile?: string | null
  [key: string]: unknown
}

export interface DeliveryTarget {
  id: string
  name: string
  home_target_set?: boolean
  home_env_var?: string | null
}

/** Fields the detail editor and the New form can write. */
export interface CronJobEdits {
  name?: string
  schedule?: string
  prompt?: string
  deliver?: string
}

export interface CronJobDraft {
  name: string
  schedule: string
  prompt: string
  deliver: string
  skills?: string[]
  no_agent?: boolean
  script?: string | null
}

export const LOCAL_TARGET: DeliveryTarget = { id: 'local', name: 'Hermes (local)', home_target_set: true, home_env_var: null }

const profileQuery = (job: Pick<CronJob, 'profile'>) => (job.profile ? { profile: job.profile } : undefined)

const jobPath = (job: Pick<CronJob, 'id'>) => `/api/cron/jobs/${encodeURIComponent(job.id)}`

export const cronApi = {
  list: () => rest.get<CronJob[]>('/api/cron/jobs'),

  runs: async (job: Pick<CronJob, 'id' | 'profile'>, limit = 10): Promise<CronRun[]> => {
    const result = await rest.get<{ runs?: CronRun[] } | CronRun[]>(`${jobPath(job)}/runs`, { ...(profileQuery(job) ?? {}), limit: String(limit) })

    return Array.isArray(result) ? result : (result?.runs ?? [])
  },

  deliveryTargets: async (): Promise<DeliveryTarget[]> => {
    const result = await rest.get<{ targets?: DeliveryTarget[] }>('/api/cron/delivery-targets')
    const targets = (result?.targets ?? []).filter(t => t.id !== 'local')

    return [LOCAL_TARGET, ...targets]
  },

  pause: (job: CronJob) => rest.post<CronJob>(`${jobPath(job)}/pause`, undefined, profileQuery(job)),
  resume: (job: CronJob) => rest.post<CronJob>(`${jobPath(job)}/resume`, undefined, profileQuery(job)),
  trigger: (job: CronJob) => rest.post<unknown>(`${jobPath(job)}/trigger`, undefined, profileQuery(job)),
  remove: (job: CronJob) => rest.del<unknown>(jobPath(job), profileQuery(job)),

  /** PUT body is `{ updates: {...} }` (CronJobUpdate); `schedule` is a plain string the backend re-parses. */
  update: (job: CronJob, updates: CronJobEdits) => rest.put<CronJob>(jobPath(job), { updates }, profileQuery(job)),

  create: (draft: CronJobDraft, profile?: string | null) =>
    rest.post<CronJob>(
      '/api/cron/jobs',
      {
        name: draft.name,
        schedule: draft.schedule,
        prompt: draft.prompt,
        deliver: draft.deliver || 'local',
        skills: draft.skills?.length ? draft.skills : undefined,
        no_agent: draft.no_agent ?? false,
        script: draft.script ?? undefined
      },
      profile ? { profile } : undefined
    ),

  duplicate: (job: CronJob) =>
    cronApi.create(
      {
        name: `${job.name || 'Automation'} copy`,
        schedule: scheduleToString(job),
        prompt: job.prompt ?? '',
        deliver: job.deliver ?? 'local',
        skills: job.skills,
        no_agent: typeof job.no_agent === 'boolean' ? job.no_agent : undefined,
        script: typeof job.script === 'string' ? job.script : undefined
      },
      job.profile
    )
}

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export const isPaused = (job: CronJob): boolean => job.state === 'paused' || job.enabled === false

export const isFailedStatus = (status: string | null | undefined): boolean => /error|fail/i.test(status ?? '')

export const jobKey = (job: Pick<CronJob, 'id' | 'profile'>): string => `${job.profile ?? ''}:${job.id}`
