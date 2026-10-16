import { IconCheck, IconList, IconPlayerPause } from '@tabler/icons-react'
import { useState } from 'react'
import { GlassButton, Pill } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import { interruptChat, openStoredSession } from '../../store/chat.ts'
import { markReviewed, type Mission, type MissionStep } from '../../store/missions.ts'
import { notify } from '../../store/notifications.ts'
import { showPage } from '../../store/windows.ts'
import { formatStamp, genericSteps, STATUS_LABEL, STATUS_TONE } from './mission-helpers.ts'
import { MissionPreview } from './MissionPreview.tsx'

export function MissionDetail({ mission }: { mission: Mission }) {
  const [busy, setBusy] = useState<'pause' | 'open' | null>(null)
  const steps = mission.steps.length > 0 ? mission.steps : genericSteps(mission)
  const canPause = mission.live && mission.status === 'active' && Boolean(mission.runtimeId)

  const pause = async () => {
    setBusy('pause')

    try {
      await interruptChat(mission.runtimeId)
    } catch (error) {
      notify({ title: 'Could not pause mission', body: error instanceof Error ? error.message : String(error), level: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const viewActivity = async () => {
    setBusy('open')

    try {
      await openStoredSession(mission.id)
      markReviewed(mission.id)
      showPage('hermes')
    } catch (error) {
      notify({ title: 'Could not open mission', body: error instanceof Error ? error.message : String(error), level: 'error' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex min-h-full flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <h2 className="min-w-0 text-[18px] leading-tight font-semibold text-fg">{mission.title}</h2>
        <Pill tone={STATUS_TONE[mission.status]} className="mt-0.5 shrink-0">
          {STATUS_LABEL[mission.status]}
        </Pill>
      </div>

      <div>
        <div className="mb-1 text-[10.5px] tracking-[0.08em] text-fg-3 uppercase">Goal</div>
        <p className="selectable text-[13px] leading-relaxed text-fg-2">{mission.goal || 'No goal recorded for this session.'}</p>
      </div>

      <StepTimeline steps={steps} mission={mission} />

      <MissionPreview artifact={mission.artifacts[0]} />

      <div className="mt-auto flex items-center justify-between gap-2 pt-2">
        <GlassButton size="sm" onClick={() => void pause()} disabled={!canPause || busy === 'pause'} aria-label="Pause mission">
          <IconPlayerPause />
          Pause mission
        </GlassButton>
        <GlassButton size="sm" onClick={() => void viewActivity()} disabled={busy === 'open'} aria-label="View activity">
          <IconList />
          View activity
        </GlassButton>
      </div>
    </div>
  )
}

function StepTimeline({ steps, mission }: { steps: MissionStep[]; mission: Mission }) {
  return (
    <ol className="stagger relative flex flex-col gap-4 before:absolute before:top-3 before:bottom-3 before:left-[9px] before:w-px before:bg-line" aria-label="Mission steps">
      {steps.map(step => (
        <li key={step.id} className="flex items-start gap-3">
          <StepMarker state={step.state} />
          <div className="min-w-0 flex-1">
            <div className={cn('text-[13px] leading-5', step.state === 'pending' ? 'text-fg-2' : 'text-fg')}>{step.label}</div>
            <div className="truncate text-[12px] text-fg-3">{stepDetail(step, mission)}</div>
          </div>
          {step.state === 'done' && <span className="shrink-0 pt-0.5 text-[11.5px] text-fg-4 tabular-nums">{formatStamp(mission.updatedAt)}</span>}
          {step.state === 'active' && <span className="shrink-0 pt-0.5 text-[12px] text-fg-2 tabular-nums">{mission.progress}%</span>}
        </li>
      ))}
    </ol>
  )
}

function stepDetail(step: MissionStep, mission: Mission): string {
  if (step.detail) {
    return step.detail
  }

  switch (step.state) {
    case 'done':
      return 'Completed'
    case 'active':
      return mission.currentStep && mission.currentStep !== step.label ? `In progress · ${mission.currentStep}` : 'In progress'
    default:
      return 'Waiting'
  }
}

function StepMarker({ state }: { state: MissionStep['state'] }) {
  if (state === 'done') {
    return (
      <span className="relative z-10 mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-ok text-accent-fg shadow-[0_0_10px_currentColor]">
        <IconCheck size={12} stroke={3} />
      </span>
    )
  }

  if (state === 'active') {
    return (
      <span className="relative z-10 mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-accent-strong bg-black/30 shadow-[0_0_10px_rgba(47,125,255,.5)]">
        <span className="size-2 rounded-full bg-accent-strong animate-pulse-soft" />
      </span>
    )
  }

  return <span className="relative z-10 mt-0.5 size-5 shrink-0 rounded-full border border-line-strong bg-black/25" />
}
