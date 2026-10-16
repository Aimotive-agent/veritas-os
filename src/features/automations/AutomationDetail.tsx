import { useStore } from '@nanostores/react'
import { IconBell, IconBolt, IconCalendar, IconClock, IconDatabase, IconDeviceFloppy, IconFileText, IconPencil, IconPlayerPlay } from '@tabler/icons-react'
import { type ReactNode, useEffect, useState } from 'react'
import { describeRule, type EventAutomation, HERALD_EVENTS, type HeraldEventName } from '../../../shared/events.ts'
import { GlassButton, GlassCard, Pill, Toggle } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import { formatRelative } from '../../lib/format.ts'
import type { CronJob } from '../../lib/rest.ts'
import { eventRuleFor, updateEventRule } from '../../store/automations.ts'
import { $prefs } from '../../store/backend.ts'
import { type CronJobEdits, type CronRun, type DeliveryTarget, isFailedStatus, isPaused } from './api.ts'
import { SCHEDULE_FORMATS_HINT, SCHEDULE_PLACEHOLDER, formatRunDuration, humanizeSchedule, localTimezoneCity, scheduleToString, toMs } from './cron-humanize.ts'
import { JobMenu, type JobMenuAction } from './JobMenu.tsx'
import { FieldLabel, GlyphTile, Hint, JobTile, SelectInput, TextArea, TextInput, describeDeliver, describeGather, describeJob, isLocalDelivery } from './presentation.tsx'

type StepId = 'when' | 'gather' | 'deliver'

const NOTIFY_KEY = (id: string) => `herald-os.automation-notify.${id}`

const readNotifyPref = (id: string): boolean => {
  try {
    return localStorage.getItem(NOTIFY_KEY(id)) !== 'false'
  } catch {
    return true
  }
}

const writeNotifyPref = (id: string, value: boolean) => {
  try {
    localStorage.setItem(NOTIFY_KEY(id), value ? 'true' : 'false')
  } catch {
    // Preference storage is best effort.
  }
}

export interface AutomationDetailProps {
  job: CronJob
  targets: readonly DeliveryTarget[]
  /** Latest run session, when the page has fetched history for this job. */
  lastRun?: CronRun
  saving: boolean
  onSave: (edits: CronJobEdits) => Promise<boolean>
  onAction: (action: JobMenuAction) => void
}

