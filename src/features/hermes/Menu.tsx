import type React from 'react'
import { useEffect, useRef } from 'react'
import { cn } from '../../lib/cn.ts'

/** Anchored glass menu. Wrap the trigger and the menu in `PopMenu`; it closes on outside clicks and Escape. */
export function PopMenu({ open, onClose, trigger, align = 'right', width = 'w-56', className, children }: { open: boolean; onClose: () => void; trigger: React.ReactNode; align?: 'left' | 'right'; width?: string; className?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        onClose()
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)

    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  return (
    <div ref={ref} className={cn('relative', className)}>
      {trigger}
      {open && (
        <div role="menu" className={cn('float absolute top-full z-20 mt-1.5 overflow-hidden rounded-xl p-1 animate-pop', width, align === 'right' ? 'right-0' : 'left-0')}>
          {children}
        </div>
      )}
    </div>
  )
}

export function MenuItem({ icon, children, danger, disabled, onClick, hint }: { icon?: React.ReactNode; children: React.ReactNode; danger?: boolean; disabled?: boolean; onClick?: () => void; hint?: string }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn('flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[12.5px] disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:size-4 [&_svg]:shrink-0', danger ? 'text-danger hover:bg-danger/12' : 'text-fg-2 hover:bg-white/8 hover:text-fg')}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="text-[11px] text-fg-4">{hint}</span>}
    </button>
  )
}

export function MenuDivider() {
  return <div className="my-1 h-px bg-line" />
}
