import { type CronJob, rest } from '../lib/rest.ts'
import { $chats, interruptChat } from './chat.ts'
import { notify } from './notifications.ts'

export interface PauseAllResult {
  interrupted: number
  paused: number
  failures: string[]
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Interrupt every streaming session and pause every enabled automation. Shared by Settings and voice. */
export async function pauseAllAgents(): Promise<PauseAllResult> {
  const streaming = Object.values($chats.get()).filter(chat => chat.streaming)
  let interrupted = 0
  let paused = 0
  const failures: string[] = []

  await Promise.all(
    streaming.map(async chat => {
      try {
        await interruptChat(chat.sessionId)
        interrupted++
      } catch (error) {
        failures.push(`${chat.title || chat.sessionId}: ${errorText(error)}`)
      }
    })
  )

  try {
    const jobs = await rest.get<CronJob[]>('/api/cron/jobs')
    const active = (Array.isArray(jobs) ? jobs : []).filter(job => job.enabled !== false && job.state !== 'paused')

    await Promise.all(
      active.map(async job => {
        try {
          await rest.post(`/api/cron/jobs/${encodeURIComponent(job.id)}/pause`, undefined, job.profile ? { profile: job.profile } : undefined)
          paused++
        } catch (error) {
          failures.push(`${job.name || job.id}: ${errorText(error)}`)
        }
      })
    )
  } catch (error) {
    failures.push(`Scheduled tasks: ${errorText(error)}`)
  }

  notify({
    title: failures.length ? 'Paused with errors' : 'All agents paused',
    body: `${interrupted} running ${interrupted === 1 ? 'session' : 'sessions'} interrupted, ${paused} scheduled ${paused === 1 ? 'task' : 'tasks'} paused.${failures.length ? ` ${failures.length} failed.` : ''}`,
    level: failures.length ? 'warn' : 'success'
  })

  return { interrupted, paused, failures }
}
