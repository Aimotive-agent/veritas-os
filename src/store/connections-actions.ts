import { atom } from 'nanostores'
import { api, type Connection, loadConnections } from '../features/connections/connections-model.ts'
import { notify } from './notifications.ts'

/*
 * Connection mutations shared by the Connections page, the command registry and the agent. The page
 * loads through `loadConnections`; `$connectionsTick` tells it to reload after an external change.
 */

export const $connectionsTick = atom(0)

const bump = () => $connectionsTick.set($connectionsTick.get() + 1)

/** Case-insensitive lookup by name (exact, then contains). */
export async function findConnection(query: string): Promise<{ connection: Connection | null; candidates: Connection[] }> {
  const needle = query.trim().toLowerCase()
  const { connections } = await loadConnections()

  if (!needle) {
    return { connection: null, candidates: connections }
  }

  const exact = connections.filter(c => c.name.toLowerCase() === needle || c.id.toLowerCase() === needle)

  if (exact.length === 1) {
    return { connection: exact[0], candidates: exact }
  }

  const partial = connections.filter(c => c.name.toLowerCase().includes(needle) || c.description.toLowerCase().includes(needle))

  return { connection: partial.length === 1 ? partial[0] : null, candidates: partial }
}

/** Enable or disable a connection the way the page's toggle does; providers are signed in/out instead. */
export async function setConnectionEnabled(connection: Connection, enabled: boolean): Promise<void> {
  const source = connection.source

  switch (source.kind) {
    case 'mcp':
      await api.setMcpEnabled(source.server.name, enabled)
      notify({ title: `${connection.name} ${enabled ? 'enabled' : 'disabled'}`, body: 'Takes effect on the next Hermes session.', level: 'success' })
      break
    case 'messaging':
      await api.setPlatformEnabled(source.platform.id, enabled)
      await Promise.all(source.toolsets.map(ts => api.setToolsetEnabled(ts.name, enabled)))
      notify({ title: `${connection.name} ${enabled ? 'enabled' : 'disabled'}`, body: enabled ? 'Restart the gateway to start receiving messages.' : undefined, level: 'success' })
      break
    case 'toolset':
      await api.setToolsetEnabled(source.toolset.name, enabled)
      notify({ title: `${connection.name} ${enabled ? 'enabled' : 'disabled'}`, level: 'success' })
      break
    case 'provider':
      throw new Error(`${connection.name} is a sign-in, not a switch; use sign in or sign out.`)
  }

  bump()
}
