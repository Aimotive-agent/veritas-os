import { rest } from '../../lib/rest.ts'
import type { ActivityEntry } from '../../store/missions.ts'

/*
 * A Connection is a uniform view over three upstream things the Hermes runtime exposes over REST:
 * MCP servers (config.yaml `mcp_servers`), messaging platforms + service toolsets, and OAuth
 * providers. Everything below is derived; nothing is stored except the "allowed folders" chips.
 */

/* ---- Upstream REST shapes (verified against hermes_cli/web_routers/*.py) ------------------ */

/** Row of `GET /api/mcp/servers` (`_mcp_server_summary` in web_server.py). */
export interface McpServerRow {
  name: string
  transport: 'http' | 'stdio' | 'unknown'
  url?: string | null
  command?: string | null
  args?: string[]
  env?: Record<string, string>
  auth?: 'oauth' | 'header' | 'none' | null
  enabled: boolean
  /** Enabled tool names, or null = all tools. */
  tools?: string[] | null
}

/** Entry of `GET /api/mcp/catalog` (`list_mcp_catalog` in web_routers/mcp.py). */
export interface McpCatalogEntry {
  name: string
  description: string
  source?: string
  transport?: string
  auth_type?: string
  required_env?: { name: string; prompt?: string; required?: boolean }[]
  command?: string | null
  args?: string[]
  url?: string | null
  needs_install?: boolean
  installed: boolean
  enabled: boolean
  post_install?: string
  default_enabled?: string[] | null
}

/** Result of `POST /api/mcp/servers/{name}/test`. */
export interface McpProbeResult {
  ok: boolean
  error?: string
  tools: { name: string; description?: string }[]
  prompts?: number
  resources?: number
}

/** Snapshot of `POST /api/mcp/servers/{name}/auth` (DashboardOAuthFlow.snapshot). */
export interface McpOAuthSnapshot {
  flow_id: string
  server_name: string
  status: string
  authorization_url?: string | null
  error?: string | null
}

/** Row of `GET /api/tools/toolsets` (web_routers/tools.py `get_toolsets`). */
export interface ToolsetRow {
  name: string
  label: string
  description: string
  platform: string
  platform_label?: string
  enabled: boolean
  available?: boolean
  /** True when the toolset's provider keys / env vars are satisfied. */
  configured: boolean
  tools: string[]
}

/** Row of `GET /api/messaging/platforms` (`_messaging_platform_payload` in web_server.py). */
export interface MessagingPlatformRow {
  id: string
  name: string
  description: string
  docs_url?: string | null
  enabled: boolean
  configured: boolean
  gateway_running?: boolean
  state?: 'disabled' | 'not_configured' | 'pending_restart' | 'startup_failed' | 'gateway_stopped' | string | null
  error_code?: string | null
  error_message?: string | null
  updated_at?: string | null
  env_vars?: { key: string; required: boolean; is_set: boolean }[]
}

/** Row of `GET /api/providers/oauth` (`list_oauth_providers` in web_server.py). */
export interface OAuthProviderRow {
  id: string
  name: string
  flow: 'device_code' | 'external' | string
  cli_command?: string | null
  docs_url?: string | null
  disconnect_hint?: string | null
  disconnect_command?: string | null
  disconnectable?: boolean
  status: {
    logged_in: boolean
    source?: string | null
    source_label?: string | null
    token_preview?: string | null
    expires_at?: string | null
    has_refresh_token?: boolean
  }
}

/** Result of `POST /api/providers/oauth/{id}/start` for device-code flows. */
export interface OAuthStartResult {
  session_id: string
  flow: string
  user_code?: string
  verification_url?: string
  expires_in?: number
  poll_interval?: number
}

/* ---- Normalised model --------------------------------------------------------------------- */

export type ConnectionKind = 'mcp' | 'platform' | 'provider'
export type ConnectionStatus = 'connected' | 'needs-auth' | 'error' | 'disabled' | 'available'

