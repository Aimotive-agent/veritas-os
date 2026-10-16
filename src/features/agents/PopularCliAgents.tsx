import { IconBrandGithub, IconDownload, IconPlayerPlay, IconTerminal2 } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import type { CatalogGroupView } from '../../../../shared/ipc.ts'
import { GlassButton, GlassCard, Pill, Section } from '../../components/ui/glass.tsx'
import { notify } from '../../store/notifications.ts'
import { openTerminalProgram } from '../../store/terminal.ts'
import { cn } from '../../lib/cn.ts'

/*
 * The popular CLI coding agents (Veritas's install catalog, AI group). Every row is one click:
 * install it, open it in a Veritas OS terminal, or — when the agent also serves an API — connect it
 * to the Agent Hub above.
 */

/** Agents that also expose a local server the shell can drive (id -> our hub agent id). */
const SERVER_AGENTS: Record<string, string> = { opencode: 'opencode' }

export function PopularCliAgents() {
  const [groups, setGroups] = useState<CatalogGroupView[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = () => {
    void window.heraldOS.catalog
      .list()
      .then(setGroups)
      .catch(() => setGroups([]))
  }

  useEffect(load, [])

  const entries = (groups ?? []).find(group => group.id === 'ai')?.entries ?? []

  if (!entries.length) {
    return null
  }

  const install = async (id: string, label: string) => {
    setBusy(id)
    try {
      const result = await window.heraldOS.catalog.install(id)
      notify({ title: `Installed ${label}`, body: result?.message ?? 'Ready to run.', level: 'success' })
      load()
    } catch (error) {
      notify({ title: `Could not install ${label}`, body: error instanceof Error ? error.message : String(error), level: 'error' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Section title="Popular CLI agents">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {entries.map(entry => {
          const bin = entry.bin
          const serverAgent = SERVER_AGENTS[entry.id]
          const installed = entry.installed

          return (
            <GlassCard key={entry.id} className="flex items-start gap-3.5 p-4">
              <div className="mt-0.5 flex size-9 items-center justify-center rounded-lg bg-white/6 text-fg-2">
                <IconTerminal2 size={17} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[13.5px] font-semibold text-fg">{entry.label}</span>
                  {installed ? <Pill tone="ok">Installed</Pill> : null}
                  {serverAgent ? <Pill tone="accent">Server</Pill> : null}
                </div>
                <div className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-fg-3">{entry.description}</div>
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  {installed && bin ? (
                    <GlassButton size="sm" variant="secondary" onClick={() => openTerminalProgram(bin, entry.label)}>
                      <IconPlayerPlay /> Open in Terminal
                    </GlassButton>
                  ) : null}
                  {!installed ? (
                    <GlassButton
                      size="sm"
                      variant={entry.available ? 'primary' : 'ghost'}
                      disabled={!entry.available || busy === entry.id}
                      title={entry.reason ?? entry.method ?? undefined}
                      onClick={() => void install(entry.id, entry.label)}
                    >
                      <IconDownload /> {entry.available ? 'Install' : 'Not available here'}
                    </GlassButton>
                  ) : null}
                  {serverAgent && installed ? (
                    <span className={cn('text-[11.5px] text-fg-3')}>Connect it above in Additional agents</span>
                  ) : null}
                  {entry.url ? (
                    <button
                      type="button"
                      onClick={() => void window.heraldOS.shell.openExternal(entry.url!)}
                      className="flex items-center gap-1 text-[12px] text-fg-3 hover:text-fg"
                    >
                      <IconBrandGithub size={13} /> Docs
                    </button>
                  ) : null}
                </div>
              </div>
            </GlassCard>
          )
        })}
      </div>
    </Section>
  )
}
