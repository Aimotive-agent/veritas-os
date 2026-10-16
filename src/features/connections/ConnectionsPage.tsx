import { useStore } from '@nanostores/react'
import { IconLayoutGrid, IconPlugConnected, IconPlus, IconRefresh } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EmptyGlass, GlassButton, GlassCard, PageHeader, SearchField, Tabs, type TabDef } from '../../components/ui/glass.tsx'
import { useBackendData } from '../../lib/use-async.ts'
import { sendPrompt } from '../../store/chat.ts'
import { $connectionsTick, setConnectionEnabled } from '../../store/connections-actions.ts'
import { $activity } from '../../store/missions.ts'
import { notify } from '../../store/notifications.ts'
import { showPage } from '../../store/windows.ts'
import { AddConnection } from './AddConnection.tsx'
import { type ConnectionActions, ConnectionCard, ConnectionCardSkeleton } from './ConnectionCard.tsx'
import { ConnectionDetail, ConnectionDetailSkeleton, type ProbeState } from './ConnectionDetail.tsx'
import { api, type BrowseItem, type Connection, type ConnectionTool, errorText, groupTools, loadConnections, type McpProbeResult } from './connections-model.ts'

type TabId = 'connected' | 'browse'

/** Probe results outlive the page's data reloads; a probe is a real connection to the server. */
const probeCache = new Map<string, McpProbeResult>()