/** What flipping a permission row actually writes upstream. */
export type ToggleTarget = { kind: 'mcp-server'; name: string } | { kind: 'toolset'; name: string } | { kind: 'messaging-platform'; id: string }

export interface ConnectionTool {
  id: string
  label: string
  enabled: boolean
  /** Present when the row is a real switch; absent rows are read-only capability lines. */
  toggle?: ToggleTarget
  /** Raw upstream tool names this row summarises. */
  tools: string[]
}

export interface Connection {
  id: string
  kind: ConnectionKind
  name: string
  description: string
  status: ConnectionStatus
  /** One line, e.g. "Files and documents". */
  scope: string
  tools: ConnectionTool[]
  logoKey: string
  lastActivity?: number
  allowedFolders?: string[]
  /** Kind-specific upstream data the actions need. */
  source: { kind: 'mcp'; server: McpServerRow; catalog?: McpCatalogEntry } | { kind: 'messaging'; platform: MessagingPlatformRow; toolsets: ToolsetRow[] } | { kind: 'toolset'; toolset: ToolsetRow } | { kind: 'provider'; provider: OAuthProviderRow }
}

/** Something the Browse tab can add. */
export interface BrowseItem {
  id: string
  name: string
  description: string
  scope: string
  logoKey: string
  category: string
  install: { kind: 'mcp-catalog'; entry: McpCatalogEntry } | { kind: 'toolset'; toolset: ToolsetRow } | { kind: 'messaging'; platform: MessagingPlatformRow } | { kind: 'provider'; provider: OAuthProviderRow }
}

export interface ConnectionsSnapshot {
  connections: Connection[]
  browse: BrowseItem[]
  /** Upstream loaders that failed; the page still renders what it has. */
  warnings: string[]
}

export const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connected: 'Connected',
  'needs-auth': 'Needs setup',
  error: 'Error',
  disabled: 'Disabled',
  available: 'Available'
}

export const STATUS_TONE: Record<ConnectionStatus, 'ok' | 'warn' | 'danger' | 'muted'> = {
  connected: 'ok',
  'needs-auth': 'warn',
  error: 'danger',
  disabled: 'muted',
  available: 'muted'
}

/* ---- Loading ------------------------------------------------------------------------------ */

async function settle<T>(label: string, promise: Promise<T>, fallback: T, warnings: string[]): Promise<T> {
  try {
    return await promise
  } catch (error) {
    warnings.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)

    return fallback
  }
}

export async function loadConnections(): Promise<ConnectionsSnapshot> {
  const warnings: string[] = []
  const [servers, catalog, toolsets, messaging, providers] = await Promise.all([
    settle('MCP servers', rest.get<{ servers: McpServerRow[] }>('/api/mcp/servers').then(r => r.servers ?? []), [], warnings),
    settle('MCP catalog', rest.get<{ entries: McpCatalogEntry[] }>('/api/mcp/catalog').then(r => r.entries ?? []), [], warnings),
    settle('Toolsets', rest.get<ToolsetRow[]>('/api/tools/toolsets').then(r => (Array.isArray(r) ? r : [])), [], warnings),
    settle('Messaging platforms', rest.get<{ platforms: MessagingPlatformRow[] }>('/api/messaging/platforms').then(r => r.platforms ?? []), [], warnings),
    settle('Providers', rest.get<{ providers: OAuthProviderRow[] }>('/api/providers/oauth').then(r => r.providers ?? []), [], warnings)
  ])

  return { ...normalise({ servers, catalog, toolsets, messaging, providers }), warnings }
}

/* ---- Normalisation ------------------------------------------------------------------------ */

/** Built-in capability toolsets that are Hermes itself, not an external service. */
const CORE_TOOLSETS = new Set([
  'web', 'browser', 'terminal', 'file', 'code_execution', 'vision', 'video', 'image_gen', 'video_gen', 'tts', 'stt',
  'skills', 'todo', 'memory', 'context_engine', 'session_search', 'clarify', 'delegation', 'cronjob', 'computer_use', 'a2a'
])

