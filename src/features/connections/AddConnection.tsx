import { IconKey, IconLayoutGrid, IconPlus } from '@tabler/icons-react'
import { useState } from 'react'
import { EmptyGlass, GlassButton, GlassCard, Pill } from '../../components/ui/glass.tsx'
import { BrandLogo } from './brand-logos.tsx'
import type { BrowseItem, McpCatalogEntry } from './connections-model.ts'

/*
 * The Browse tab: MCP catalog entries, messaging platforms, service toolsets and providers that
 * are not configured yet. Catalog entries that need credentials expand into a small inline form
 * so the secret goes straight to Hermes's .env through the install endpoint.
 */

export function AddConnection({ items, query, onAdd, busyId }: { items: BrowseItem[]; query: string; onAdd: (item: BrowseItem, env?: Record<string, string>) => void; busyId: string | null }) {
  if (items.length === 0) {
    return <EmptyGlass icon={<IconLayoutGrid />} title={query ? `Nothing matches “${query}”` : 'Everything available is already connected'} description={query ? 'Try a shorter name, or ask Hermes to set up something new.' : 'New MCP servers show up here as the catalog grows.'} className="flex-1" />
  }

  return (
    <div className="stagger grid grid-cols-2 gap-3 xl:grid-cols-3">
      {items.map(item => (
        <BrowseCard key={item.id} item={item} onAdd={onAdd} busy={busyId === item.id} />
      ))}
    </div>
  )
}

function requiredEnv(entry: McpCatalogEntry): { name: string; prompt?: string; required?: boolean }[] {
  return (entry.required_env ?? []).filter(e => e.required !== false)
}

function BrowseCard({ item, onAdd, busy }: { item: BrowseItem; onAdd: (item: BrowseItem, env?: Record<string, string>) => void; busy: boolean }) {
  const needsEnv = item.install.kind === 'mcp-catalog' ? requiredEnv(item.install.entry) : []
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const complete = needsEnv.every(e => values[e.name]?.trim())

  const add = () => {
    if (needsEnv.length > 0 && !open) {
      setOpen(true)

      return
    }

    onAdd(item, needsEnv.length ? values : undefined)
  }

  return (
    <GlassCard className="flex min-h-[150px] flex-col p-4">
      <div className="flex items-start gap-3">
        <BrandLogo keys={[item.name, item.id, item.logoKey]} size={44} />
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="truncate text-[16px] leading-tight font-semibold text-fg">{item.name}</div>
          <div className="mt-1 truncate text-[12px] text-fg-3">{item.scope}</div>
        </div>
        <Pill className="shrink-0">{item.category}</Pill>
      </div>

      <p className="mt-3 line-clamp-2 text-[12.5px] leading-relaxed text-fg-2" title={item.description}>
        {item.description}
      </p>

      {open && needsEnv.length > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          {needsEnv.map(env => (
            <label key={env.name} className="glass-input flex h-9 items-center gap-2 rounded-lg px-3">
              <IconKey size={14} className="shrink-0 text-fg-3" />
              <input
                type="password"
                autoComplete="off"
                value={values[env.name] ?? ''}
                onChange={e => setValues(v => ({ ...v, [env.name]: e.target.value }))}
                placeholder={env.prompt || env.name}
                aria-label={env.prompt || env.name}
                className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-fg-4"
              />
            </label>
          ))}
          <div className="text-[11.5px] text-fg-4">Stored in Hermes’s .env, never shown again.</div>
        </div>
      )}

      <div className="mt-auto flex items-center justify-end gap-2 pt-3">
        {open && (
          <GlassButton size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </GlassButton>
        )}
        <GlassButton size="sm" variant={open ? 'primary' : 'secondary'} onClick={add} disabled={busy || (open && !complete)} aria-label={`Add ${item.name}`}>
          <IconPlus />
          {busy ? 'Adding…' : open ? 'Install' : 'Add'}
        </GlassButton>
      </div>
    </GlassCard>
  )
}
