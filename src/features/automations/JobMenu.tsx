import { IconCopy, IconPlayerPlay, IconTrash } from '@tabler/icons-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { MoreButton } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'

export type JobMenuAction = 'trigger' | 'duplicate' | 'delete'

/** The "⋯" menu on a job card / the detail header: Run now, Duplicate, Delete (with inline confirm). */
export function JobMenu({ jobName, onAction, className }: { jobName: string; onAction: (action: JobMenuAction) => void; className?: string }) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    const onPointer = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false)
        setConfirming(false)
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        setConfirming(false)
      }
    }

    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)

    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = (action: JobMenuAction) => {
    if (action === 'delete' && !confirming) {
      setConfirming(true)

      return
    }

    setOpen(false)
    setConfirming(false)
    onAction(action)
  }

  return (
    <div ref={root} className={cn('relative', className)} onClick={event => event.stopPropagation()}>
      <MoreButton
        aria-label={`More actions for ${jobName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen(v => !v)
          setConfirming(false)
        }}
      />
      {open && (
        <div role="menu" className="float animate-pop absolute top-full right-0 z-20 mt-1 w-48 rounded-lg p-1">
          <MenuItem icon={<IconPlayerPlay />} label="Run now" onClick={() => pick('trigger')} />
          <MenuItem icon={<IconCopy />} label="Duplicate" onClick={() => pick('duplicate')} />
          <div className="my-1 h-px bg-line" />
          <MenuItem icon={<IconTrash />} label={confirming ? 'Confirm delete' : 'Delete'} danger onClick={() => pick('delete')} />
        </div>
      )}
    </div>
  )
}

function MenuItem({ icon, label, onClick, danger }: { icon: ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn('flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[12.5px] transition-colors duration-120 [&_svg]:size-4 [&_svg]:shrink-0', danger ? 'text-danger hover:bg-danger/12' : 'text-fg hover:bg-white/8')}
    >
      {icon}
      {label}
    </button>
  )
}