export function normalise(input: { servers: McpServerRow[]; catalog: McpCatalogEntry[]; toolsets: ToolsetRow[]; messaging: MessagingPlatformRow[]; providers: OAuthProviderRow[] }): Omit<ConnectionsSnapshot, 'warnings'> {
  const connections: Connection[] = []
  const browse: BrowseItem[] = []
  const catalogByName = new Map(input.catalog.map(entry => [entry.name.toLowerCase(), entry]))

  // (a) MCP servers from config.yaml.
  for (const server of input.servers) {
    const catalog = catalogByName.get(server.name.toLowerCase())
    connections.push(mcpConnection(server, catalog))
  }

  const installed = new Set(input.servers.map(s => s.name.toLowerCase()))

  for (const entry of input.catalog) {
    if (!entry.installed && !installed.has(entry.name.toLowerCase())) {
      browse.push({
        id: `mcp:${entry.name}`,
        name: prettyName(entry.name),
        description: entry.description,
        scope: scopeFor(entry.name, entry.description, []),
        logoKey: entry.name,
        category: 'MCP server',
        install: { kind: 'mcp-catalog', entry }
      })
    }
  }

  // (b) Messaging platforms, folding in toolsets that belong to them (discord -> discord, discord_admin).
  const claimedToolsets = new Set<string>()

  for (const platform of input.messaging) {
    const owned = input.toolsets.filter(ts => ts.name === platform.id || ts.name.startsWith(`${platform.id}_`))
    owned.forEach(ts => claimedToolsets.add(ts.name))
    const connection = messagingConnection(platform, owned)

    if (platform.enabled || platform.configured || owned.some(ts => ts.enabled)) {
      connections.push(connection)
    } else {
      browse.push({
        id: `messaging:${platform.id}`,
        name: platform.name,
        description: platform.description,
        scope: connection.scope,
        logoKey: platform.id,
        category: 'Messaging',
        install: { kind: 'messaging', platform }
      })
    }
  }

  // Service toolsets (Home Assistant, Spotify, plugins…) that are not part of a messaging platform.
  for (const toolset of input.toolsets) {
    if (claimedToolsets.has(toolset.name) || CORE_TOOLSETS.has(toolset.name)) {
      continue
    }

    const connection = toolsetConnection(toolset)

    if (toolset.enabled || toolset.configured) {
      connections.push(connection)
    } else {
      browse.push({
        id: `toolset:${toolset.name}`,
        name: toolset.label,
        description: toolset.description,
        scope: connection.scope,
        logoKey: toolset.name,
        category: 'Service',
        install: { kind: 'toolset', toolset }
      })
    }
  }

  // (c) OAuth providers.
  for (const provider of input.providers) {
    if (provider.status?.logged_in) {
      connections.push(providerConnection(provider))
    } else {
      browse.push({
        id: `provider:${provider.id}`,
        name: provider.name,
        description: provider.flow === 'external' ? `Sign in with \`${provider.cli_command ?? 'hermes auth'}\`.` : 'Sign in to use this model provider with Hermes.',
        scope: 'Model provider',
        logoKey: provider.id,
        category: 'Provider',
        install: { kind: 'provider', provider }
      })
    }
  }

  return { connections: connections.sort(byStatusThenName), browse: browse.sort((a, b) => a.name.localeCompare(b.name)) }
}

const STATUS_ORDER: Record<ConnectionStatus, number> = { connected: 0, 'needs-auth': 1, error: 2, disabled: 3, available: 4 }

function byStatusThenName(a: Connection, b: Connection): number {
  return STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name)
}

