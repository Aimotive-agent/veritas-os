import { IconBolt, IconCheck, IconClock, IconFileText, IconFolder, IconHelpCircle, IconPencil, IconPlugConnected, IconRefresh, IconShield, IconTrash, IconX } from '@tabler/icons-react'
import type React from 'react'
import { useState } from 'react'
import { GlassButton, KeyValue, LinkAction, StatusDot, Toggle } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import { formatClock, formatRelative } from '../../lib/format.ts'
import type { ActivityEntry } from '../../store/missions.ts'
import { showPage } from '../../store/windows.ts'
import { BrandLogo } from './brand-logos.tsx'
import { type ConnectionActions, ConnectionMenu } from './ConnectionCard.tsx'
import { activityFor, basename, type Connection, type ConnectionTool, readFolders, STATUS_LABEL, STATUS_TONE, writeFolders } from './connections-model.ts'

export interface ProbeState {
  phase: 'probing' | 'ok' | 'failed'
  error?: string
}

export function ConnectionDetail({
  connection,
  activity,
  actions,
  onToggle,
  probe,
  confirmingRemove,
  onConfirmRemove,
  onCancelRemove,
  busy
}: {
  connection: Connection
  activity: ActivityEntry[]
  actions: ConnectionActions
  onToggle: (connection: Connection, row: ConnectionTool, enabled: boolean) => void
  probe?: ProbeState
  confirmingRemove: boolean
  onConfirmRemove: () => void
  onCancelRemove: () => void
  busy: boolean
}) {
  const recent = activityFor(connection, activity, 3)
  const provider = connection.source.kind === 'provider' ? connection.source.provider : null
  const showFolders = connection.kind !== 'provider'

  return (
    <div className="flex min-h-full flex-col gap-4">
      <div className="flex items-start gap-3">
        <BrandLogo keys={[connection.name, connection.id, connection.logoKey]} size={44} />
        <div className="min-w-0 flex-1 pt-0.5">
          <h2 className="truncate text-[18px] leading-tight font-semibold text-fg">{connection.name}</h2>
          <div className="mt-1 flex items-center gap-1.5 text-[12.5px]">
            <StatusDot tone={STATUS_TONE[connection.status]} pulse={probe?.phase === 'probing'} />
            <span className={cn(connection.status === 'connected' ? 'text-ok' : connection.status === 'needs-auth' ? 'text-warn' : connection.status === 'error' ? 'text-danger' : 'text-fg-3')}>
              {probe?.phase === 'probing' ? 'Checking…' : STATUS_LABEL[connection.status]}
            </span>
          </div>
        </div>
        <ConnectionMenu connection={connection} actions={actions} />
      </div>

      <p className="selectable text-[13px] leading-relaxed text-fg-2">{connection.description}</p>
      {probe?.phase === 'failed' && probe.error && <p className="selectable -mt-2 text-[12px] leading-relaxed text-warn">{probe.error}</p>}

      <section className="flex flex-col gap-1" aria-label="Permissions">
        <div className="flex items-center justify-between">
          <h3 className="text-[13px] font-semibold text-fg">Permissions</h3>
          <span
            role="img"
            className="text-fg-3"
            title={connection.kind === 'mcp' ? 'Hermes enables or disables an MCP server as a whole; the lines below are what the server can do.' : 'Each switch controls whether Hermes may use that capability.'}
            aria-label="About permissions"
          >
            <IconHelpCircle size={15} />
          </span>
        </div>

        {provider ? (
          <KeyValue
            className="mt-1.5"
            rows={[
              { label: 'Account', value: provider.status.source_label || provider.status.source || 'Signed in' },
              { label: 'Token', value: provider.status.token_preview ? `…${provider.status.token_preview}` : 'Stored' },
              { label: 'Expires', value: formatExpiry(provider.status.expires_at, provider.status.has_refresh_token) }
            ]}
          />
        ) : connection.tools.length === 0 ? (
          <div className="py-1.5 text-[12px] text-fg-4">{probe?.phase === 'probing' ? <span className="shimmer inline-block h-3 w-40 rounded" /> : 'No tools reported yet. Reconnect to list them.'}</div>
        ) : (
          <ul className="divide-y divide-line">
            {connection.tools.map(row => (
              <PermissionRow key={row.id} row={row} disabled={busy} onChange={enabled => onToggle(connection, row, enabled)} />
            ))}
          </ul>
        )}
      </section>

      {showFolders && <AllowedFolders connectionId={connection.id} />}

      <section className="flex flex-col gap-1.5" aria-label="Recent activity">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-[13px] font-semibold text-fg">
            <IconClock size={15} className="text-fg-3" />
            Recent activity
          </h3>
          <LinkAction onClick={() => showPage('missions')}>View all</LinkAction>
        </div>
        {recent.length === 0 ? (
          <div className="px-1 py-1 text-[12px] text-fg-4">Nothing yet. Activity shows up here when Hermes uses {connection.name}.</div>
        ) : (
          <ul className="flex flex-col">
            {recent.map(entry => (
              <li key={entry.id} className="flex items-center gap-2.5 px-1 py-1.5 text-[12.5px]">
                <IconFileText size={15} className="shrink-0 text-fg-3" />
                <span className="min-w-0 flex-1 truncate text-fg">{entry.title}</span>
                <span className="shrink-0 text-[11.5px] text-fg-4 tabular-nums">{activityTime(entry.ts)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="mt-auto flex flex-col gap-3 pt-2">
        {confirmingRemove ? (
          <div className="glass-card flex flex-col gap-2.5 rounded-xl p-3">
            <div className="text-[12.5px] text-fg-2">
              {connection.kind === 'provider' ? `Sign out of ${connection.name}?` : `Disconnect ${connection.name}?`} Hermes loses this access until you add it again.
            </div>
            <div className="flex gap-2">
              <GlassButton size="sm" className="flex-1" onClick={onCancelRemove} disabled={busy}>
                Cancel
              </GlassButton>
              <GlassButton size="sm" variant="danger" className="flex-1" onClick={onConfirmRemove} disabled={busy} aria-label={`Confirm disconnect ${connection.name}`}>
                <IconTrash />
                {connection.kind === 'provider' ? 'Sign out' : 'Disconnect'}
              </GlassButton>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <GlassButton className="flex-1" onClick={() => actions.reconnect(connection)} disabled={busy || probe?.phase === 'probing'} aria-label={`Reconnect ${connection.name}`}>
              <IconRefresh />
              Reconnect
            </GlassButton>
            <GlassButton className="flex-1" variant="danger" onClick={() => actions.remove(connection)} disabled={busy} aria-label={`Disconnect ${connection.name}`}>
              <IconTrash />
              {connection.kind === 'provider' ? 'Sign out' : 'Disconnect'}
            </GlassButton>
          </div>
        )}
        <div className="flex items-center justify-center gap-1.5 text-[12px] text-fg-3">
          <IconShield size={14} />
          Hermes uses only the access you choose.
        </div>
      </div>
    </div>
  )
}

/** Clock time for today's entries ("9:32"), relative wording for older ones. */
function activityTime(ts: number): string {
  const date = new Date(ts)
  const now = new Date()
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()

  return sameDay ? formatClock(date) : formatRelative(ts)
}

function formatExpiry(expiresAt: string | null | undefined, hasRefresh: boolean | undefined): string {
  if (expiresAt) {
    const ms = Date.parse(expiresAt)

    if (!Number.isNaN(ms)) {
      return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    }
  }

  return hasRefresh ? 'Renews automatically' : 'Not set'
}

function iconFor(label: string): React.ReactNode {
  if (/^(find|read|search|list)/i.test(label)) {
    return <IconFileText size={17} />
  }

  if (/(create|edit|send|draft|write)/i.test(label)) {
    return <IconPencil size={17} />
  }

  if (/delete|remove/i.test(label)) {
    return <IconTrash size={17} />
  }

  if (/run|control|action/i.test(label)) {
    return <IconBolt size={17} />
  }

  return <IconPlugConnected size={17} />
}

function PermissionRow({ row, disabled, onChange }: { row: ConnectionTool; disabled: boolean; onChange: (enabled: boolean) => void }) {
  const title = row.tools.length ? row.tools.join(', ') : undefined

  return (
    <li className="flex items-center gap-3 py-2.5" title={title}>
      <span className="shrink-0 text-fg-2">{iconFor(row.label)}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{row.label}</span>
      {row.toggle ? (
        <Toggle checked={row.enabled} onChange={onChange} label={row.label} disabled={disabled} />
      ) : (
        <span className={cn('flex items-center gap-1 text-[11.5px]', row.enabled ? 'text-fg-3' : 'text-fg-4')} aria-label={row.enabled ? 'Included' : 'Off while disabled'}>
          {row.enabled && <IconCheck size={13} />}
          {row.tools.length > 1 ? `${row.tools.length} tools` : row.enabled ? 'Included' : 'Off'}
        </span>
      )}
    </li>
  )
}

/** Locally remembered folder chips; Hermes has no per-connection folder scope yet, so this is a hint Hermes reads via the prompt. */
function AllowedFolders({ connectionId }: { connectionId: string }) {
  // The detail is keyed by connection id, so a fresh mount reads the right list.
  const [folders, setFolders] = useState<string[]>(() => readFolders(connectionId))
  const [picking, setPicking] = useState(false)

  const save = (next: string[]) => {
    setFolders(next)
    writeFolders(connectionId, next)
  }

  const add = async () => {
    setPicking(true)

    try {
      const picked = await window.heraldOS.fs.pickFiles({ directory: true, multiple: true })
      const next = [...folders]

      for (const path of picked) {
        if (!next.includes(path)) {
          next.push(path)
        }
      }

      save(next)
    } finally {
      setPicking(false)
    }
  }

  return (
    <section className="flex flex-col gap-2" aria-label="Allowed folders">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-[13px] font-semibold text-fg">
          <IconFolder size={15} className="text-fg-3" />
          Allowed folders
        </h3>
        <GlassButton size="sm" onClick={() => void add()} disabled={picking} aria-label="Add folder">
          Add folder
        </GlassButton>
      </div>
      {folders.length === 0 ? (
        <div className="px-1 text-[12px] text-fg-4">Everything Hermes may already reach. Add folders to narrow it down.</div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {folders.map(path => (
            <span key={path} title={path} className="flex h-7 items-center gap-1 rounded-full border border-line bg-white/4 pr-1.5 pl-3 text-[12px] text-fg">
              {basename(path)}
              <button type="button" aria-label={`Remove ${basename(path)}`} onClick={() => save(folders.filter(f => f !== path))} className="flex size-5 items-center justify-center rounded-full text-fg-3 hover:bg-white/10 hover:text-fg">
                <IconX size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

/** Skeleton for the right column while the first load runs. */
export function ConnectionDetailSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      <div className="flex items-center gap-3">
        <div className="shimmer size-11 rounded-[11px]" />
        <div className="flex flex-col gap-2">
          <div className="shimmer h-4 w-32 rounded" />
          <div className="shimmer h-3 w-20 rounded" />
        </div>
      </div>
      <div className="shimmer h-10 w-full rounded" />
      <div className="shimmer h-24 w-full rounded" />
      <div className="shimmer h-16 w-full rounded" />
    </div>
  )
}
