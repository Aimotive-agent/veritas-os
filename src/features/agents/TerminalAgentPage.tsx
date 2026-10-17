import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'
import { Spinner } from '../../components/ui/primitives.tsx'
import { $terminalAgents } from '../../store/terminal.ts'
import { TerminalView } from '../terminal/TerminalView.tsx'

/**
 * One terminal coding agent (Copilot, Claude Code, …) embedded in the main window — the same place
 * Hermes and OpenCode live. A real PTY runs the agent's CLI, rendered like any other agent page.
 */
export function TerminalAgentPage({ agentId, active = true }: { agentId: string; active?: boolean }) {
  const agents = useStore($terminalAgents)
  const agent = agents.find(candidate => candidate.id === agentId) ?? null
  const [handleId, setHandleId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true

    window.heraldOS.terminal
      .create({ cols: 120, rows: 30, program: agentId })
      .then(handle => {
        if (!mounted.current) {
          void window.heraldOS.terminal.dispose(handle.id)

          return
        }

        setHandleId(handle.id)
        setError(null)
      })
      .catch(err => setError(err instanceof Error ? err.message : String(err)))

    return () => {
      mounted.current = false
    }
  }, [agentId])

  return (
    <div className="flex h-full flex-col">
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
