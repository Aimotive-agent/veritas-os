import fs from 'node:fs'
import path from 'node:path'
import type { CatalogEntryView, CatalogGroupView } from '../../shared/ipc.ts'

/*
 * The install catalog's JSON (linux/catalog/*.json). On Veritas OS Linux the `herald-os catalog`
 * CLI owns installing; on macOS the main process installs the entries that have a macOS method
 * (npm, Homebrew, a download page). These helpers are pure so both paths share them.
 */

export interface CatalogMethod {
  kind: string
  ref: string
  arch?: string[]
  icon?: string
}

export interface CatalogEntry {
  id: string
  label: string
  description?: string
  bin?: string[]
  detect?: string[]
  terminal?: boolean
  terminalApp?: string
  hermes?: 'ollama' | 'lmstudio'
  arch?: string[]
  needs?: string[]
  install: CatalogMethod[]
}

export interface CatalogGroup {
  id: string
  label: string
  description?: string
  order?: number
  entries: CatalogEntry[]
}

export const MAC_KINDS: ReadonlySet<string> = new Set(['npm', 'brew', 'brew-cask', 'link'])

/** A bin name safe to run inside `sh -c` (catalog data, but checked anyway). */
const BIN_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** The first catalog folder that has group files. */
export function readCatalog(dirs: string[]): CatalogGroup[] {
  for (const dir of dirs) {
    let files: string[]

    try {
      files = fs.readdirSync(dir).filter(name => name.endsWith('.json'))
    } catch {
      continue
    }

    if (files.length === 0) {
      continue
    }

    const groups: CatalogGroup[] = []

    for (const name of files.sort()) {
      try {
        const group = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as CatalogGroup
        groups.push({ ...group, entries: Array.isArray(group.entries) ? group.entries : [] })
      } catch {
        // A broken group file must not hide the others.
      }
    }

    return groups.sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.id.localeCompare(b.id))
  }

  return []
}

export function findEntry(groups: CatalogGroup[], id: string): { group: CatalogGroup; entry: CatalogEntry } | null {
  for (const group of groups) {
    const entry = group.entries.find(item => item.id === id)

    if (entry) {
      return { group, entry }
    }
  }

  return null
}

/** The bin a terminal tab may run for a coding agent, or null when the id is not one. */
export function terminalBin(groups: CatalogGroup[], id: string): string | null {
  const found = findEntry(groups, id)
  const bin = found?.entry.terminal ? found.entry.bin?.[0] : undefined

  return bin && BIN_NAME.test(bin) ? bin : null
}

export interface MacTools {
  npm: boolean
  brew: boolean
}

/** The macOS install method for an entry, or why there is none. */
export function pickMacMethod(entry: CatalogEntry, tools: MacTools): { method: CatalogMethod | null; reason?: string } {
  let reason: string | undefined

  for (const method of entry.install.filter(item => MAC_KINDS.has(item.kind))) {
    if (method.kind === 'npm' && !tools.npm) {
      reason ??= 'needs Node.js (from nodejs.org or Homebrew)'

      continue
    }

    if ((method.kind === 'brew' || method.kind === 'brew-cask') && !tools.brew) {
      reason ??= 'needs Homebrew'

      continue
    }

    return { method }
  }

  return { method: null, reason }
}

/** Only the entries macOS can install at all (dropping groups left empty). */
export function macGroups(groups: CatalogGroup[]): CatalogGroup[] {
  return groups.map(group => ({ ...group, entries: group.entries.filter(entry => entry.install.some(method => MAC_KINDS.has(method.kind))) })).filter(group => group.entries.length > 0)
}

export function entryView(group: CatalogGroup, entry: CatalogEntry, state: { installed: boolean; removable?: boolean; method: CatalogMethod | null; reason?: string }): CatalogEntryView {
  return {
    id: entry.id,
    label: entry.label,
    description: entry.description ?? '',
    group: group.id,
    installed: state.installed,
    removable: state.installed && Boolean(state.removable),
    available: state.method !== null,
    method: state.method?.kind ?? null,
    ...(state.method ? {} : { reason: state.reason ?? 'not on this computer' }),
    ...(entry.terminal ? { terminal: true } : {}),
    ...(entry.terminalApp ? { terminalApp: entry.terminalApp } : {}),
    ...(entry.hermes ? { hermes: entry.hermes } : {}),
    ...(entry.bin?.[0] ? { bin: entry.bin[0] } : {}),
    ...(state.method?.kind === 'link' ? { url: state.method.ref } : {})
  }
}

/** `herald-os catalog list --json` → the groups the shell shows (tolerant of extra fields). */
export function parseCliListing(stdout: string): CatalogGroupView[] {
  const data = JSON.parse(stdout) as { groups?: CatalogGroupView[] }

  return (data.groups ?? []).map(group => ({ id: group.id, label: group.label, description: group.description ?? '', entries: group.entries ?? [] }))
}
