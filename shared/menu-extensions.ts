/*
 * ~/.config/herald-os/menu.json: the person's own control-menu entries. Each runs a `herald-os`
 * command, a program, a Veritas OS command or opens a web address. Parsed by main (which runs the
 * programs) and shown by the control menu; pure and tested.
 */

export type MenuExtensionAction =
  | { kind: 'herald-os'; argv: string[] }
  | { kind: 'exec'; argv: string[] }
  | { kind: 'url'; url: string }
  | { kind: 'command'; command: string; args: Record<string, unknown> }

export interface MenuExtension {
  /** Stable while the file keeps the entry in the same place with the same label. */
  id: string
  label: string
  hint?: string
  icon?: MenuExtensionIcon
  /** A built-in group (install, trigger, system, …); otherwise the entry sits under "Yours". */
  group?: string
  action: MenuExtensionAction
}

export interface MenuExtensions {
  entries: MenuExtension[]
  /** Problems with the file, one line each; good entries still load. */
  errors: string[]
}

export const MENU_EXTENSION_ICONS = ['star', 'app', 'terminal', 'world', 'bolt', 'folder', 'notes', 'music', 'camera', 'code', 'calendar', 'mail', 'chat', 'heart', 'home', 'rocket'] as const

export type MenuExtensionIcon = (typeof MENU_EXTENSION_ICONS)[number]

export const MENU_GROUPS = ['install', 'remove', 'update', 'style', 'trigger', 'capture', 'toggle', 'system', 'hermes'] as const

const MAX_ENTRIES = 50
const MAX_ARGS = 64
const COMMAND = /^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/
const ACTION_KEYS = ['herald-os', 'exec', 'url', 'command'] as const

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32) || 'entry'

function argvOf(value: unknown): string[] | null {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_ARGS && value.every(arg => typeof arg === 'string' && arg.length > 0 && arg.length <= 4096) ? (value as string[]) : null
}

/** The file's JSON as entries, keeping every good one and saying what is wrong with the rest. */
export function parseMenuExtensions(value: unknown): MenuExtensions {
  if (value === undefined || value === null) {
    return { entries: [], errors: [] }
  }

  const list = Array.isArray(value) ? value : value && typeof value === 'object' ? (value as { entries?: unknown }).entries : undefined

  if (!Array.isArray(list)) {
    return { entries: [], errors: ['menu.json needs an "entries" list'] }
  }

  const entries: MenuExtension[] = []
  const errors: string[] = []

  list.slice(0, MAX_ENTRIES).forEach((raw, index) => {
    const where = `entry ${index + 1}`

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`${where} is not an object`)

      return
    }

    const entry = raw as Record<string, unknown>
    const label = typeof entry.label === 'string' ? entry.label.trim() : ''

    if (!label || label.length > 60) {
      errors.push(`${where} needs a "label" of 1 to 60 characters`)

      return
    }

    const keys = ACTION_KEYS.filter(key => entry[key] !== undefined)

    if (keys.length !== 1) {
      errors.push(`"${label}" needs exactly one of "herald-os", "exec", "url" or "command"`)

      return
    }

    let action: MenuExtensionAction | null = null
    const key = keys[0]

    if (key === 'herald-os' || key === 'exec') {
      const argv = argvOf(entry[key])
      action = argv ? { kind: key, argv } : null

      if (!action) {
        errors.push(`"${label}": "${key}" is a list of words, like ["launch", "obsidian"]`)
      }
    } else if (key === 'url') {
      const url = typeof entry.url === 'string' ? entry.url.trim() : ''
      action = /^https?:\/\/\S+$/i.test(url) ? { kind: 'url', url } : null

      if (!action) {
        errors.push(`"${label}": "url" starts with http:// or https://`)
      }
    } else {
      const command = typeof entry.command === 'string' ? entry.command : ''
      const args = entry.args && typeof entry.args === 'object' && !Array.isArray(entry.args) ? (entry.args as Record<string, unknown>) : {}
      action = COMMAND.test(command) ? { kind: 'command', command, args } : null

      if (!action) {
        errors.push(`"${label}": "command" is a Veritas OS command id, like "page.open"`)
      }
    }

    if (!action) {
      return
    }

    const icon = typeof entry.icon === 'string' && (MENU_EXTENSION_ICONS as readonly string[]).includes(entry.icon) ? (entry.icon as MenuExtensionIcon) : undefined
    const group = typeof entry.group === 'string' && (MENU_GROUPS as readonly string[]).includes(entry.group.toLowerCase()) ? entry.group.toLowerCase() : undefined

    if (typeof entry.icon === 'string' && !icon) {
      errors.push(`"${label}": unknown icon "${entry.icon}" (${MENU_EXTENSION_ICONS.join(', ')})`)
    }

    entries.push({
      id: `yours-${index + 1}-${slug(label)}`,
      label,
      ...(typeof entry.hint === 'string' && entry.hint.trim() ? { hint: entry.hint.trim().slice(0, 80) } : {}),
      ...(icon ? { icon } : {}),
      ...(group ? { group } : {}),
      action
    })
  })

  if (list.length > MAX_ENTRIES) {
    errors.push(`only the first ${MAX_ENTRIES} entries are used`)
  }

  return { entries, errors }
}
