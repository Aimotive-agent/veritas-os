import type React from 'react'
import { cn } from '../../lib/cn.ts'

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd className={cn('inline-flex h-5 min-w-5 items-center justify-center rounded-xs bg-surface-3 px-1.5 font-sans text-[11px] text-fg-3', className)}>
      {children}
    </kbd>
  )
}

export function Badge({ children, tone = 'muted', className }: { children: React.ReactNode; tone?: 'muted' | 'accent' | 'ok' | 'warn' | 'danger' | 'info'; className?: string }) {
  const tones = {
    muted: 'bg-surface-3 text-fg-2',
    accent: 'bg-accent-soft text-accent',
    ok: 'bg-ok/15 text-ok',
    warn: 'bg-warn/15 text-warn',
    danger: 'bg-danger/15 text-danger',
    info: 'bg-info/15 text-info'
  }

  return <span className={cn('inline-flex h-5 items-center rounded-xs px-1.5 text-[11px] font-medium', tones[tone], className)}>{children}</span>
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span className={cn('relative inline-block size-3.5', className)} aria-label="Working">
      <span className="absolute inset-0 rounded-full border border-fg-4" />
      <span className="absolute inset-0 animate-spin rounded-full border border-transparent border-t-accent" />
    </span>
  )
}

export function Dot({ tone = 'muted', pulse = false, className }: { tone?: 'muted' | 'ok' | 'warn' | 'danger' | 'accent' | 'info'; pulse?: boolean; className?: string }) {
  const tones = { muted: 'bg-fg-4', ok: 'bg-ok', warn: 'bg-warn', danger: 'bg-danger', accent: 'bg-accent', info: 'bg-info' }

  return <span className={cn('inline-block size-1.5 rounded-full', tones[tone], pulse && 'animate-pulse-soft', className)} />
}

export function SectionTitle({ children, action, className }: { children: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-center justify-between gap-3 px-1', className)}>
      <h2 className="text-[11px] font-medium tracking-[0.08em] text-fg-3 uppercase">{children}</h2>
      {action}
    </div>
  )
}

export function EmptyState({ icon, title, description, action, className }: { icon?: React.ReactNode; title: string; description?: string; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex h-full min-h-40 flex-col items-center justify-center gap-2 text-center', className)}>
      {icon && <div className="text-fg-4 [&_svg]:size-7">{icon}</div>}
      <div className="text-[13px] text-fg-2">{title}</div>
      {description && <div className="max-w-sm text-[12px] text-fg-3">{description}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn('relative h-5 w-9 rounded-full transition-colors duration-100', checked ? 'bg-accent' : 'bg-surface-3')}
    >
      <span className={cn('absolute top-0.5 left-0 size-4 rounded-full bg-fg transition-transform duration-100', checked ? 'translate-x-4.5 bg-accent-fg' : 'translate-x-0.5')} />
    </button>
  )
}

export function Row({ title, description, children, className }: { title: React.ReactNode; description?: React.ReactNode; children?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-center justify-between gap-6 py-2.5', className)}>
      <div className="min-w-0">
        <div className="text-[13px] text-fg">{title}</div>
        {description && <div className="mt-0.5 text-[12px] text-fg-3">{description}</div>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  )
}

export function Stat({ label, value, sub, className }: { label: string; value: React.ReactNode; sub?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-0.5', className)}>
      <div className="text-[11px] tracking-[0.06em] text-fg-3 uppercase">{label}</div>
      <div className="text-[20px] font-medium tabular-nums text-fg">{value}</div>
      {sub && <div className="text-[12px] text-fg-3">{sub}</div>}
    </div>
  )
}

export function Meter({ value, tone = 'accent', className }: { value: number; tone?: 'accent' | 'ok' | 'warn' | 'danger'; className?: string }) {
  const clamped = Math.max(0, Math.min(100, value))
  const tones = { accent: 'bg-accent', ok: 'bg-ok', warn: 'bg-warn', danger: 'bg-danger' }

  return (
    <div className={cn('h-1 w-full overflow-hidden rounded-full bg-surface-3', className)}>
      <div className={cn('h-full rounded-full transition-[width] duration-300', tones[tone])} style={{ width: `${clamped}%` }} />
    </div>
  )
}

export function Panel({ children, className, title, action }: { children: React.ReactNode; className?: string; title?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className={cn('flex min-h-0 flex-col gap-3', className)}>
      {title && <SectionTitle action={action}>{title}</SectionTitle>}
      {children}
    </section>
  )
}
