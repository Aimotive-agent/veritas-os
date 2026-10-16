import { ok, type OsCommand } from '../store/os-commands.ts'
import { showPage } from '../store/windows.ts'

/* Agent Hub: the primary Hermes backend plus every extra agent the shell runs beside it. */

export const agentsHubCommands: readonly OsCommand[] = [
  {
    id: 'agents.hub',
    title: 'Open Agents',
    description: 'Open the Agent Hub: Hermes, OpenCode and every agent you run.',
    tier: 'read',
    args: [],
    phrases: ['show my agents', 'open agents', 'agent hub', 'what agents are running', 'show agents'],
    run: async () => {
      showPage('agents')
      const extra = await window.heraldOS.agents.list()
      const ready = extra.filter(agent => agent.phase === 'ready')

      return ok(`Agents: Hermes (primary)${extra.length ? `, ${ready.length} of ${extra.length} extra ready` : ', no extra agents'}`, {
        page: 'agents',
        spoken: extra.length ? `Hermes plus ${ready.map(agent => agent.name).join(', ') || 'no extra agents'}.` : 'Just Hermes for now.',
        items: [
          { id: 'hermes', name: 'Hermes', kind: 'primary' },
          ...extra.map(agent => ({ id: agent.id, name: agent.name, kind: agent.kind, status: agent.phase }))
        ]
      })
    }
  },
  {
    id: 'agents.launch',
    title: 'Start an agent',
    description: 'Start an extra agent (OpenCode, or one you added).',
    tier: 'act',
    args: [{ name: 'name', type: 'string', description: 'Agent name or id', required: true }],
    phrases: ['start the {name} agent', 'launch {name}'],
    run: async ({ name }) => {
      const needle = String(name).toLowerCase()
      const agents = await window.heraldOS.agents.list()
      const agent = agents.find(a => a.id.toLowerCase() === needle || a.name.toLowerCase() === needle)

      if (!agent) {
        return ok(agents.length ? `No agent matches "${String(name)}". Known: ${agents.map(a => a.name).join(', ')}` : 'No extra agents are registered.')
      }

      await window.heraldOS.agents.start(agent.id)
      showPage('agents')

      return ok(`Starting ${agent.name}`, { page: 'agents' })
    }
  }
]
