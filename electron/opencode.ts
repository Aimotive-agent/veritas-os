import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { OpencodeMcpServer } from '../shared/ipc.ts'

/*
 * Reads OpenCode's configured MCP servers (~/.config/opencode/opencode.json) so the Connections
 * page can show them beside Hermes's. OpenCode marks a server off with `disabled: true`; a bearer
 * `Authorization` header counts as header auth, and an `oauth` block (not false) as OAuth.
 */

export function listOpencodeMcpServers(): OpencodeMcpServer[] {
  try {
    const file = path.join(os.homedir(), '.config', 'opencode', 'opencode.json')
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcp?: { servers?: Record<string, unknown> } }
    const servers = raw.mcp?.servers ?? {}
    const out: OpencodeMcpServer[] = []

    for (const [name, value] of Object.entries(servers)) {
      if (!value || typeof value !== 'object') {
        continue
      }

      const cfg = value as Record<string, unknown>
      const type = cfg.type === 'local' ? 'local' : 'remote'
      const headers = cfg.headers && typeof cfg.headers === 'object' ? (cfg.headers as Record<string, unknown>) : {}
      const hasBearer = Boolean(headers.Authorization || headers.authorization)
      const auth: OpencodeMcpServer['auth'] = cfg.oauth && cfg.oauth !== false ? 'oauth' : hasBearer ? 'header' : 'none'

      out.push({
        name,
        type,
        url: typeof cfg.url === 'string' ? cfg.url : undefined,
        command: Array.isArray(cfg.command) ? cfg.command.map(String) : undefined,
        enabled: cfg.disabled !== true,
        auth
      })
    }

    return out.sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}