/** Right column: header, the numbered When / Gather / Deliver step editor, notify row and footer actions. */
export function AutomationDetail({ job, targets, lastRun, saving, onSave, onAction }: AutomationDetailProps) {
  const [edits, setEdits] = useState<CronJobEdits>({})
  const [editing, setEditing] = useState<StepId | null>(null)
  const [notifyPref, setNotifyPref] = useState(() => readNotifyPref(job.id))

  // A different job resets local drafts; a refresh of the same job keeps unsaved typing.
  useEffect(() => {
    setEdits({})
    setEditing(null)
    setNotifyPref(readNotifyPref(job.id))
  }, [job.id])

  useStore($prefs)
  const rule = eventRuleFor(job.id)
  const paused = rule ? !rule.enabled : isPaused(job)
  const currentSchedule = edits.schedule ?? scheduleToString(job)
  const currentPrompt = edits.prompt ?? job.prompt ?? ''
  const currentDeliver = edits.deliver ?? job.deliver ?? 'local'
  const dirty = Object.keys(edits).length > 0

  const previewJob: CronJob = { ...job, prompt: currentPrompt, deliver: currentDeliver }

  const setField = <K extends keyof CronJobEdits>(key: K, value: CronJobEdits[K]) => {
    setEdits(prev => {
      const original = key === 'schedule' ? scheduleToString(job) : key === 'prompt' ? (job.prompt ?? '') : key === 'deliver' ? (job.deliver ?? 'local') : (job.name ?? '')

      if (value === original) {
        return omit(prev, key)
      }

      return { ...prev, [key]: value }
    })
  }

  const saveStep = async (key: keyof CronJobEdits) => {
    const value = edits[key]

    if (value === undefined) {
      setEditing(null)

      return
    }

    const ok = await onSave({ [key]: value })

    if (ok) {
      setEdits(prev => omit(prev, key))
      setEditing(null)
    }
  }

  const cancelStep = (key: keyof CronJobEdits) => {
    setEdits(prev => omit(prev, key))
    setEditing(null)
  }

  const saveAll = async () => {
    const ok = await onSave(edits)

    if (ok) {
      setEdits({})
      setEditing(null)
    }
  }

  const whenSummary = rule ? describeRule(rule) : `${edits.schedule !== undefined ? capitalize(edits.schedule) : humanizeSchedule(job)} · ${localTimezoneCity()}`
  const selectableTargets = targets.some(t => t.id === currentDeliver) ? targets : [...targets, { id: currentDeliver, name: currentDeliver }]

  return (
    <GlassCard className="flex h-full min-h-0 flex-col">
      <div className="flex items-start gap-3.5 px-5 pt-5 pb-4">
        <JobTile job={job} size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <h2 className="truncate text-[18px] leading-tight font-semibold text-fg">{job.name || 'Untitled automation'}</h2>
            <Pill tone={job.state === 'error' ? 'danger' : paused ? 'muted' : 'ok'}>{job.state === 'error' ? 'Error' : paused ? (rule ? 'Off' : 'Paused') : 'Active'}</Pill>
          </div>
          <p className="mt-1 text-[12.5px] text-fg-3">{describeJob(previewJob)}</p>
        </div>
        <JobMenu jobName={job.name || 'automation'} onAction={onAction} className="-mt-1 -mr-2" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pb-4">
        <ol className="relative flex flex-col gap-3">
          <span aria-hidden="true" className="absolute top-8 bottom-8 left-[13px] w-px bg-line" />

          <Step
            index={1}
            icon={rule ? <IconBolt /> : <IconCalendar />}
            title="When"
            summary={whenSummary}
            editing={editing === 'when'}
            onEdit={() => setEditing(editing === 'when' ? null : 'when')}
          >
            {rule ? (
              <EventRuleEditor rule={rule} onDone={() => setEditing(null)} />
            ) : (
              <>
                <FieldLabel htmlFor="automation-schedule">Schedule</FieldLabel>
                <TextInput
                  id="automation-schedule"
                  value={currentSchedule}
                  autoFocus
                  placeholder={SCHEDULE_PLACEHOLDER}
                  onChange={e => setField('schedule', e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      void saveStep('schedule')
                    }
                  }}
                />
                <Hint>Accepted: {SCHEDULE_FORMATS_HINT}.</Hint>
                <StepActions disabled={saving || edits.schedule === undefined} onSave={() => void saveStep('schedule')} onCancel={() => cancelStep('schedule')} />
              </>
            )}
          </Step>

          <Step
            index={2}
            icon={<IconDatabase />}
            title="Gather"
            summary={describeGather(previewJob)}
            editing={editing === 'gather'}
            onEdit={() => setEditing(editing === 'gather' ? null : 'gather')}
          >
            <FieldLabel htmlFor="automation-prompt">What Hermes should do</FieldLabel>
            <TextArea id="automation-prompt" value={currentPrompt} autoFocus rows={5} placeholder="Describe what to gather and produce each run…" onChange={e => setField('prompt', e.target.value)} />
            <StepActions disabled={saving || edits.prompt === undefined} onSave={() => void saveStep('prompt')} onCancel={() => cancelStep('prompt')} />
          </Step>

          <Step
            index={3}
            icon={<IconFileText />}
            title="Deliver"
            summary={describeDeliver(currentDeliver, targets)}
            editing={editing === 'deliver'}
            onEdit={() => setEditing(editing === 'deliver' ? null : 'deliver')}
          >
            <FieldLabel htmlFor="automation-deliver">Deliver to</FieldLabel>
            <SelectInput id="automation-deliver" value={currentDeliver} onChange={e => setField('deliver', e.target.value)}>
              {selectableTargets.map(target => (
                <option key={target.id} value={target.id} disabled={target.home_target_set === false}>
                  {target.name}
                  {target.home_target_set === false ? ' (set a home channel first)' : ''}
                </option>
              ))}
            </SelectInput>
            <Hint>{isLocalDelivery(currentDeliver) ? 'Results are saved as a briefing you can open in Hermes.' : 'Hermes posts the result to the platform’s home channel when the run finishes.'}</Hint>
            <StepActions disabled={saving || edits.deliver === undefined} onSave={() => void saveStep('deliver')} onCancel={() => cancelStep('deliver')} />
          </Step>
        </ol>

        <GlassCard className="flex items-center gap-3.5 px-4 py-3">
          <IconBell size={20} className="shrink-0 text-fg-2" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-fg">Notify me when ready</div>
            <div className="text-[12px] text-fg-3">Get a system notification when the automation has completed.</div>
          </div>
          <Toggle
            checked={notifyPref}
            label="Notify me when this automation completes"
            onChange={value => {
              setNotifyPref(value)
              writeNotifyPref(job.id, value)
            }}
          />
        </GlassCard>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-2 text-[12px] text-fg-3">
          <IconClock size={15} className="shrink-0" aria-hidden="true" />
          <span className="truncate">{lastRunSummary(job, lastRun)}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <GlassButton onClick={() => onAction('trigger')} aria-label="Run now">
            <IconPlayerPlay />
            Run now
          </GlassButton>
          <GlassButton variant="primary" disabled={!dirty || saving} onClick={() => void saveAll()} aria-label="Save changes">
            <IconDeviceFloppy />
            {saving ? 'Saving…' : 'Save changes'}
          </GlassButton>
        </div>
      </div>
    </GlassCard>
  )
}

