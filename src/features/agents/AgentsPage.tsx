import { useStore } from '@nanostores/react'
import { IconCopy, IconLink, IconPlayerPlay, IconPlayerStop, IconRefresh, IconTerminal2, IconWorld } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { EmptyGlass, GlassButton, GlassCard, PageHeader, Pill, Section, StatusDot } from '../../components/ui/glass.tsx'
import type { AgentPairResult, AgentSnapshot, BackendState } from '../../../shared/ipc.ts'
import { notify } from '../../store/notifications.ts'
import { $backend } from '../../store/backend.ts'
import { openWebWindow } from '../../store/web-windows.ts'
import { showPage } from '../../store/windows.ts'
import { cn } from '../../lib/cn.ts'
import { PopularCliAgents } from './PopularCliAgents.tsx'

/*
 * Agent Hub: the primary Hermes backend plus every extra agent (OpenCode and anything added in
 * ~/.config/veritas-os/agents.json). Each row starts, restarts, stops and — when the agent ships a
 * web UI — opens it in a Veritas OS window beside the shell.
 */

const PHASE_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'muted'> = {
  ready: 'ok',
  starting: 'warn',
  restarting: 'warn',
  stopped: 'muted',
  failed: 'danger'
}

const PHASE_LABEL: Record<string, string> = {
  ready: 'Ready',
  starting: 'Starting',
  restarting: 'Restarting',
  stopped: 'Stopped',
  failed: 'Failed',
  idle: 'Idle',
  resolving: 'Resolving'
}

