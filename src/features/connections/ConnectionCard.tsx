import { IconPlugOff, IconPower, IconRefresh, IconTrash } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { GlassButton, GlassCard, MoreButton, StatusDot } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import { BrandLogo } from './brand-logos.tsx'
import { type Connection, STATUS_LABEL, STATUS_TONE } from './connections-model.ts'

export interface ConnectionActions {
  reconnect: (connection: Connection) => void
  setEnabled: (connection: Connection, enabled: boolean) => void
  remove: (connection: Connection) => void
}

/** Whether "Disable/Enable" makes sense for this connection (providers only sign in/out). */
export function canToggle(connection: Connection): boolean {
  return connection.kind !== 'provider'
}

export function ConnectionCard({ connection, selected, onSelect, actions, busy }: { connection: Connection; selected: boolean; onSelect: () => void; actions: ConnectionActions; busy?: boolean }) {
  return (
    <GlassCard
      interactive
      selected={selected}
      onClick={onSelect}
      data-os-target={`connection:${connection.id}`}
      className={cn('relative flex min-h-[150px] flex-col p-4', busy && 'opacity-70')}
    >
      <div className="flex items-start gap-3">
        <BrandLogo keys={[connection.name, connection.id, connection.logoKey]} size={44} />
        <div className="min-w-0 flex-1 pt-2">
          <div className="truncate text-[16px] leading-tight font-semibold text-fg">{connection.name}</div>
        </div>
        <div onClick={event => event.stopPropagation()}>
          <ConnectionMenu connection={connection} actions={actions} />
        </div>
      </div>

      <div className="mt-3.5 flex items-center gap-2 text-[12.5px]">
        <StatusDot tone={STATUS_TONE[connection.status]} pulse={connection.status === 'error'} />
        <span className={cn(connection.status === 'connected' ? 'text-ok' : connection.status === 'needs-auth' ? 'text-warn' : connection.status === 'error' ? 'text-danger' : 'text-fg-3')}>{STATUS_LABEL[connection.status]}</span>
      </div>
      <div className="mt-1.5 truncate text-[12.5px] text-fg-3">{connection.scope}</div>

      <div className="mt-auto flex justify-end pt-3">
        <GlassButton
          size="sm"
          aria-label={`Manage ${connection.name}`}
          onClick={event => {
            event.stopPropagation()
            onSelect()
          }}
        >
          Manage
          <span aria-hidden="true">→</span>
        </GlassButton>
      </div>
    </GlassCard>
  )
}

/** The "…" menu shared by cards and the detail header: Reconnect, Disable/Enable, Remove. */
export function ConnectionMenu({ connection, actions, label = 'Connection options' }: { connection: Connection; actions: ConnectionActions; label?: string }) {
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
  const enabled = connection.status !== 'disabled'
  const items = [
    { label: 'Reconnect', icon: <IconRefresh size={15} />, onClick: pick(() => actions.reconnect(connection)), danger: false, hidden: false },
    { label: enabled ? 'Disable' : 'Enable', icon: enabled ? <IconPlugOff size={15} /> : <IconPower size={15} />, onClick: pick(() => actions.setEnabled(connection, !enabled)), danger: false, hidden: !canToggle(connection) },
    { label: connection.kind === 'provider' ? 'Sign out' : 'Remove', icon: <IconTrash size={15} />, onClick: pick(() => actions.remove(connection)), danger: true, hidden: false }
  ].filter(item => !item.hidden)

  return (
    <div ref={ref} className="relative">
      <MoreButton aria-label={`${label} for ${connection.name}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)} />
      {open && (
        <div role="menu" aria-label={label} className="float absolute top-9 right-0 z-20 w-44 overflow-hidden rounded-xl p-1 animate-pop">
          {items.map(item => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={item.onClick}
              className={cn('flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[12.5px] hover:bg-white/8', item.danger ? 'text-danger hover:text-danger' : 'text-fg-2 hover:text-fg')}
            >
              <span className={item.danger ? 'text-danger' : 'text-fg-3'}>{item.icon}</span>
              <span className="flex-1 text-left">{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Card-shaped placeholder while the first load is in flight. */
export function ConnectionCardSkeleton() {
  return (
    <div className="glass-card flex min-h-[150px] flex-col rounded-xl p-4" aria-hidden="true">
      <div className="flex items-center gap-3">
        <div className="shimmer size-11 rounded-[11px]" />
        <div className="shimmer h-4 w-28 rounded" />
      </div>
      <div className="shimmer mt-4 h-3 w-20 rounded" />
      <div className="shimmer mt-2 h-3 w-36 rounded" />
      <div className="mt-auto flex justify-end pt-3">
        <div className="shimmer h-8 w-24 rounded-lg" />
      </div>
    </div>
  )
}