function mcpConnection(server: McpServerRow, catalog?: McpCatalogEntry): Connection {
  const name = prettyName(server.name)
  const knownTools = server.tools ?? catalog?.default_enabled ?? []
  const status: ConnectionStatus = !server.enabled ? 'disabled' : 'connected'
  const description = catalog?.description || (server.transport === 'http' ? `Remote MCP server at ${hostOf(server.url)}.` : `Local MCP server (${[server.command, ...(server.args ?? [])].filter(Boolean).join(' ').slice(0, 80) || 'stdio'}).`)

  return {
    id: `mcp:${server.name}`,
    kind: 'mcp',
    name,
    description: `Access ${name} through Hermes. ${description}`.trim(),
    status,
    scope: scopeFor(server.name, catalog?.description ?? '', knownTools),
    tools: [
      { id: 'server', label: `Let Hermes use ${name}`, enabled: server.enabled, toggle: { kind: 'mcp-server', name: server.name }, tools: [] },
      ...groupTools(knownTools, server.name).map(group => ({ ...group, enabled: server.enabled }))
    ],
    logoKey: server.name,
    source: { kind: 'mcp', server, catalog }
  }
}

function messagingConnection(platform: MessagingPlatformRow, toolsets: ToolsetRow[]): Connection {
  let status: ConnectionStatus

  if (!platform.enabled) {
    status = toolsets.some(ts => ts.enabled) ? 'connected' : 'disabled'
  } else if (!platform.configured || platform.state === 'not_configured') {
    status = 'needs-auth'
  } else if (platform.state === 'startup_failed' || platform.error_code) {
    status = 'error'
  } else {
    status = 'connected'
  }

  const rows: ConnectionTool[] = [
    { id: 'gateway', label: `Chat with Hermes on ${platform.name}`, enabled: platform.enabled, toggle: { kind: 'messaging-platform', id: platform.id }, tools: [] },
    ...toolsets.map(ts => ({ id: `toolset:${ts.name}`, label: toolsetRowLabel(ts, platform.name), enabled: ts.enabled, toggle: { kind: 'toolset' as const, name: ts.name }, tools: ts.tools }))
  ]

  return {
    id: `platform:${platform.id}`,
    kind: 'platform',
    name: platform.name,
    description: platform.description || `Talk to Hermes from ${platform.name} and let it act on your behalf there.`,
    status,
    scope: scopeFor(platform.id, platform.description, toolsets.flatMap(ts => ts.tools)),
    tools: rows,
    logoKey: platform.id,
    source: { kind: 'messaging', platform, toolsets }
  }
}

function toolsetConnection(toolset: ToolsetRow): Connection {
  const status: ConnectionStatus = !toolset.enabled ? 'disabled' : !toolset.configured ? 'needs-auth' : 'connected'

  return {
    id: `toolset:${toolset.name}`,
    kind: 'platform',
    name: toolset.label,
    description: toolset.description ? `${capitalise(toolset.description)}.`.replace(/\.\.$/, '.') : `Hermes tools for ${toolset.label}.`,
    status,
    scope: scopeFor(toolset.name, toolset.description, toolset.tools),
    tools: [
      { id: 'toolset', label: `Let Hermes use ${toolset.label}`, enabled: toolset.enabled, toggle: { kind: 'toolset', name: toolset.name }, tools: [] },
      ...groupTools(toolset.tools, toolset.name).map(group => ({ ...group, enabled: toolset.enabled }))
    ],
    logoKey: toolset.name,
    source: { kind: 'toolset', toolset }
  }
}

function providerConnection(provider: OAuthProviderRow): Connection {
  return {
    id: `provider:${provider.id}`,
    kind: 'provider',
    name: provider.name,
    description: `Signed in${provider.status.source_label ? ` via ${provider.status.source_label}` : ''}. Hermes can use ${provider.name} models on your account.`,
    status: 'connected',
    scope: 'Model provider',
    tools: [],
    logoKey: provider.id,
    source: { kind: 'provider', provider }
  }
}

/* ---- Labels ------------------------------------------------------------------------------- */

