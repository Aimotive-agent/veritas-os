import { IconMessageChatbot, IconPlus, IconSparkles, IconX } from '@tabler/icons-react'
import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'
import { HERALD_EVENTS, type HeraldEventName } from '../../../shared/events.ts'
import { Chips, GlassButton, GlassCard } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import { $agentPages, bindAgentPages } from '../../store/agent-pages.ts'
import { notify } from '../../store/notifications.ts'
import { sendPrompt } from '../../store/chat.ts'
import { showPage } from '../../store/windows.ts'
import type { CronJobDraft, DeliveryTarget } from './api.ts'
import { SCHEDULE_FORMATS_HINT, SCHEDULE_PLACEHOLDER, humanizeCronExpr } from './cron-humanize.ts'
import { FieldLabel, GlyphTile, Hint, SelectInput, TextArea, TextInput, isLocalDelivery } from './presentation.tsx'

const DESCRIBE_PROMPT = 'Help me set up a new scheduled automation. Ask me what it should do and when, then create it with the cronjob tool.'

/** Runs on an event instead of a schedule; the page turns it into a paused job plus a rule. */
export interface EventTrigger {
  event: HeraldEventName
  match?: Record<string, string>
}

const TRIGGER_MODES = [
  { id: 'schedule', label: 'On a schedule' },
  { id: 'event', label: 'When something happens' }
] as const

const EVENT_CHOICES = HERALD_EVENTS.filter(event => event.automation)

/** Events that can be narrowed down, and the detail they match on. */
const MATCHES: Partial<Record<HeraldEventName, { key: string; label: string; placeholder: string }>> = {
  crash: { key: 'app', label: 'Which program (optional)', placeholder: 'Any program' },
  'network-change': { key: 'wifi', label: 'Wi-Fi network (optional)', placeholder: 'Any network' }
}

