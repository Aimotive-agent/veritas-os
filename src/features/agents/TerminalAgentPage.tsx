import { useStore } from '@nanostores/react'
import { IconX } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { Button } from '../../components/ui/button.tsx'
import { Spinner } from '../../components/ui/primitives.tsx'
import { $terminalAgents, $terminalRuns, unpinTerminalAgent } from '../../store/terminal.ts'
import { showPage } from '../../store/windows.ts'
import { TerminalView } from '../terminal/TerminalView.tsx'

/**
 * One terminal coding agent (Copilot, Claude Code, …) embedded in the main window — the same place
 * Hermes and OpenCode live. A real PTY runs the agent's CLI, rendered like any other agent page.
 * Closing it stops the CLI and removes the agent from the sidebar.
 */
export function TerminalAgentPage({ agentId, active = true }: { agentId: string; active?: boolean }) {
  const agents = useStore($terminalAgents)
  const runs = useStore($terminalRuns)
  const agent = agents.find(candidate => candidate.id === agentId) ?? null
  const [handleId, setHandleId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // (Re)create the PTY whenever the agent is opened; the previous one is disposed on a re-open.
  useEffect(() => {
    let cancelled = false
    let created: string | null = null

    setHandleId(null)
    setError(null)
    window.heraldOS.terminal
      .create({ cols: 120, rows: 30, program: agentId })
      .then(handle => {
        if (cancelled) {
          void window.heraldOS.terminal.dispose(handle.id)

          return
        }

        created = handle.id
        setHandleId(handle.id)
      })
      .catch(err => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      })

    return () => {
      cancelled = true
      if (created) {
        void window.heraldOS.terminal.dispose(created)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, runs[agentId]])

  const close = () => {
    if (handleId) {
      void window.heraldOS.terminal.dispose(handleId)
      setHandleId(null)
    }

    unpinTerminalAgent(agentId)
    showPage('overview')
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-line px-3">
        <span className="truncate text-[12.5px] font-medium text-fg-2">{agent?.label ?? agentId}</span>
        <Button variant="ghost" size="icon-sm" aria-label={`Stop ${agent?.label ?? agentId}`} onClick={close}>
          <IconX size={15} />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1 px-3 pb-3">
        {error ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 text-[13px] text-fg-3">
            <div>Could not start {agent?.label ?? agentId}</div>
            <div className="max-w-md text-center text-[12px] text-fg-4">{error}</div>
          </div>
        ) : handleId ? (
          <TerminalView id={handleId} active={active} />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        )}
      </div>
    </div>
  )
}
