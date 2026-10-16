import { IconDatabase, IconDownload, IconEye, IconFileText, IconRefresh, IconSunrise, type IconProps } from '@tabler/icons-react'
import type React from 'react'
import { cn } from '../../lib/cn.ts'
import type { CronJob } from '../../lib/rest.ts'
import type { DeliveryTarget } from './api.ts'

/*
 * Presentation-only derivations for the Automations page: which glyph a job gets, how its prompt is
 * summarised into the step editor, and the shared icon tile / field chrome.
 */

type TablerIcon = React.ComponentType<IconProps>

const ICON_RULES: readonly { pattern: RegExp; icon: TablerIcon }[] = [
  { pattern: /brief|morning|wake|start of day|daily digest/i, icon: IconSunrise },
  { pattern: /digest|report|summary|summar|recap|weekly|review/i, icon: IconFileText },
  { pattern: /download|organi[sz]e|clean|tidy|sort|archive/i, icon: IconDownload },
  { pattern: /backup|back up|snapshot|sync|export/i, icon: IconDatabase },
  { pattern: /check|monitor|watch|alert|health|status|ping/i, icon: IconEye }
]

export function iconForJob(job: Pick<CronJob, 'name' | 'prompt'>): TablerIcon {
  const haystack = job.name || job.prompt || ''

  return ICON_RULES.find(rule => rule.pattern.test(haystack))?.icon ?? IconRefresh
}

/** Blue-glass square with a Tabler glyph (the `.icon-tile` treatment used for app tiles). */
export function JobTile({ job, size = 44, className }: { job: Pick<CronJob, 'name' | 'prompt'>; size?: number; className?: string }) {
  const Icon = iconForJob(job)

  return (
    <span className={cn('icon-tile shrink-0', className)} style={{ width: size, height: size, borderRadius: Math.round(size * 0.24) }} aria-hidden="true">
      <Icon size={Math.round(size * 0.5)} stroke={1.7} />
    </span>
  )
}

export function GlyphTile({ icon, size = 40, className }: { icon: React.ReactNode; size?: number; className?: string }) {
  return (
    <span className={cn('icon-tile shrink-0 [&_svg]:size-5', className)} style={{ width: size, height: size, borderRadius: Math.round(size * 0.24) }} aria-hidden="true">
      {icon}
    </span>
  )
}

const cleanPrompt = (prompt: string | undefined): string => (prompt ?? '').replace(/\s+/g, ' ').trim()

/** First sentence of the prompt, kept short; a neutral fallback when the job has no prompt. */
export function describeJob(job: Pick<CronJob, 'prompt' | 'name'> & { script?: unknown }, max = 96): string {
  const prompt = cleanPrompt(job.prompt)

  if (!prompt) {
    return typeof job.script === 'string' && job.script ? 'Runs a script on a schedule.' : 'Runs on a schedule.'
  }

  const sentence = prompt.split(/(?<=[.!?])\s+/)[0] ?? prompt
  const text = sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence

  return /[.!?…]$/.test(text) ? text : `${text}.`
}

const GATHER_RULES: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /calendar|meeting|schedule|agenda|event/i, label: 'calendar' },
  { pattern: /\bmail\b|e-?mail|inbox|message/i, label: 'priority mail' },
  { pattern: /mission|task|todo|to-do|project/i, label: 'active missions' },
  { pattern: /\bfiles?\b|folder|download|document|desktop/i, label: 'files' },
  { pattern: /\bweb\b|search|news|browse|website|internet|headline/i, label: 'the web' },
  { pattern: /github|pull request|\bpr\b|repo/i, label: 'GitHub' },
  { pattern: /slack|discord|telegram/i, label: 'chat channels' },
  { pattern: /weather|forecast/i, label: 'weather' },
  { pattern: /memory|remember|notes/i, label: 'memory' }
]

/** 'Calendar, priority mail and active missions' derived from prompt keywords, else the prompt's opening. */
export function describeGather(job: Pick<CronJob, 'prompt' | 'skills'>): string {
  const prompt = cleanPrompt(job.prompt)
  const labels = GATHER_RULES.filter(rule => rule.pattern.test(prompt)).map(rule => rule.label)

  if (labels.length === 0 && job.skills?.length) {
    labels.push(...job.skills.slice(0, 3))
  }

  if (labels.length > 0) {
    const list = labels.length <= 2 ? labels.join(' and ') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`

    return list.charAt(0).toUpperCase() + list.slice(1)
  }

  if (!prompt) {
    return 'Nothing to gather yet — add a prompt.'
  }

  return prompt.length > 90 ? `${prompt.slice(0, 89).trimEnd()}…` : prompt
}

export const isLocalDelivery = (deliver: string | null | undefined): boolean => !deliver || deliver === 'local'

export function describeDeliver(deliver: string | null | undefined, targets: readonly DeliveryTarget[] = []): string {
  if (isLocalDelivery(deliver)) {
    return 'Create a briefing in Hermes'
  }

  const target = targets.find(t => t.id === deliver)

  return `Send to ${target?.name ?? deliver}`
}

/* ---- Field chrome shared by the editors ------------------------------------------------------ */

export function FieldLabel({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="text-[12px] font-medium text-fg-2">
      {children}
    </label>
  )
}

export function TextInput({ className, ...props }: React.ComponentProps<'input'>) {
  return <input {...props} className={cn('glass-input h-9 w-full rounded-lg px-3 text-[13px] text-fg outline-none placeholder:text-fg-4', className)} />
}

export function TextArea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return <textarea {...props} className={cn('glass-input w-full resize-y rounded-lg px-3 py-2 text-[13px] leading-relaxed text-fg outline-none placeholder:text-fg-4', className)} />
}

export function SelectInput({ className, children, ...props }: React.ComponentProps<'select'>) {
  return (
    <select {...props} style={{ colorScheme: 'dark' }} className={cn('glass-input h-9 w-full rounded-lg px-2.5 text-[13px] text-fg outline-none', className)}>
      {children}
    </select>
  )
}

export function Hint({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn('text-[11.5px] leading-snug text-fg-3', className)}>{children}</p>
}
