import { useStore } from '@nanostores/react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Spinner } from '../../components/ui/primitives.tsx'
import { $agentPages, bindAgentPages } from '../../store/agent-pages.ts'

/**
 * One agent's surface inside the main window — the same place Hermes lives, not a floating window.
 * The agent's own web UI is a native view owned by main; this page reports its content rect so the
 * view sits exactly in the page area, and shows why it is not there while the agent is starting.
 */
export function AgentPage({ agentId, active = true }: { agentId: string; active?: boolean }) {
  bindAgentPages()
  const agents = useStore($agentPages)
  const agent = agents.find(candidate => candidate.id === agentId) ?? null
  const content = useRef<HTMLDivElement>(null)
  const [viewId, setViewId] = useState<string | null>(null)

  const embedUrl = agent?.phase === 'ready' ? agent.embedUrl : null

  // Auto-start a stopped agent when its page is opened (matches how terminal agents run on open).
  useEffect(() => {
    if (active && agent?.phase === 'stopped') {
      void window.heraldOS.agents.start(agentId)
    }
  }, [active, agent?.phase, agentId])

  // (Re)open the view whenever the agent's URL changes (a restart hands out a new port).
  useLayoutEffect(() => {
    if (!embedUrl) {
      return
    }

    let alive = true
    void window.heraldOS.web
      .open(embedUrl, { title: agent?.name ?? agentId })
      .then(id => {
        if (alive) {
          setViewId(id)
        } else {
          void window.heraldOS.web.close(id)
        }
      })
      .catch(() => undefined)

    return () => {
      alive = false
    }
  }, [embedUrl, agent?.name, agentId])

  useLayoutEffect(() => {
    if (!viewId) {
      return
    }

    const node = content.current

    if (!node) {
      return
    }

    let frame = 0
    const report = () => {
      const rect = node.getBoundingClientRect()
      // A native view floats above the DOM: it must hide the moment its page is not the active one,
      // otherwise it swallows clicks meant for the rest of the shell.
      const show = active && rect.width >= 60 && rect.height >= 60
      window.heraldOS.web.setBounds(viewId, { x: rect.left, y: rect.top, width: rect.width, height: rect.height, radius: 0 }, show)
    }

    report()
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(report)
    })
    observer.observe(node)
    window.addEventListener('resize', report)
    const interval = setInterval(report, 600)

    return () => {
      cancelAnimationFrame(frame)
      clearInterval(interval)
      observer.disconnect()
      window.removeEventListener('resize', report)
      window.heraldOS.web.setBounds(viewId, { x: 0, y: 0, width: 1, height: 1, radius: 0 }, false)
    }
  }, [viewId, active])

  return (
    <div className="flex h-full flex-col">
      <div className="relative min-h-0 flex-1" ref={content}>
        {!embedUrl ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-fg-3">
            <Spinner />
            <div>
              {agent ? `${agent.name} is ${agent.phase}${agent.error ? ` — ${agent.error}` : ''}…` : `${agentId} is not registered`}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