export function prettyName(raw: string): string {
  const cleaned = raw.replace(/[-_.]+/g, ' ').replace(/\bmcp\b/gi, '').trim()

  if (!cleaned) {
    return raw
  }

  return cleaned
    .split(/\s+/)
    .map(word => (/^[a-z0-9]+$/.test(word) ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ')
}

function capitalise(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

function hostOf(url: string | null | undefined): string {
  if (!url) {
    return 'a remote host'
  }

  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function toolsetRowLabel(toolset: ToolsetRow, platformName: string): string {
  if (/admin/i.test(toolset.name)) {
    return `Manage ${platformName} servers`
  }

  return `Read and participate in ${platformName}`
}

const KNOWN_SCOPE: [RegExp, string][] = [
  [/drive|dropbox|box\b|onedrive/i, 'Files and documents'],
  [/calendar|cal\b/i, 'Events and availability'],
  [/github|gitlab|bitbucket/i, 'Repositories and issues'],
  [/slack/i, 'Channels and conversations'],
  [/discord/i, 'Servers and messages'],
  [/telegram|whatsapp|signal|matrix|imessage|sms/i, 'Chats and messages'],
  [/gmail|mail|outlook/i, 'Mail and drafts'],
  [/notion|confluence|obsidian/i, 'Pages and databases'],
  [/linear|jira|asana|todoist|trello/i, 'Issues and projects'],
  [/spotify|music/i, 'Playback and playlists'],
  [/home ?assistant|hass|homekit/i, 'Devices and automations'],
  [/browser|playwright|puppeteer/i, 'Web pages'],
  [/postgres|sqlite|mysql|database|supabase/i, 'Databases and queries'],
  [/x_search|twitter|\bx\b/i, 'Posts and search']
]

export function scopeFor(key: string, description: string, tools: string[]): string {
  const haystack = `${key} ${description}`

  for (const [pattern, label] of KNOWN_SCOPE) {
    if (pattern.test(haystack)) {
      return label
    }
  }

  if (description) {
    const first = description.split(/[.;(]/)[0].trim()

    if (first && first.length <= 42) {
      return capitalise(first)
    }
  }

  return tools.length ? `${tools.length} tool${tools.length === 1 ? '' : 's'}` : 'Tools and actions'
}

type Verb = 'read' | 'create' | 'delete' | 'run'

const VERBS: [Verb, RegExp][] = [
  ['delete', /(delete|remove|trash|archive|destroy|clear|purge|unpin|revoke)/i],
  ['create', /(create|draft|write|add|send|post|insert|new|compose|upload|update|edit|patch|modify|rename|move|set_|toggle|assign|pin|reply|publish|save|schedule)/i],
  ['read', /^(list|search|find|read|get|fetch|query|view|show|describe|browse|lookup|check|download|export|status)|(_list|_search|_get|_read|_info)$/i],
  ['run', /(run|execute|exec|call|trigger|play|pause|skip|resume|control|start|stop|turn|invoke|open|navigate|click|type|scroll)/i]
]

const NOUNS: [RegExp, string][] = [
  [/file|document|folder|doc\b|drive|dropbox/i, 'files'],
  [/event|calendar|availability|schedule/i, 'events'],
  [/gmail|mail|email|inbox/i, 'mail'],
  [/message|channel|thread|chat|conversation|dm\b|slack|discord|telegram|whatsapp/i, 'messages'],
  [/issue|pull|pr\b|repo|commit|branch|ticket|github|gitlab|linear|jira/i, 'issues'],
  [/page|database|block|note|notion|confluence/i, 'pages'],
  [/track|playlist|album|artist|playback|spotify/i, 'music'],
  [/device|entity|light|switch|scene|automation|homeassistant|hass/i, 'devices'],
  [/member|user|role|guild|server/i, 'members'],
  [/post|tweet|x_search/i, 'posts']
]

/** Group raw tool names into human permission rows ("Find and read files", "Create drafts", …). */
export function groupTools(names: string[], contextKey = ''): Omit<ConnectionTool, 'enabled'>[] {
  if (names.length === 0) {
    return []
  }

  const buckets = new Map<Verb | 'other', string[]>()

  for (const name of names) {
    const short = name.includes(':') ? name.split(':').pop() ?? name : name
    const verb = VERBS.find(([, pattern]) => pattern.test(short))?.[0] ?? 'other'
    buckets.set(verb, [...(buckets.get(verb) ?? []), name])
  }

  const nounHaystack = `${contextKey} ${names.join(' ')}`
  const noun = NOUNS.find(([pattern]) => pattern.test(nounHaystack))?.[1] ?? 'content'
  const label = (verb: Verb | 'other'): string => {
    switch (verb) {
      case 'read':
        return `Find and read ${noun}`
      case 'create':
        return noun === 'mail' ? 'Create drafts' : noun === 'messages' ? 'Send messages' : `Create and edit ${noun}`
      case 'delete':
        return `Delete ${noun}`
      case 'run':
        return noun === 'music' ? 'Control playback' : noun === 'devices' ? 'Control devices' : 'Run actions'
      default:
        return 'Other actions'
    }
  }
  const order: (Verb | 'other')[] = ['read', 'create', 'delete', 'run', 'other']

  return order
    .filter(verb => buckets.has(verb))
    .map(verb => ({ id: `group:${verb}`, label: label(verb), tools: buckets.get(verb) ?? [] }))
}

/* ---- Allowed folders (local only; Hermes has no per-connection folder scope yet) ----------- */

const FOLDER_KEY = (id: string) => `herald-os.connections.folders.${id}`

export function readFolders(id: string): string[] {
  try {
    const raw = localStorage.getItem(FOLDER_KEY(id))
    const parsed: unknown = raw ? JSON.parse(raw) : []

    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}

export function writeFolders(id: string, folders: string[]): void {
  try {
    localStorage.setItem(FOLDER_KEY(id), JSON.stringify(folders))
  } catch {
    // Quota or private mode: chips just will not persist.
  }
}

export function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

/* ---- Activity ----------------------------------------------------------------------------- */

/** Activity entries whose title/detail mention the connection or one of its tools. */
export function activityFor(connection: Connection, activity: ActivityEntry[], limit = 3): ActivityEntry[] {
  const needles = new Set<string>()
  const push = (value: string | undefined) => {
    const text = value?.trim().toLowerCase()

    if (text && text.length >= 3) {
      needles.add(text)
    }
  }
  push(connection.name)
  push(connection.id.split(':').pop())
  push(connection.logoKey)

  for (const row of connection.tools) {
    row.tools.forEach(push)
  }

  const terms = [...needles]

  return activity
    .filter(entry => {
      const text = `${entry.title} ${entry.detail ?? ''}`.toLowerCase()

      return terms.some(term => text.includes(term))
    })
    .slice(0, limit)
}

/* ---- Mutations ---------------------------------------------------------------------------- */

export const api = {
  setMcpEnabled: (name: string, enabled: boolean) => rest.put<{ ok: boolean }>(`/api/mcp/servers/${encodeURIComponent(name)}/enabled`, { enabled }),
  removeMcp: (name: string) => rest.del<{ ok: boolean }>(`/api/mcp/servers/${encodeURIComponent(name)}`),
  probeMcp: (name: string) => rest.post<McpProbeResult>(`/api/mcp/servers/${encodeURIComponent(name)}/test`),
  authMcp: (name: string) => rest.post<McpOAuthSnapshot>(`/api/mcp/servers/${encodeURIComponent(name)}/auth`),
  installCatalog: (name: string, env: Record<string, string> = {}) => rest.post<{ ok: boolean; name: string; background: boolean; action?: string }>('/api/mcp/catalog/install', { name, env, enable: true }),
  setToolsetEnabled: (name: string, enabled: boolean) => rest.put<{ ok: boolean }>(`/api/tools/toolsets/${encodeURIComponent(name)}`, { enabled }),
  setPlatformEnabled: (id: string, enabled: boolean) => rest.put<{ ok: boolean }>(`/api/messaging/platforms/${encodeURIComponent(id)}`, { enabled }),
  startProviderOAuth: (id: string) => rest.post<OAuthStartResult>(`/api/providers/oauth/${encodeURIComponent(id)}/start`),
  disconnectProvider: (id: string) => rest.del<{ ok: boolean }>(`/api/providers/oauth/${encodeURIComponent(id)}`)
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