/** Inline "New automation" form shown in the detail column. */
export function NewAutomationForm({ targets, creating, onCreate, onCancel }: { targets: readonly DeliveryTarget[]; creating: boolean; onCreate: (draft: CronJobDraft, trigger?: EventTrigger) => Promise<boolean>; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [mode, setMode] = useState<'schedule' | 'event'>('schedule')
  const [schedule, setSchedule] = useState('')
  const [event, setEvent] = useState<HeraldEventName>('login')
  const [matchValue, setMatchValue] = useState('')
  const [prompt, setPrompt] = useState('')
  const [deliver, setDeliver] = useState('local')
  const [agentId, setAgentId] = useState('hermes')
  bindAgentPages()
  const extraAgents = useStore($agentPages)
  // Only agents that know how to run a prompt can take an automation; Hermes always can.
  const runAgents = [
    { id: 'hermes', name: 'Hermes' },
    ...extraAgents.filter(agent => agent.canRun).map(agent => ({ id: agent.id, name: agent.name }))
  ]
  const shellOwned = agentId !== 'hermes'

  // A schedule the shell owns needs a cron line; an event trigger is Hermes' job.
  useEffect(() => {
    if (shellOwned && mode === 'event') {
      setMode('schedule')
    }
  }, [shellOwned, mode])

  const canCreate = (mode === 'event' || schedule.trim().length > 0) && prompt.trim().length > 0 && !creating
  const preview = humanizeCronExpr(schedule.trim())
  const matcher = MATCHES[event]

  const submit = async () => {
    if (!canCreate) {
      return
    }

    const draft = { name: name.trim(), schedule: schedule.trim(), prompt: prompt.trim(), deliver }

    // Another agent means the shell owns the schedule and hands it the prompt when it fires.
    if (shellOwned) {
      await window.heraldOS.shellAutomations.create({ name: draft.name, schedule: draft.schedule, agentId, prompt: draft.prompt })

      notify({ title: 'Automation created', body: `Runs on ${runAgents.find(a => a.id === agentId)?.name ?? agentId} — see Scheduler below.`, level: 'success' })
      onCancel()

      return
    }

    await (mode === 'event' ? onCreate(draft, { event, match: matcher && matchValue.trim() ? { [matcher.key]: matchValue.trim() } : undefined }) : onCreate(draft))
  }

  return (
    <GlassCard className="flex h-full min-h-0 flex-col">
      <div className="flex items-start gap-3.5 px-5 pt-5 pb-4">
        <GlyphTile icon={<IconSparkles />} size={44} />
        <div className="min-w-0 flex-1">
          <h2 className="text-[18px] leading-tight font-semibold text-fg">New automation</h2>
          <p className="mt-1 text-[12.5px] text-fg-3">Tell Hermes what to do and when. It runs even while you are away.</p>
        </div>
        <GlassButton size="icon" variant="ghost" onClick={onCancel} aria-label="Close new automation form" className="-mt-1 -mr-2">
          <IconX />
        </GlassButton>
      </div>

      <form
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-4"
        onSubmit={event => {
          event.preventDefault()
          void submit()
        }}
      >
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="new-automation-name">Name</FieldLabel>
          <TextInput id="new-automation-name" value={name} onChange={e => setName(e.target.value)} placeholder="Morning briefing" autoFocus />
        </div>

        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="new-automation-schedule">When</FieldLabel>
          <Chips items={TRIGGER_MODES} value={mode} onChange={setMode} className="self-start" />
          {mode === 'schedule' ? (
            <>
              <TextInput id="new-automation-schedule" value={schedule} onChange={e => setSchedule(e.target.value)} placeholder={SCHEDULE_PLACEHOLDER} required />
              <Hint>
                {preview ? (
                  <span className="text-accent-strong">{preview}</span>
                ) : (
                  <>
                    Accepted: {SCHEDULE_FORMATS_HINT}.
                  </>
                )}
              </Hint>
            </>
          ) : (
            <>
              <SelectInput id="new-automation-schedule" value={event} onChange={e => setEvent(e.target.value as HeraldEventName)}>
                {EVENT_CHOICES.map(choice => (
                  <option key={choice.name} value={choice.name}>
                    {choice.label}
                  </option>
                ))}
              </SelectInput>
              {matcher && <TextInput aria-label={matcher.label} value={matchValue} onChange={e => setMatchValue(e.target.value)} placeholder={matcher.placeholder} />}
              <Hint>Hermes runs it each time this happens on this computer while Veritas OS is open.</Hint>
            </>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="new-automation-prompt">What Hermes should do</FieldLabel>
          <TextArea id="new-automation-prompt" value={prompt} onChange={e => setPrompt(e.target.value)} rows={6} placeholder="Gather my calendar, priority mail and active missions, then write a short briefing for the day." required />
        </div>

        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="new-automation-deliver">Deliver to</FieldLabel>
          <SelectInput id="new-automation-deliver" value={deliver} onChange={e => setDeliver(e.target.value)}>
            {targets.map(target => (
              <option key={target.id} value={target.id} disabled={target.home_target_set === false}>
                {target.name}
                {target.home_target_set === false ? ' (set a home channel first)' : ''}
              </option>
            ))}
          </SelectInput>
          <Hint>{isLocalDelivery(deliver) ? 'Results are saved as a briefing you can open in Hermes.' : 'Hermes posts the result to the platform’s home channel when the run finishes.'}</Hint>
        </div>
        <div className="flex flex-col gap-1.5">
          <FieldLabel>Run with</FieldLabel>
          <div className="flex flex-wrap items-center gap-2">
            {runAgents.map(candidate => {
              const active = candidate.id === agentId

              return (
                <button
                  key={candidate.id}
                  type="button"
                  onClick={() => setAgentId(candidate.id)}
                  className={cn(
                    'rounded-full border px-3 py-1 text-[12px] transition-colors',
                    active ? 'border-accent-strong/60 bg-accent text-accent-fg' : 'border-line bg-white/5 text-fg-2 hover:bg-white/10 hover:text-fg'
                  )}
                >
                  {candidate.name}
                </button>
              )
            })}
          </div>
          <Hint>
            {shellOwned
              ? `The shell runs this on ${runAgents.find(a => a.id === agentId)?.name ?? agentId} when the schedule fires.`
              : 'Hermes runs it and can deliver the result anywhere.'}
          </Hint>
        </div>
      </form>

      <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3.5">
        <GlassButton
          variant="secondary"
          onClick={() => {
            showPage('hermes')
            void sendPrompt(DESCRIBE_PROMPT)
          }}
        >
          <IconMessageChatbot />
          Describe it to Hermes
        </GlassButton>
        <GlassButton variant="primary" disabled={!canCreate} onClick={() => void submit()} aria-label="Create automation">
          <IconPlus />
          {creating ? 'Creating…' : 'Create'}
        </GlassButton>
      </div>
    </GlassCard>
  )
}