export function AgentsPage() {
  const backend = useStore($backend)
  const [agents, setAgents] = useState<AgentSnapshot[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [openLogs, setOpenLogs] = useState<string | null>(null)

  useEffect(() => {
    void window.heraldOS.agents.list().then(setAgents)
    return window.heraldOS.agents.onChanged(setAgents)
  }, [])

  const run = async (id: string, action: 'start' | 'stop' | 'restart') => {
    setBusy(`${id}:${action}`)
    try {
      const next = await window.heraldOS.agents[action](id)
      setAgents(next)
    } catch (error) {
      notify({ title: 'Agent action failed', body: error instanceof Error ? error.message : String(error), level: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const openAgentUi = async (agent: AgentSnapshot) => {
    if (!agent.embedUrl) {
      return
    }
    try {
      await openWebWindow(agent.embedUrl, { title: agent.name })
    } catch (error) {
      notify({ title: `Could not open ${agent.name}`, body: error instanceof Error ? error.message : String(error), level: 'error' })
    }
  }

  return (
    <div className="page-enter flex h-full flex-col">
      <PageHeader
        icon="agents"
        title="Agents"
        subtitle="Hermes, OpenCode and every agent you add — running side by side."
        actions={
          <GlassButton
            variant="secondary"
            onClick={() => {
              void window.heraldOS.agents.list().then(setAgents)
            }}
          >
            <IconRefresh /> Refresh
          </GlassButton>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 pb-6">
        <Section title="Primary">
          <PrimaryCard backend={backend} />
        </Section>
        <Section title="Additional agents">
          {agents.length === 0 ? (
            <EmptyGlass
              icon={<IconTerminal2 />}
              title="No extra agents yet"
              description="Add one in ~/.config/veritas-os/agents.json (command, health URL, optional web UI)."
            />
          ) : (
            <div className="flex flex-col gap-3">
              {agents.map(agent => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  busy={busy}
                  logsOpen={openLogs === agent.id}
                  onToggleLogs={() => setOpenLogs(current => (current === agent.id ? null : agent.id))}
                  onAction={run}
                  onOpen={() => void openAgentUi(agent)}
                />
              ))}
            </div>
          )}
        </Section>
        <PopularCliAgents />
      </div>
    </div>
  )
}

function PrimaryCard({ backend }: { backend: BackendState }) {
  const phase = String(backend.phase)
  const tone = PHASE_TONE[phase] ?? 'muted'

  return (
    <GlassCard className="flex items-center gap-4 p-4">
      <div className="flex size-11 items-center justify-center rounded-xl bg-white/6 text-[15px] font-semibold text-fg">H</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13.5px] font-semibold text-fg">Hermes</span>
          <Pill tone={tone} dot>
            {PHASE_LABEL[phase] ?? phase}
          </Pill>
          {backend.port ? <span className="text-[12px] text-fg-3">:{backend.port}</span> : null}
        </div>
        <div className="truncate text-[12px] text-fg-3">
          {backend.error ?? 'The primary agent: your whole computer, one conversation.'}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <GlassButton variant="secondary" onClick={() => showPage('hermes')}>
          Open chat
        </GlassButton>
        <GlassButton
          variant="ghost"
          size="icon"
          aria-label="Restart Hermes"
          onClick={() => void window.heraldOS.backend.restart()}
        >
          <IconRefresh />
        </GlassButton>
      </div>
    </GlassCard>
  )
}

function AgentCard({
  agent,
  busy,
  logsOpen,
  onToggleLogs,
  onAction,
  onOpen
}: {
  agent: AgentSnapshot
  busy: string | null
  logsOpen: boolean
  onToggleLogs: () => void
  onAction: (id: string, action: 'start' | 'stop' | 'restart') => void
  onOpen: () => void
}) {
  const tone = PHASE_TONE[agent.phase] ?? 'muted'
  const ready = agent.phase === 'ready'
  const working = busy?.startsWith(`${agent.id}:`) ?? false
  const [pair, setPair] = useState<AgentPairResult | null>(null)
  const [pairBusy, setPairBusy] = useState(false)

  const requestPair = async () => {
    setPairBusy(true)
    setPair(null)
    try {
      setPair(await window.heraldOS.agents.pair(agent.id))
    } catch (error) {
      notify({ title: `Could not pair ${agent.name}`, body: error instanceof Error ? error.message : String(error), level: 'error' })
    } finally {
      setPairBusy(false)
    }
  }

  return (
    <GlassCard className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-4">
        <StatusDot tone={tone} pulse={agent.phase === 'starting' || agent.phase === 'restarting'} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] font-semibold text-fg">{agent.name}</span>
            <Pill tone={tone}>{PHASE_LABEL[agent.phase] ?? agent.phase}</Pill>
            <span className="text-[12px] text-fg-3">{agent.kind}</span>
            {agent.port ? <span className="text-[12px] text-fg-3">:{agent.port}</span> : null}
          </div>
          <div className="truncate text-[12px] text-fg-3">{agent.error ?? (agent.embedUrl ?? 'headless agent')}</div>
        </div>
        <div className="flex items-center gap-2">
          {ready && agent.embedUrl ? (
            <GlassButton variant="primary" onClick={onOpen}>
              <IconWorld /> Open UI
            </GlassButton>
          ) : null}
          {ready && agent.canPair ? (
            <GlassButton variant="secondary" disabled={pairBusy} onClick={() => void requestPair()}>
              <IconLink /> {pairBusy ? 'Pairing…' : 'Pair'}
            </GlassButton>
          ) : null}
          {ready ? (
            <GlassButton variant="ghost" size="icon" aria-label={`Restart ${agent.name}`} disabled={working} onClick={() => onAction(agent.id, 'restart')}>
              <IconRefresh />
            </GlassButton>
          ) : (
            <GlassButton variant="ghost" size="icon" aria-label={`Start ${agent.name}`} disabled={working} onClick={() => onAction(agent.id, 'start')}>
              <IconPlayerPlay />
            </GlassButton>
          )}
          <GlassButton variant="ghost" size="icon" aria-label={`Stop ${agent.name}`} disabled={working || agent.phase === 'stopped'} onClick={() => onAction(agent.id, 'stop')}>
            <IconPlayerStop />
          </GlassButton>
          <button
            type="button"
            onClick={onToggleLogs}
            className={cn('flex h-9 items-center rounded-lg px-3 text-[12.5px] text-fg-2 hover:bg-white/8', logsOpen && 'bg-white/8 text-fg')}
          >
            Logs
          </button>
        </div>
      </div>
      {pair ? (
        <div className="flex flex-col gap-2 rounded-lg border border-line bg-black/25 p-3">
          <div className="text-[11.5px] text-fg-3">
            {pair.links.length ? 'One-time link — works once, expires in 5 minutes.' : 'No link was printed:'}
          </div>
          {pair.links.map(link => (
            <div key={link} className="flex items-center gap-2">
              <input readOnly value={link} onFocus={event => event.currentTarget.select()} className="selectable min-w-0 flex-1 rounded-md border border-line bg-black/30 px-2.5 py-1.5 text-[12px] text-fg" />
              <GlassButton size="sm" variant="secondary" onClick={() => void copyLink(link)}>
                <IconCopy /> Copy
              </GlassButton>
              <GlassButton size="sm" variant="ghost" onClick={() => void window.heraldOS.shell.openExternal(link)}>
                Open
              </GlassButton>
            </div>
          ))}
          {!pair.links.length && pair.output ? (
            <pre className="selectable max-h-32 overflow-auto text-[11.5px] text-fg-2">{pair.output}</pre>
          ) : null}
        </div>
      ) : null}
      {logsOpen ? (
        <pre className="selectable max-h-56 overflow-auto rounded-lg border border-line bg-black/30 p-3 text-[11.5px] leading-relaxed text-fg-2">
          {(agent.logTail ?? []).join('\n') || 'No output yet.'}
        </pre>
      ) : null}
    </GlassCard>
  )
}


/** Copy a pairing link, falling back to a hidden textarea when the clipboard API is unavailable. */
async function copyLink(link: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(link)
    notify({ title: 'Pairing link copied', level: 'success' })
  } catch {
    const area = document.createElement('textarea')
    area.value = link
    document.body.appendChild(area)
    area.select()
    try {
      document.execCommand('copy')
      notify({ title: 'Pairing link copied', level: 'success' })
    } catch {
      notify({ title: 'Copy failed — select the link and copy it', level: 'warn' })
    }
    area.remove()
  }
}
