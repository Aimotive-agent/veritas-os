import { describeRule, EVENT_RULE_SCHEDULE, type EventAutomation, type HeraldEventName } from '../../shared/events.ts'
import type { CronJob } from '../lib/rest.ts'
import { type CronJobDraft, cronApi, errorText, isPaused } from '../features/automations/api.ts'
import { $prefs, updatePrefs } from './backend.ts'
import { notify } from './notifications.ts'

/*
 * Automation (cron job) mutations shared by the Automations page, the command registry and the
 * agent. The backend emits `cron.changed` after every write, which the page already listens to, so
 * callers do not need to refresh anything here.
 */

const toast = (title: string, body: string, level: 'success' | 'error' | 'info' = 'success') => notify({ title, body, level, surface: 'automations' })

const nameOf = (job: CronJob) => job.name || 'Automation'

export function listAutomations(): Promise<CronJob[]> {
  return cronApi.list()
}

/** Case-insensitive lookup by name (exact first, then contains); null when nothing or too many match. */
export async function findAutomation(query: string): Promise<{ job: CronJob | null; candidates: CronJob[] }> {
  const needle = query.trim().toLowerCase()
  const jobs = await listAutomations()

  if (!needle) {
    return { job: null, candidates: jobs }
  }

  const exact = jobs.filter(job => (job.name ?? '').toLowerCase() === needle)

  if (exact.length === 1) {
    return { job: exact[0], candidates: exact }
  }

  const partial = jobs.filter(job => (job.name ?? '').toLowerCase().includes(needle) || (job.prompt ?? '').toLowerCase().includes(needle))

  return { job: partial.length === 1 ? partial[0] : null, candidates: partial }
}

/** The event rule behind an automation that runs when something happens, if it is one. */
export function eventRuleFor(jobId: string | undefined): EventAutomation | undefined {
  return jobId ? ($prefs.get().eventAutomations ?? []).find(rule => rule.jobId === jobId) : undefined
}

async function writeRules(next: EventAutomation[]): Promise<void> {
  await updatePrefs({ eventAutomations: next })
}

/** An automation that runs when `event` happens: a paused cron job (Hermes keeps its runs) plus the rule. */
export async function createEventAutomation(draft: Omit<CronJobDraft, 'schedule'>, event: HeraldEventName, match?: Record<string, string>, profile?: string | null): Promise<CronJob> {
  const created = await cronApi.create({ ...draft, schedule: EVENT_RULE_SCHEDULE }, profile)
  await cronApi.pause(created)
  const cleanMatch = Object.fromEntries(Object.entries(match ?? {}).filter(([, value]) => value.trim()))
  const rule: EventAutomation = { event, jobId: created.id, enabled: true, ...(Object.keys(cleanMatch).length ? { match: cleanMatch } : {}) }
  await writeRules([...($prefs.get().eventAutomations ?? []).filter(entry => entry.jobId !== created.id), rule])
  toast(nameOf(created), `Created: ${describeRule(rule).replace(/^When/, 'runs when')}`)

  return created
}

export async function setAutomationEnabled(job: CronJob, enabled: boolean): Promise<void> {
  const rule = eventRuleFor(job.id)

  try {
    if (rule) {
      // The cron job stays paused either way; the rule decides whether the event fires it.
      await writeRules(($prefs.get().eventAutomations ?? []).map(entry => (entry.jobId === job.id ? { ...entry, enabled } : entry)))
    } else {
      await (enabled ? cronApi.resume(job) : cronApi.pause(job))
    }

    toast(nameOf(job), enabled ? (rule ? 'On' : 'Resumed') : rule ? 'Off' : 'Paused')
  } catch (error) {
    toast(enabled ? 'Could not resume' : 'Could not pause', errorText(error), 'error')
    throw error
  }
}

export async function triggerAutomation(job: CronJob): Promise<void> {
  try {
    await cronApi.trigger(job)

    // Firing a paused job resumes it; an event automation goes straight back to waiting.
    if (eventRuleFor(job.id)) {
      await cronApi.pause(job).catch(() => undefined)
    }

    toast(nameOf(job), 'Run started')
  } catch (error) {
    toast('Run failed', errorText(error), 'error')
    throw error
  }
}

/** Change which event (and which program or network) an event automation waits for. */
export async function updateEventRule(jobId: string, patch: Pick<EventAutomation, 'event'> & { match?: Record<string, string> }): Promise<void> {
  const match = Object.fromEntries(Object.entries(patch.match ?? {}).filter(([, value]) => value.trim()))
  await writeRules(($prefs.get().eventAutomations ?? []).map(entry => (entry.jobId === jobId ? { event: patch.event, jobId, enabled: entry.enabled, ...(Object.keys(match).length ? { match } : {}) } : entry)))
}

/** Whether an automation is on: its rule for event automations, the cron state for scheduled ones. */
export function automationEnabled(job: CronJob): boolean {
  const rule = eventRuleFor(job.id)

  return rule ? rule.enabled : !isPaused(job)
}

export async function duplicateAutomation(job: CronJob): Promise<CronJob | null> {
  try {
    const created = await cronApi.duplicate(job)
    toast(nameOf(job), 'Duplicated')

    return created ?? null
  } catch (error) {
    toast('Duplicate failed', errorText(error), 'error')
    throw error
  }
}

export async function deleteAutomation(job: CronJob): Promise<void> {
  try {
    await cronApi.remove(job)

    if (eventRuleFor(job.id)) {
      await writeRules(($prefs.get().eventAutomations ?? []).filter(entry => entry.jobId !== job.id))
    }

    toast(nameOf(job), 'Deleted', 'info')
  } catch (error) {
    toast('Delete failed', errorText(error), 'error')
    throw error
  }
}

export async function createAutomation(draft: CronJobDraft, profile?: string | null): Promise<CronJob> {
  try {
    const created = await cronApi.create(draft, profile)
    toast(draft.name || 'Automation', 'Created')

    return created
  } catch (error) {
    toast('Could not create automation', errorText(error), 'error')
    throw error
  }
}

export { isPaused }
