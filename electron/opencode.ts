import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { OpencodeMcpServer } from '../shared/ipc.ts'
import { log } from './log.ts'

/*
 * Reads OpenCode's configured MCP servers (~/.config/opencode/opencode.json) so the Connections
 * page can show them beside Hermes's. OpenCode marks a server off with `disabled: true`; a bearer
 * `Authorization` header counts as header auth, and an `oauth` block (not false) as OAuth.
 */

/**
 * The OpenCode binary, bypassing the `~/.local/bin/opencode` mise wrapper. That wrapper runs
 * `mise use -g` before every launch — a network call that takes the global mise lock — which can
 * block a headless agent for minutes and then time out. The versioned install is the same binary
 * without the detour, so use it whenever it is there.
 */
export function opencodeBin(): string {
  const candidates = [
    path.join(os.homedir(), '.opencode', 'bin', 'opencode'),
    path.join(os.homedir(), '.local', 'share', 'mise', 'installs', 'opencode', 'latest', 'node_modules', '.bin', 'opencode'),
    path.join(os.homedir(), '.local', 'bin', 'opencode')
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  return 'opencode'
}

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

/**
 * The OpenCode service caches each MCP server's tool list and only re-reads it when that server's
 * config entry changes. Veritas OS gains tools over time, so a stale cache leaves the agent unable
 * to find them: it searches for the tool forever and the request times out. Toggling the entry
 * forces a reconnect, and the client re-enumerates the tools.
 */
export function refreshOpencodeMcpCatalog(): void {
  const file = path.join(os.homedir(), '.config', 'opencode', 'opencode.json')
  let config: { mcp?: { servers?: Record<string, { disabled?: boolean }> } }

  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof config
  } catch {
    return
  }

  if (!config.mcp?.servers?.veritas) {
    return
  }

  try {
    config.mcp.servers.veritas.disabled = true
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  } catch (error) {
    log('opencode', `could not pause the veritas MCP entry: ${error instanceof Error ? error.message : String(error)}`)

    return
  }

  // Give OpenCode a moment to notice the server is gone before re-enabling it.
  setTimeout(() => {
    try {
      const next = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof config
      const entry = next.mcp?.servers?.veritas

      if (entry) {
        delete entry.disabled
        fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
        log('opencode', 'refreshed the veritas MCP tool catalog')
      }
    } catch {
      // The config changed under us; leave it alone.
    }
  }, 4000)
}