export function ConnectionsPage() {
  const activity = useStore($activity)
  // Reload when a command (voice, agent) changed a connection outside this page.
  const connectionsTick = useStore($connectionsTick)
  const { data, error, loading, reload } = useBackendData(loadConnections, [connectionsTick])
  const [tab, setTab] = useState<TabId>('connected')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({})
  const [probes, setProbes] = useState<Record<string, ProbeState>>({})
  const [probeTools, setProbeTools] = useState<Record<string, string[]>>({})
  const [focusSearch, setFocusSearch] = useState(0)
  const searchRef = useRef<HTMLDivElement>(null)

  // Optimistic toggles are only a bridge until the next snapshot arrives.
  useEffect(() => {
    setOptimistic({})
  }, [data])

  useEffect(() => {
    if (focusSearch > 0) {
      searchRef.current?.querySelector('input')?.focus()
    }
  }, [focusSearch])

  const connections = useMemo(() => (data?.connections ?? []).map(c => decorate(c, optimistic, probes, probeTools)), [data, optimistic, probes, probeTools])
  const browse = data?.browse ?? []
  const needle = query.trim().toLowerCase()
  const visibleConnections = needle ? connections.filter(c => `${c.name} ${c.scope} ${c.id} ${c.description}`.toLowerCase().includes(needle)) : connections
  const visibleBrowse = needle ? browse.filter(b => `${b.name} ${b.scope} ${b.description} ${b.category}`.toLowerCase().includes(needle)) : browse
  const selected = connections.find(c => c.id === selectedId) ?? visibleConnections[0] ?? null

  const tabs: readonly TabDef<TabId>[] = [
    { id: 'connected', label: 'Connected', count: connections.length },
    { id: 'browse', label: 'Browse', icon: <IconLayoutGrid size={14} /> }
  ]

  const runProbe = useCallback(async (connection: Connection, options: { force?: boolean; announce?: boolean } = {}) => {
    if (connection.source.kind !== 'mcp') {
      return null
    }

    const name = connection.source.server.name
    const apply = (result: McpProbeResult) => {
      if (result.ok) {
        setProbes(p => ({ ...p, [connection.id]: { phase: 'ok' } }))
        setProbeTools(t => ({ ...t, [connection.id]: result.tools.map(tool => tool.name) }))
      } else {
        setProbes(p => ({ ...p, [connection.id]: { phase: 'failed', error: result.error ?? 'The server did not answer.' } }))
      }
    }
    const cached = probeCache.get(name)

    if (cached && !options.force) {
      apply(cached)

      return cached
    }

    setProbes(p => ({ ...p, [connection.id]: { phase: 'probing' } }))

    try {
      const result = await api.probeMcp(name)
      probeCache.set(name, result)
      apply(result)

      if (result.ok && options.announce) {
        notify({ title: `${connection.name} is reachable`, body: `${result.tools.length} tool${result.tools.length === 1 ? '' : 's'} available.`, level: 'success' })
      }

      return result
    } catch (err) {
      const message = errorText(err)
      setProbes(p => ({ ...p, [connection.id]: { phase: 'failed', error: message } }))

      return { ok: false, error: message, tools: [] } satisfies McpProbeResult
    }
  }, [])

  // Probe the selected MCP server once so the detail shows live tools and health.
  useEffect(() => {
    if (selected && selected.source.kind === 'mcp' && selected.source.server.enabled && !probes[selected.id]) {
      void runProbe(selected)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id])

  const withBusy = async (id: string, work: () => Promise<void>) => {
    setBusyId(id)

    try {
      await work()
    } catch (err) {
      notify({ title: 'Connection update failed', body: errorText(err), level: 'error' })
    } finally {
      setBusyId(null)
      reload()
    }
  }

  const openHermesFor = (name: string) => {
    showPage('hermes')
    void sendPrompt(`Help me set up the ${name} integration in Hermes.`)
  }

  const setEnabled = (connection: Connection, enabled: boolean) => {
    void withBusy(connection.id, async () => {
      if (connection.source.kind === 'provider') {
        notify({ title: 'Providers are signed in or out', body: 'Use Sign out to remove this account.', level: 'info' })

        return
      }

      // Shared with the command registry (store/connections-actions.ts).
      await setConnectionEnabled(connection, enabled)
    })
  }

  const reconnect = (connection: Connection) => {
    void withBusy(connection.id, async () => {
      const source = connection.source

      switch (source.kind) {
        case 'mcp': {
          if (!source.server.enabled) {
            await api.setMcpEnabled(source.server.name, true)
          }

          const result = await runProbe(connection, { force: true, announce: true })
          const wantsOAuth = source.server.auth === 'oauth' || /oauth|unauthori[sz]ed|401|token/i.test(result?.error ?? '')

          if (result && !result.ok && wantsOAuth && source.server.url) {
            const flow = await api.authMcp(source.server.name)

            if (flow.authorization_url) {
              await window.heraldOS.shell.openExternal(flow.authorization_url)
              notify({ title: `Finish signing in to ${connection.name}`, body: 'Approve access in your browser, then reconnect.', level: 'info' })
            } else {
              notify({ title: `Could not start sign-in for ${connection.name}`, body: flow.error ?? 'No authorization link was returned.', level: 'error' })
            }
          } else if (result && !result.ok) {
            notify({ title: `${connection.name} is not reachable`, body: result.error, level: 'warn' })
          }

          break
        }
        case 'messaging':
          if (!source.platform.configured) {
            openHermesFor(connection.name)
          } else {
            await api.setPlatformEnabled(source.platform.id, true)
            notify({ title: `${connection.name} enabled`, body: 'Restart the gateway to reconnect the channel.', level: 'success' })
          }

          break
        case 'toolset':
          if (!source.toolset.configured) {
            openHermesFor(connection.name)
          } else {
            await api.setToolsetEnabled(source.toolset.name, true)
            notify({ title: `${connection.name} enabled`, level: 'success' })
          }

          break
        case 'provider':
          await startProviderSignIn(source.provider.id, source.provider.name, source.provider.flow, source.provider.cli_command)
          break
      }
    })
  }

  const startProviderSignIn = async (id: string, name: string, flow: string, cliCommand?: string | null) => {
    if (flow !== 'device_code') {
      showPage('hermes')
      void sendPrompt(`Help me sign in to ${name}${cliCommand ? ` by running \`${cliCommand}\`` : ''}.`)

      return
    }

    const started = await api.startProviderOAuth(id)

    if (started.verification_url) {
      await window.heraldOS.shell.openExternal(started.verification_url)
    }

    notify({ title: `Sign in to ${name}`, body: started.user_code ? `Enter code ${started.user_code} in your browser, then come back.` : 'Approve access in your browser, then come back.', level: 'info' })
  }

  const remove = (connection: Connection) => {
    setSelectedId(connection.id)
    setTab('connected')
    setConfirmId(connection.id)
  }

  const confirmRemove = (connection: Connection) => {
    setConfirmId(null)
    void withBusy(connection.id, async () => {
      const source = connection.source

      switch (source.kind) {
        case 'mcp':
          await api.removeMcp(source.server.name)
          probeCache.delete(source.server.name)
          notify({ title: `${connection.name} disconnected`, body: 'The MCP server was removed from Hermes.', level: 'success' })
          break
        case 'messaging':
          await api.setPlatformEnabled(source.platform.id, false)
          await Promise.all(source.toolsets.map(ts => api.setToolsetEnabled(ts.name, false)))
          notify({ title: `${connection.name} disconnected`, body: 'Credentials stay in .env; enable it again any time.', level: 'success' })
          break
        case 'toolset':
          await api.setToolsetEnabled(source.toolset.name, false)
          notify({ title: `${connection.name} disconnected`, level: 'success' })
          break
        case 'provider':
          if (source.provider.disconnectable === false) {
            notify({ title: `${connection.name} cannot be signed out here`, body: source.provider.disconnect_hint ?? 'Sign out from the provider’s own tool.', level: 'warn' })
          } else {
            await api.disconnectProvider(source.provider.id)
            notify({ title: `Signed out of ${connection.name}`, level: 'success' })
          }

          break
      }

      if (selectedId === connection.id) {
        setSelectedId(null)
      }
    })
  }

  const toggleRow = (connection: Connection, row: ConnectionTool, enabled: boolean) => {
    if (!row.toggle) {
      return
    }

    const target = row.toggle
    setOptimistic(o => ({ ...o, [`${connection.id}/${row.id}`]: enabled }))
    void withBusy(connection.id, async () => {
      switch (target.kind) {
        case 'mcp-server':
          await api.setMcpEnabled(target.name, enabled)
          break
        case 'toolset':
          await api.setToolsetEnabled(target.name, enabled)
          break
        case 'messaging-platform':
          await api.setPlatformEnabled(target.id, enabled)
          break
      }
    })
  }

  const add = (item: BrowseItem, env?: Record<string, string>) => {
    void withBusy(item.id, async () => {
      const install = item.install

      switch (install.kind) {
        case 'mcp-catalog': {
          const result = await api.installCatalog(install.entry.name, env)
          notify({ title: `${item.name} added`, body: result.background ? 'Hermes is installing it in the background; it appears once ready.' : 'Available to Hermes on its next session.', level: 'success' })
          setTab('connected')
          setSelectedId(`mcp:${install.entry.name}`)
          break
        }
        case 'toolset':
        case 'messaging':
          openHermesFor(item.name)
          break
        case 'provider':
          await startProviderSignIn(install.provider.id, install.provider.name, install.provider.flow, install.provider.cli_command)
          break
      }
    })
  }

  const actions: ConnectionActions = { reconnect, setEnabled, remove }
  const firstLoad = loading && !data
  const failed = Boolean(error) && !data

  const openBrowse = () => {
    setTab('browse')
    setFocusSearch(n => n + 1)
  }

  return (
    <div className="page-enter flex h-full flex-col">
      <PageHeader
        icon="connections"
        title="Connections"
        subtitle="Bring your tools into one workspace."
        actions={
          <>
            <div ref={searchRef}>
              <SearchField value={query} onChange={setQuery} placeholder="Find a connection" className="w-56" />
            </div>
            <GlassButton variant="primary" onClick={openBrowse} aria-label="Add connection">
              <IconPlus />
              Add connection
            </GlassButton>
          </>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 pb-6">
        <div className="flex items-center justify-between gap-3">
          <Tabs tabs={tabs} value={tab} onChange={setTab} />
          {data?.warnings.length ? <span className="truncate text-[12px] text-warn" title={data.warnings.join('\n')}>Some sources did not load</span> : null}
        </div>

        {failed ? (
          <EmptyGlass
            icon={<IconPlugConnected />}
            title="Hermes did not answer"
            description={error ?? undefined}
            className="flex-1"
            action={
              <GlassButton size="sm" onClick={reload}>
                <IconRefresh />
                Try again
              </GlassButton>
            }
          />
        ) : tab === 'browse' ? (
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {firstLoad ? (
              <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
                {[0, 1, 2, 3, 4, 5].map(i => (
                  <ConnectionCardSkeleton key={i} />
                ))}
              </div>
            ) : (
              <AddConnection items={visibleBrowse} query={query} onAdd={add} busyId={busyId} />
            )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 gap-4">
            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto pr-1">
              {firstLoad ? (
                <div className="grid grid-cols-2 gap-3">
                  {[0, 1, 2, 3].map(i => (
                    <ConnectionCardSkeleton key={i} />
                  ))}
                </div>
              ) : visibleConnections.length === 0 ? (
                <EmptyGlass
                  icon={<IconPlugConnected />}
                  title={needle ? `Nothing matches “${query}”` : 'No connections yet'}
                  description={needle ? 'Try another name, or browse what you can add.' : 'Connect the tools you use and Hermes can work inside them.'}
                  className="h-full"
                  action={
                    <GlassButton size="sm" variant="primary" onClick={openBrowse}>
                      <IconLayoutGrid />
                      Browse
                    </GlassButton>
                  }
                />
              ) : (
                <div className="stagger grid grid-cols-2 gap-3">
                  {visibleConnections.map(connection => (
                    <ConnectionCard key={connection.id} connection={connection} selected={selected?.id === connection.id} onSelect={() => setSelectedId(connection.id)} actions={actions} busy={busyId === connection.id} />
                  ))}
                </div>
              )}
            </div>

            <GlassCard className="flex w-[330px] shrink-0 flex-col overflow-y-auto p-4">
              {firstLoad ? (
                <ConnectionDetailSkeleton />
              ) : selected ? (
                <ConnectionDetail
                  key={selected.id}
                  connection={selected}
                  activity={activity}
                  actions={actions}
                  onToggle={toggleRow}
                  probe={probes[selected.id]}
                  confirmingRemove={confirmId === selected.id}
                  onConfirmRemove={() => confirmRemove(selected)}
                  onCancelRemove={() => setConfirmId(null)}
                  busy={busyId === selected.id}
                />
              ) : (
                <div className="flex flex-1 items-center justify-center text-center text-[12.5px] text-fg-4">Select a connection to manage what Hermes may do with it.</div>
              )}
            </GlassCard>
          </div>
        )}
      </div>
    </div>
  )
}

/** Apply optimistic toggles and live probe results on top of the backend snapshot. */
function decorate(connection: Connection, optimistic: Record<string, boolean>, probes: Record<string, ProbeState>, probeTools: Record<string, string[]>): Connection {
  let next = connection
  const probe = probes[connection.id]
  const liveTools = probeTools[connection.id]

  if (connection.source.kind === 'mcp' && connection.source.server.enabled) {
    if (probe?.phase === 'failed') {
      const status = /oauth|unauthori[sz]ed|401|token/i.test(probe.error ?? '') ? 'needs-auth' : 'error'
      next = { ...next, status }
    }

    if (liveTools && liveTools.length > 0) {
      const serverRow = next.tools.find(row => row.id === 'server')
      const groups = groupTools(liveTools, connection.source.server.name).map(group => ({ ...group, enabled: connection.source.kind === 'mcp' && connection.source.server.enabled }))
      next = { ...next, tools: serverRow ? [serverRow, ...groups] : groups }
    }
  }

  return {
    ...next,
    tools: next.tools.map(row => {
      const pending = optimistic[`${connection.id}/${row.id}`]

      return pending == null ? row : { ...row, enabled: pending }
    })
  }
}
