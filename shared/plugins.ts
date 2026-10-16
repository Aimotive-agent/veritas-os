/*
 * Widget plugins (ADR-019): a folder with a manifest.json and web files, shown in a sandboxed frame
 * that can only talk to the shell through a message channel. Shared by main (which serves and
 * answers them) and the renderer (which places them); pure and tested.
 */

export type PluginPlacement = 'menubar' | 'overview' | 'panel'

export const PLUGIN_PLACEMENTS: readonly PluginPlacement[] = ['menubar', 'overview', 'panel']

/** What a widget may ask the shell for; `run:<command.id>` names each OS command it may run. */
export type PluginPermission = 'stats' | 'notify' | 'storage' | `run:${string}`

export interface PluginManifest {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  /** The page to show, relative to the plugin folder. */
  entry: string
  placement: PluginPlacement[]
  /** Overview cards and panels: the size it wants (menu-bar widgets are 24 px tall). */
  size?: { width?: number; height?: number }
  permissions: PluginPermission[]
  /** Hosts it may fetch from; the person accepts them when enabling it. */
  hosts: string[]
}

export interface PluginView {
  manifest: PluginManifest
  enabled: boolean
  /** Problems that keep it from running (a broken manifest, a missing entry page). */
  errors: string[]
  dir: string
  /** Installed from git, so it can be updated. */
  git: boolean
  /** Bumped when its files change, so frames reload. */
  revision: number
}

/** What turning a plugin on granted; a manifest that later asks for more turns it off until approved again. */
export interface PluginGrant {
  permissions: string[]
  hosts: string[]
}

/** Every permission and host the manifest asks for is in the grant (pure; tested). */
export function grantCovers(grant: PluginGrant | undefined, manifest: PluginManifest): boolean {
  return Boolean(grant) && manifest.permissions.every(permission => grant?.permissions.includes(permission)) && manifest.hosts.every(host => grant?.hosts.includes(host))
}

/** What a widget sends: `{ herald: 1, id, method, params }`; the reply carries the same id. */
export type PluginMethod = 'stats' | 'notify' | 'storage.get' | 'storage.set' | 'run' | 'theme'

const ID = /^[a-z0-9][a-z0-9-]{1,47}$/
const HOST = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/
const COMMAND = /^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/

/** A manifest as the shell uses it, or the reasons it cannot be used (pure; tested). */
export function validateManifest(value: unknown, folder: string): { manifest: PluginManifest | null; errors: string[] } {
  const errors: string[] = []

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { manifest: null, errors: ['manifest.json is not a JSON object'] }
  }

  const raw = value as Record<string, unknown>
  const id = typeof raw.id === 'string' ? raw.id : ''

  if (!ID.test(id)) {
    errors.push('id must be 2 to 48 lowercase letters, digits and dashes')
  } else if (id === 'sdk') {
    errors.push('the id "sdk" is reserved')
  } else if (id !== folder) {
    errors.push(`id "${id}" must match its folder "${folder}"`)
  }

  const name = typeof raw.name === 'string' ? raw.name.trim() : ''

  if (!name) {
    errors.push('name is required')
  }

  const entry = typeof raw.entry === 'string' ? raw.entry : 'index.html'

  if (entry.startsWith('/') || entry.split(/[\\/]/).includes('..') || !/\.html?$/.test(entry)) {
    errors.push('entry must be an .html file inside the plugin folder')
  }

  const placement = Array.isArray(raw.placement) ? raw.placement.filter((item): item is PluginPlacement => PLUGIN_PLACEMENTS.includes(item as PluginPlacement)) : []

  if (placement.length === 0) {
    errors.push('placement must name at least one of menubar, overview, panel')
  }

  const permissions: PluginPermission[] = []

  for (const item of Array.isArray(raw.permissions) ? raw.permissions : []) {
    if (item === 'stats' || item === 'notify' || item === 'storage') {
      permissions.push(item)
    } else if (typeof item === 'string' && item.startsWith('run:') && COMMAND.test(item.slice(4))) {
      permissions.push(item as PluginPermission)
    } else {
      errors.push(`unknown permission ${JSON.stringify(item)}`)
    }
  }

  const hosts: string[] = []

  for (const item of Array.isArray(raw.hosts) ? raw.hosts : []) {
    if (typeof item === 'string' && HOST.test(item.toLowerCase())) {
      hosts.push(item.toLowerCase())
    } else {
      errors.push(`hosts entries are host names like api.example.com, not ${JSON.stringify(item)}`)
    }
  }

  const size = raw.size && typeof raw.size === 'object' ? (raw.size as Record<string, unknown>) : {}
  const clamp = (n: unknown, min: number, max: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(Math.min(max, Math.max(min, n))) : undefined)

  const manifest: PluginManifest = {
    id,
    name: name || id,
    version: typeof raw.version === 'string' ? raw.version : '0.0.0',
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    ...(typeof raw.author === 'string' ? { author: raw.author } : {}),
    entry,
    placement,
    size: { width: clamp(size.width, 48, 720), height: clamp(size.height, 24, 640) },
    permissions: [...new Set(permissions)],
    hosts: [...new Set(hosts)]
  }

  return { manifest: errors.length ? null : manifest, errors }
}

/** The CSP a widget page runs under: its own files, and fetches only to the hosts it was granted. */
export function pluginCsp(id: string, hosts: readonly string[]): string {
  const self = `herald-plugin://${id}`
  const connect = hosts.length ? hosts.map(host => `https://${host}`).join(' ') : "'none'"

  return [
    `default-src 'none'`,
    `script-src ${self} herald-plugin://sdk`,
    `style-src ${self} 'unsafe-inline'`,
    `img-src ${self} data: ${hosts.map(host => `https://${host}`).join(' ')}`.trim(),
    `font-src ${self}`,
    `connect-src ${connect}`,
    `form-action 'none'`,
    `base-uri 'none'`
  ].join('; ')
}

/** Whether a widget may call a method (pure; tested). `run` also needs the command named. */
export function allowed(manifest: PluginManifest, method: PluginMethod, command?: string): boolean {
  switch (method) {
    case 'stats':
      return manifest.permissions.includes('stats')
    case 'notify':
      return manifest.permissions.includes('notify')
    case 'storage.get':
    case 'storage.set':
      return manifest.permissions.includes('storage')
    case 'run':
      return Boolean(command) && manifest.permissions.includes(`run:${command}`)
    case 'theme':
      return true
  }
}

/** What enabling grants, in words, for the confirmation. */
export function describePermissions(manifest: PluginManifest): string[] {
  const lines: string[] = []

  if (manifest.permissions.includes('stats')) {
    lines.push('See system stats (CPU, memory, disk, battery)')
  }

  if (manifest.permissions.includes('notify')) {
    lines.push('Show notifications')
  }

  if (manifest.permissions.includes('storage')) {
    lines.push('Keep its own settings')
  }

  for (const permission of manifest.permissions) {
    if (permission.startsWith('run:')) {
      lines.push(`Run the Veritas OS command ${permission.slice(4)} (changes still ask you first)`)
    }
  }

  for (const host of manifest.hosts) {
    lines.push(`Connect to ${host}`)
  }

  return lines.length ? lines : ['Nothing beyond showing itself']
}
