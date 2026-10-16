import { findConnection, setConnectionEnabled } from '../store/connections-actions.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'
import { showPage } from '../store/windows.ts'
import { loadConnections, STATUS_LABEL } from '../features/connections/connections-model.ts'

/* Connections: MCP servers, messaging platforms, toolsets, provider sign-ins. */

export const connectionCommands: readonly OsCommand[] = [
  {
    id: 'connection.list',
    title: 'List connections',
    description: 'Open Connections and list what is connected.',
    tier: 'read',
    args: [],
    phrases: ['show my connections', 'list connections', 'what is connected', 'show integrations'],
    run: async () => {
      showPage('connections')
      const { connections } = await loadConnections()
      const connected = connections.filter(c => c.status === 'connected')

      return ok(`${connected.length} of ${connections.length} connections connected`, {
        page: 'connections',
        spoken: connected.length ? `${connected.length} connected: ${connected.slice(0, 5).map(c => c.name).join(', ')}.` : 'Nothing is connected yet.',
        items: connections.map(c => ({ id: c.id, name: c.name, kind: c.kind, status: STATUS_LABEL[c.status], scope: c.scope }))
      })
    }
  },
  {
    id: 'connection.show',
    title: 'Show a connection',
    description: 'Open Connections focused on one integration.',
    tier: 'read',
    args: [{ name: 'name', type: 'string', description: 'Connection name', required: true }],
    phrases: ['show the {name} connection', 'open {name} connection'],
    run: async ({ name }) => {
      const { connection, candidates } = await findConnection(String(name))

      if (!connection) {
        return candidates.length ? fail(`Which connection? ${candidates.map(c => c.name).slice(0, 5).join(', ')}`) : fail(`No connection matches "${String(name)}".`)
      }

      showPage('connections')

      return ok(`${connection.name}: ${STATUS_LABEL[connection.status]}`, { page: 'connections', highlight: { kind: 'connection', id: connection.id }, data: { id: connection.id, status: connection.status, tools: connection.tools.map(t => t.label) } })
    }
  },
  {
    id: 'connection.enable',
    title: 'Enable a connection',
    description: 'Turn a connection on.',
    tier: 'mutate',
    args: [{ name: 'name', type: 'string', description: 'Connection name', required: true }],
    phrases: ['enable {name}', 'turn on {name}', 'connect {name}'],
    run: async ({ name }) => {
      const { connection, candidates } = await findConnection(String(name))

      if (!connection) {
        return candidates.length ? fail(`Which connection? ${candidates.map(c => c.name).slice(0, 5).join(', ')}`) : fail(`No connection matches "${String(name)}".`)
      }

      await setConnectionEnabled(connection, true)
      showPage('connections')

      return ok(`Enabled ${connection.name}`, { page: 'connections', highlight: { kind: 'connection', id: connection.id } })
    }
  },
  {
    id: 'connection.disable',
    title: 'Disable a connection',
    description: 'Turn a connection off (credentials are kept).',
    tier: 'mutate',
    args: [{ name: 'name', type: 'string', description: 'Connection name', required: true }],
    phrases: ['disable {name}', 'turn off {name}', 'disconnect {name}'],
    run: async ({ name }) => {
      const { connection, candidates } = await findConnection(String(name))

      if (!connection) {
        return candidates.length ? fail(`Which connection? ${candidates.map(c => c.name).slice(0, 5).join(', ')}`) : fail(`No connection matches "${String(name)}".`)
      }

      await setConnectionEnabled(connection, false)
      showPage('connections')

      return ok(`Disabled ${connection.name}`, { page: 'connections', highlight: { kind: 'connection', id: connection.id } })
    }
  }
]
