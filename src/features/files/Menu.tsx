import { IconCheck, IconChevronRight } from '@tabler/icons-react'
import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '../../lib/cn.ts'

/*
 * A small anchored glass menu for the Files page. Render it inside a `relative` wrapper next to
 * the button that opened it; it closes on outside click and Escape.
 */

export interface MenuItemDef {
  id: string
  label: string
  icon?: React.ReactNode
  onSelect: () => void
  danger?: boolean
  checked?: boolean
  disabled?: boolean
  /** Draw a divider above this item. */
  dividerBefore?: boolean
  /** A keyboard shortcut shown at the right. */
  hint?: string
  /** Items in a menu of their own, opened beside this one on hover. */
  submenu?: MenuItemDef[]
}

function MenuRow({ item, onClose, onEnter, open }: { item: MenuItemDef; onClose: () => void; onEnter: () => void; open: boolean }) {
  return (
    <div className={cn('relative', item.dividerBefore && 'mt-1 border-t border-line pt-1')} onMouseEnter={onEnter}>
      <button
        type="button"
        role="menuitem"
        disabled={item.disabled}
        aria-haspopup={item.submenu ? 'menu' : undefined}
        aria-expanded={item.submenu ? open : undefined}
        onClick={() => {
          if (item.submenu) {
            onEnter()

            return
          }

          onClose()
          item.onSelect()
        }}
        className={cn(
          'flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[12.5px] whitespace-nowrap hover:bg-white/8 disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:size-[15px] [&_svg]:shrink-0',
          item.danger ? 'text-danger hover:bg-danger/12' : 'text-fg-2 hover:text-fg',
          open && 'bg-white/8 text-fg'
        )}
      >
        {item.icon && <span className={cn(item.danger ? 'text-danger' : 'text-fg-3')}>{item.icon}</span>}
        <span className="flex-1">{item.label}</span>
        {item.hint && <span className="pl-4 text-[11px] text-fg-3">{item.hint}</span>}
        {item.checked && <IconCheck size={14} className="text-accent-strong" />}
        {item.submenu && <IconChevronRight size={14} className="text-fg-3" />}
      </button>
      {item.submenu && open && !item.disabled && (
        // The padding bridges the gap, so the pointer can travel from the row into the submenu.
        <div className="absolute top-0 left-full z-40 -mt-1 pl-1.5">
          <div role="menu" className="float menu-surface min-w-48 rounded-xl p-1 animate-pop">
            {item.submenu.map(entry => (
              <MenuRow key={entry.id} item={entry} onClose={onClose} onEnter={() => {}} open={false} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function Menu({ items, onClose, align = 'right', className }: { items: MenuItemDef[]; onClose: () => void; align?: 'left' | 'right'; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null)

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        onClose()
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)

    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      role="menu"
      className={cn('float menu-surface absolute z-30 min-w-48 rounded-xl p-1 animate-pop', align === 'right' ? 'right-0' : 'left-0', className)}
      onClick={event => event.stopPropagation()}
      onDoubleClick={event => event.stopPropagation()}
      onMouseDown={event => event.stopPropagation()}
    >
      {items.map(item => (
        <MenuRow key={item.id} item={item} onClose={onClose} onEnter={() => setOpenSubmenu(item.submenu ? item.id : null)} open={openSubmenu === item.id} />
      ))}
    </div>
  )
}
