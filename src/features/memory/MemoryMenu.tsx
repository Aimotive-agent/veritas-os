import { IconFileText, IconRefresh, IconUser } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { MoreButton } from '../../components/ui/glass.tsx'
import type { MemoryFile } from './memory-store.ts'

/** The header's "…" menu: reload from disk, or open a memory file in the default editor. */
export function MemoryMenu({ onReload, onOpenFile, disabled }: { onReload: () => void; onOpenFile: (file: MemoryFile) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      return
    }

    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const pick = (action: () => void) => () => {
    setOpen(false)
    action()
  }

  const items = [
    { label: 'Reload', icon: <IconRefresh size={15} />, onClick: pick(onReload), disabled: false },
    { label: 'Open MEMORY.md', icon: <IconFileText size={15} />, onClick: pick(() => onOpenFile('MEMORY.md')), disabled: Boolean(disabled) },
    { label: 'Open USER.md', icon: <IconUser size={15} />, onClick: pick(() => onOpenFile('USER.md')), disabled: Boolean(disabled) }
  ]

  return (
    <div ref={ref} className="relative">
      <MoreButton aria-label="Memory options" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)} />
      {open && (
        <div role="menu" aria-label="Memory options" className="float absolute top-9 right-0 z-20 w-48 overflow-hidden rounded-xl p-1 animate-pop">
          {items.map(item => (
            <button key={item.label} type="button" role="menuitem" disabled={item.disabled} onClick={item.onClick} className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[12.5px] text-fg-2 hover:bg-white/8 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40">
              <span className="text-fg-3">{item.icon}</span>
              <span className="flex-1 text-left">{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