function Step({ index, icon, title, summary, editing, onEdit, children }: { index: number; icon: ReactNode; title: string; summary: string; editing: boolean; onEdit: () => void; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span aria-hidden="true" className="relative z-10 mt-5 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-[12px] font-semibold text-accent-fg shadow-[0_0_12px_rgba(47,125,255,.5)]">
        {index}
      </span>
      <GlassCard className={cn('min-w-0 flex-1 p-3.5', editing && 'glass-card-selected')}>
        <div className="flex items-center gap-3">
          <GlyphTile icon={icon} size={40} />
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-semibold text-fg">{title}</div>
            <div className="truncate text-[12.5px] text-fg-3" title={summary}>
              {summary}
            </div>
          </div>
          <GlassButton size="sm" variant={editing ? 'ghost' : 'secondary'} onClick={onEdit} aria-label={editing ? `Close ${title} editor` : `Edit ${title}`} aria-expanded={editing}>
            <IconPencil />
            {editing ? 'Close' : 'Edit'}
          </GlassButton>
        </div>
        {editing && <div className="animate-rise mt-3 flex flex-col gap-2 border-t border-line pt-3">{children}</div>}
      </GlassCard>
    </li>
  )
}

/** The event an automation waits for (and the program or network it narrows to). */
function EventRuleEditor({ rule, onDone }: { rule: EventAutomation; onDone: () => void }) {
  const [event, setEvent] = useState<HeraldEventName>(rule.event)
  const matchKey = event === 'crash' ? 'app' : event === 'network-change' ? 'wifi' : null
  const [matchValue, setMatchValue] = useState(matchKey ? (rule.match?.[matchKey] ?? '') : '')
  const [saving, setSaving] = useState(false)
  const changed = event !== rule.event || (matchKey ? matchValue.trim() !== (rule.match?.[matchKey] ?? '') : false)

  const save = async () => {
    setSaving(true)

    try {
      await updateEventRule(rule.jobId, { event, match: matchKey && matchValue.trim() ? { [matchKey]: matchValue.trim() } : undefined })
      onDone()
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <FieldLabel htmlFor="automation-event">When this happens</FieldLabel>
      <SelectInput id="automation-event" value={event} onChange={e => setEvent(e.target.value as HeraldEventName)}>
        {HERALD_EVENTS.filter(choice => choice.automation).map(choice => (
          <option key={choice.name} value={choice.name}>
            {choice.label}
          </option>
        ))}
      </SelectInput>
      {matchKey && <TextInput aria-label={matchKey === 'app' ? 'Which program' : 'Which Wi-Fi network'} value={matchValue} onChange={e => setMatchValue(e.target.value)} placeholder={matchKey === 'app' ? 'Any program' : 'Any network'} />}
      <StepActions disabled={saving || !changed} onSave={() => void save()} onCancel={onDone} />
    </>
  )
}

function StepActions({ disabled, onSave, onCancel }: { disabled: boolean; onSave: () => void; onCancel: () => void }) {
  return (
    <div className="flex items-center justify-end gap-2 pt-1">
      <GlassButton size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </GlassButton>
      <GlassButton size="sm" variant="primary" disabled={disabled} onClick={onSave}>
        Save
      </GlassButton>
    </div>
  )
}

function lastRunSummary(job: CronJob, lastRun: CronRun | undefined): string {
  const lastMs = toMs(job.last_run_at)
  const failed = isFailedStatus(job.last_status)
  const started = toMs(lastRun?.started_at)
  const ended = toMs(lastRun?.ended_at)

  if (lastRun?.is_active) {
    return 'Running now…'
  }

  if (started !== undefined && ended !== undefined && ended >= started) {
    const duration = formatRunDuration((ended - started) / 1000)

    return failed ? `Last run failed after ${duration}` : `Last run completed in ${duration}`
  }

  if (lastMs === undefined) {
    return 'Not run yet'
  }

  const status = failed ? 'failed' : job.last_status ? job.last_status.replace(/[_-]/g, ' ') : 'completed'

  return `Last run: ${formatRelative(lastMs)} · ${status}`
}

const capitalize = (text: string): string => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text)

function omit(edits: CronJobEdits, key: keyof CronJobEdits): CronJobEdits {
  const next = { ...edits }
  delete next[key]

  return next
}
