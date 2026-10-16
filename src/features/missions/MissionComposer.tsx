import { useStore } from '@nanostores/react'
import { IconRocket } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import type { AgentSnapshot } from '../../../shared/ipc.ts'
import { GlassButton } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import { $agentPages, bindAgentPages } from '../../store/agent-pages.ts'
import { startMission } from '../../store/missions-actions.ts'
import { notify } from '../../store/notifications.ts'

/** Every agent that can take a mission: Hermes always, plus any extra agent that knows how to run one. */
function useMissionAgents(): { id: string; name: string; detail: string }[] {
  bindAgentPages()
  const agents = useStore($agentPages)

  return [
    { id: 'hermes', name: 'Hermes', detail: 'plans steps, works through them, reports back' },
    ...agents.filter(agent => agent.canRun).map(agent => ({ id: agent.id, name: agent.name, detail: agent.phase === 'ready' ? 'ready' : agent.phase }))
  ]
}

export function MissionComposer({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('')
  const [agentId, setAgentId] = useState('hermes')
  const [starting, setStarting] = useState(false)
  const candidates = useMissionAgents()
  const chosen = candidates.find(candidate => candidate.id === agentId) ?? candidates[0]
  const ready = text.trim().length > 0 && !starting && Boolean(chosen)

  // An agent that goes away (stopped, failed) must not stay selected.
  useEffect(() => {
    if (!candidates.some(candidate => candidate.id === agentId)) {
      setAgentId('hermes')
    }
  }, [candidates, agentId])

  const start = async () => {
    const goal = text.trim()

    if (!goal || starting || !chosen) {
      return
    }

    setStarting(true)

    try {
      await startMission(goal, chosen.id)
      onClose()
    } catch (error) {
      notify({ title: `Could not start the mission on ${chosen.name}`, body: error instanceof Error ? error.message : String(error), level: 'error' })
      setStarting(false)
    }
  }

  return (
    <div className="glass-card animate-rise flex flex-col gap-3 rounded-xl p-4">
      <div className="flex items-center gap-2 text-[14px] font-semibold text-fg">
        <IconRocket size={16} className="text-accent-strong" />
        New mission
      </div>

      <textarea
        value={text}
        autoFocus
        rows={3}
        onChange={event => setText(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void start()
          }

          if (event.key === 'Escape') {
            onClose()
          }
        }}
        placeholder="What should it accomplish?"
        aria-label="Mission goal"
        className="glass-input w-full resize-none rounded-lg px-3 py-2.5 text-[13px] text-fg outline-none placeholder:text-fg-4"
      />

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11.5px] text-fg-3">Run with</span>
        {candidates.map(candidate => {
          const active = candidate.id === chosen?.id

          return (
            <button
              key={candidate.id}
              type="button"
              onClick={() => setAgentId(candidate.id)}
              title={candidate.detail}
              className={cn(
                'rounded-full border px-3 py-1 text-[12px] transition-colors',
                active ? 'border-accent-strong/60 bg-accent text-accent-fg' : 'border-line bg-white/5 text-fg-2 hover:bg-white/10 hover:text-fg'
              )}
            >
              {candidate.name}
            </button>
          )
        })}
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-[11.5px] text-fg-3">
          {chosen?.id === 'hermes' ? 'Hermes plans the steps, works through them and reports back.' : `${chosen?.name} takes the goal as a prompt — its page shows the work.`}
        </span>
        <div className="flex items-center gap-2">
          <GlassButton size="sm" variant="ghost" onClick={onClose} disabled={starting}>
            Cancel
          </GlassButton>
          <GlassButton size="sm" variant="primary" onClick={() => void start()} disabled={!ready}>
            {starting ? 'Starting…' : 'Start mission'}
          </GlassButton>
        </div>
      </div>
    </div>
  )
}
