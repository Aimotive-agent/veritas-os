import { atom, computed } from 'nanostores'
import type { ChatMessage, ToolMessage } from '../../lib/chat-model.ts'
import { $activeChatId } from '../../store/chat.ts'
import { $artifacts, type Artifact } from '../../store/missions.ts'

/*
 * Page-local state for the Hermes page: which artifact the pane shows, which tab is open and
 * whether the document is being edited. Artifacts themselves live in store/missions.ts.
 */

export type PaneTab = 'preview' | 'sources'
export type ArtifactKind = 'markdown' | 'text' | 'image' | 'other'

/** Path the user explicitly picked; null means "newest artifact of the active chat". */
export const $selectedArtifactPath = atom<string | null>(null)
export const $paneTab = atom<PaneTab>('preview')
export const $editing = atom(false)
export const $zoom = atom(100)

/** Artifacts of the active chat, newest first. */
export const $chatArtifacts = computed([$artifacts, $activeChatId], (artifacts, id) => (id ? (artifacts[id] ?? []) : []))

export const $selectedArtifact = computed([$chatArtifacts, $selectedArtifactPath], (list, path) => {
  const files = list.filter(a => a.kind === 'file')

  return (path ? files.find(a => a.path === path) : undefined) ?? files[0] ?? null
})

export function selectArtifact(path: string | null): void {
  $selectedArtifactPath.set(path)
  $paneTab.set('preview')
  $editing.set(false)
}

const MARKDOWN = new Set(['md', 'markdown', 'mdx'])
const TEXT = new Set(['txt', 'json', 'yaml', 'yml', 'csv', 'tsv', 'html', 'htm', 'xml', 'toml', 'ini', 'log', 'js', 'ts', 'tsx', 'jsx', 'py', 'sh', 'css', 'sql', 'rs', 'go', 'swift', 'env'])
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'svg', 'bmp', 'tiff'])

export function extensionOf(name: string): string {
  const match = /\.([a-z0-9]{1,6})$/i.exec(name)

  return match ? match[1].toLowerCase() : ''
}

export function artifactKind(name: string): ArtifactKind {
  const ext = extensionOf(name)

  if (MARKDOWN.has(ext)) {
    return 'markdown'
  }

  if (TEXT.has(ext)) {
    return 'text'
  }

  if (IMAGE.has(ext)) {
    return 'image'
  }

  return 'other'
}

export const isEditable = (name: string): boolean => {
  const kind = artifactKind(name)

  return kind === 'markdown' || kind === 'text'
}

/** Artifacts whose timestamp falls inside a turn, i.e. between the user prompt and the turn end. */
export function artifactsInWindow(list: Artifact[], from: number, to: number): Artifact[] {
  const seen = new Set<string>()

  return list
    .filter(a => a.kind === 'file' && a.ts >= from && a.ts <= to)
    .filter(a => (seen.has(a.path) ? false : (seen.add(a.path), true)))
    .sort((a, b) => a.ts - b.ts)
}

export interface SourceRow {
  id: string
  kind: 'file' | 'url'
  label: string
  target: string
  action: 'read' | 'wrote' | 'searched' | 'visited'
  ts: number
}

const FILE_KEYS = ['path', 'file_path', 'filepath', 'target', 'to', 'output_path', 'destination']
const URL_KEYS = ['url', 'urls', 'link']
const READ_TOOLS = new Set(['read_file', 'search_files', 'system_find_files'])
const WRITE_TOOLS = new Set(['write_file', 'patch', 'system_files', 'create_file', 'edit_file'])
const WEB_TOOLS = new Set(['web_extract', 'browser_navigate', 'web_search', 'browser_open'])

function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value]
  }

  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string')
  }

  return []
}

function sourcesOfTool(tool: ToolMessage): SourceRow[] {
  const args = tool.args ?? {}
  const rows: SourceRow[] = []

  if (READ_TOOLS.has(tool.name) || WRITE_TOOLS.has(tool.name)) {
    const action = WRITE_TOOLS.has(tool.name) ? 'wrote' : tool.name === 'search_files' || tool.name === 'system_find_files' ? 'searched' : 'read'

    for (const key of FILE_KEYS) {
      for (const p of stringsOf(args[key])) {
        if (p.startsWith('/') || p.startsWith('~')) {
          rows.push({ id: `${tool.id}:${p}`, kind: 'file', label: p.split('/').filter(Boolean).pop() ?? p, target: p, action, ts: tool.ts })
        }
      }
    }

    const ops = args.operations

    if (Array.isArray(ops)) {
      for (const op of ops) {
        if (op && typeof op === 'object') {
          for (const key of FILE_KEYS) {
            for (const p of stringsOf((op as Record<string, unknown>)[key])) {
              if (p.startsWith('/') || p.startsWith('~')) {
                rows.push({ id: `${tool.id}:${p}`, kind: 'file', label: p.split('/').filter(Boolean).pop() ?? p, target: p, action: 'wrote', ts: tool.ts })
              }
            }
          }
        }
      }
    }
  }

  if (WEB_TOOLS.has(tool.name)) {
    for (const key of URL_KEYS) {
      for (const url of stringsOf(args[key])) {
        if (/^https?:\/\//i.test(url)) {
          rows.push({ id: `${tool.id}:${url}`, kind: 'url', label: url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, ''), target: url, action: 'visited', ts: tool.ts })
        }
      }
    }
  }

  return rows
}

/** Files and pages Hermes touched in this session, newest first, one row per target. */
export function collectSources(messages: ChatMessage[]): SourceRow[] {
  const byTarget = new Map<string, SourceRow>()

  for (const message of messages) {
    if (message.role !== 'tool') {
      continue
    }

    for (const row of sourcesOfTool(message)) {
      const existing = byTarget.get(row.target)

      if (!existing || existing.ts < row.ts) {
        byTarget.set(row.target, existing && existing.action === 'wrote' ? { ...row, action: 'wrote' } : row)
      }
    }
  }

  return [...byTarget.values()].sort((a, b) => b.ts - a.ts)
}

export const formatTime = (ts: number): string => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

export function dayLabel(ts: number): string {
  const date = new Date(ts)
  const today = new Date()
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diff = Math.round((startOf(today) - startOf(date)) / 86_400_000)

  if (diff === 0) {
    return 'Today'
  }

  if (diff === 1) {
    return 'Yesterday'
  }

  return date.toLocaleDateString(undefined, diff < 7 ? { weekday: 'long' } : { month: 'long', day: 'numeric', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}
