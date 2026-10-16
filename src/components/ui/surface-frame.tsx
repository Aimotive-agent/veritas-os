import type React from 'react'
import { cn } from '../../lib/cn.ts'

/** Common page frame: quiet title row, optional actions, scrollable body. */
export function SurfaceFrame({ title, subtitle, actions, children, className, bodyClassName }: { title: string; subtitle?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <div className={cn('flex h-full flex-col', className)}>
      <div className="flex h-14 shrink-0 items-center justify-between gap-4 px-8">
        <div className="flex items-baseline gap-3">
          <h1 className="text-[16px] font-medium tracking-tight">{title}</h1>
          {subtitle && <span className="text-[12px] text-fg-3">{subtitle}</span>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      <div className={cn('min-h-0 flex-1 overflow-y-auto px-8 pb-8', bodyClassName)}>{children}</div>
    </div>
  )
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
      <span className="selectable min-w-0 truncate">{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="shrink-0 underline decoration-danger/40 hover:decoration-danger">
          Retry
        </button>
      )}
    </div>
  )
}
