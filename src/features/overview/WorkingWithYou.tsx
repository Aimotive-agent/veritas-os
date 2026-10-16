import { useStore } from '@nanostores/react'
import { IconChevronRight } from '@tabler/icons-react'
import { GlassCard, Section } from '../../components/ui/glass.tsx'
import { $agents } from '../../store/agents.ts'
import { $activeChatId, $chats } from '../../store/chat.ts'
import { showPage } from '../../store/windows.ts'
import { agentNameFor, Avatar, Quiet, titleCase } from './shared.tsx'

/*
 * Who is working right now: live subagents (running or queued) and any chat session that is
 * streaming a turn. Rows open the place where that work can be followed.
 */

interface Worker {
  id: string
  name: string
  state: string
  avatar: string
  open: () => void
}

const TOOL_VERB: Record<string, string> = {
  terminal: 'Running a command',
  read_file: 'Reading a file',
  write_file: 'Writing a file',
  patch: 'Editing a file',
  search_files: 'Searching files',
  web_search: 'Searching the web',
  web_extract: 'Reading sources',
  browser_navigate: 'Browsing the web',
  delegate_task: 'Delegating work',
  todo_list: 'Updating the plan',
  memory: 'Updating memory',
  system_find_files: 'Searching for files',
  system_open: 'Opening something',
  system_files: 'Organising files',
  system_processes: 'Inspecting processes'
}

function oneLine(text: string | undefined, max = 60): string {
  const line = (text ?? '').split('\n').map(l => l.trim()).find(Boolean) ?? ''

  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function WorkingWithYou() {
  const agents = useStore($agents)
  const chats = useStore($chats)
  const workers: Worker[] = []

  for (const agent of Object.values(agents)) {
    if (agent.status !== 'running' && agent.status !== 'queued') {
      continue
    }

    const state = agent.status === 'queued' ? 'Waiting to start' : oneLine(agent.lastText) || (agent.toolName ? TOOL_VERB[agent.toolName] ?? `Using ${agent.toolName.replace(/_/g, ' ')}` : 'Working')

    workers.push({ id: `agent-${agent.id}`, name: agentNameFor(agent.goal), state, avatar: agent.goal, open: () => showPage('missions') })
  }

  for (const chat of Object.values(chats)) {
    if (!chat.streaming) {
      continue
    }

    const runningTool = [...chat.messages].reverse().find(m => m.role === 'tool' && m.running)
    const state = chat.status?.text || (runningTool && runningTool.role === 'tool' ? TOOL_VERB[runningTool.name] ?? titleCase(runningTool.name.replace(/_/g, ' ')) : 'Thinking')

    workers.push({
      id: `chat-${chat.sessionId}`,
      name: chat.title ? oneLine(chat.title, 32) : 'Hermes',
      state: oneLine(state),
      avatar: chat.title || 'Hermes',
      open: () => {
        $activeChatId.set(chat.sessionId)
        showPage('hermes')
      }
    })
  }

  workers.sort((a, b) => a.name.localeCompare(b.name))

  return (
    <Section title="Working with you">
      {workers.length === 0 ? (
        <Quiet>Hermes is idle.</Quiet>
      ) : (
        <GlassCard className="stagger flex flex-col divide-y divide-line p-1">
          {workers.map(worker => (
            <button key={worker.id} type="button" onClick={worker.open} className="flex items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors duration-120 hover:bg-white/6" aria-label={`Open ${worker.name}`}>
              <Avatar label={worker.avatar} size={30} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-medium text-fg" title={worker.name}>
                  {worker.name}
                </div>
                <div className="flex items-center gap-1.5 text-[11.5px] text-fg-3">
                  <span className="size-1.5 shrink-0 rounded-full bg-progress animate-pulse-soft" aria-hidden="true" />
                  <span className="truncate" title={worker.state}>
                    {worker.state}
                  </span>
                </div>
              </div>
              <IconChevronRight size={14} className="shrink-0 text-fg-4" aria-hidden="true" />
            </button>
          ))}
        </GlassCard>
      )}
    </Section>
  )
}
