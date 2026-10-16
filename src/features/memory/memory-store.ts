import type { SessionListRow } from '@herald-os/client'
import { atom } from 'nanostores'
import type { DirEntry } from '../../../shared/ipc.ts'

/*
 * Hermes memory lives in two plain-text files under `$HERMES_HOME/memories/`: MEMORY.md (what the
 * agent remembers) and USER.md (facts about the user). Entries are separated by a line that is only
 * `§`. This module parses, classifies and caches them, and writes edits back optimistically before
 * re-reading the truth from disk.
 */

export type MemoryKind = 'preference' | 'project' | 'person' | 'knowledge'
export type MemoryFile = 'MEMORY.md' | 'USER.md'

export const MEMORY_FILES: readonly MemoryFile[] = ['MEMORY.md', 'USER.md']
/** Same delimiter Hermes's memory tool writes (`ENTRY_DELIMITER` in tools/memory_tool.py). */
export const ENTRY_DELIMITER = '\n§\n'

export const KIND_LABEL: Record<MemoryKind, string> = {
  preference: 'Preference',
  project: 'Project',
  person: 'Person',
  knowledge: 'Knowledge'
}

export const FILE_LABEL: Record<MemoryFile, string> = {
  'MEMORY.md': 'Hermes memory',
  'USER.md': 'About you'
}

export interface MemoryEntry {
  /** `${file}:${index}`; stable across reloads while the file keeps its order. */
  id: string
  file: MemoryFile
  index: number
  text: string
  title: string
  summary: string
  kind: MemoryKind
  /** First ISO date in the entry, else the file's modification time (epoch ms). */
  date: number
  fileModifiedAt: number
}

export interface MemoryFileState {
  file: MemoryFile
  path: string
  exists: boolean
  modifiedAt: number
  /** The bridge could not hand us the whole file; writing it back would lose data. */
  truncated: boolean
  texts: string[]
}

export interface MemoryState {
  files: Record<MemoryFile, MemoryFileState> | null
  entries: MemoryEntry[]
  loading: boolean
  loaded: boolean
  error: string | null
}

export const $memory = atom<MemoryState>({ files: null, entries: [], loading: false, loaded: false, error: null })

/** A request from a command (voice, agent) for the Memory page to filter and/or select an entry. */
export interface MemoryFocus {
  query?: string
  entryId?: string
  ts: number
}

export const $memoryFocus = atom<MemoryFocus | null>(null)

export function focusMemory(focus: Omit<MemoryFocus, 'ts'>): void {
  $memoryFocus.set({ ...focus, ts: Date.now() })
}

// ---------------------------------------------------------------------------------------------
// Text helpers (pure).
// ---------------------------------------------------------------------------------------------

/** Split a memory file into trimmed, non-empty entries. A delimiter is a line containing only `§`. */
export function parse(text: string): string[] {
  if (!text.trim()) {
    return []
  }

  const entries: string[] = []
  let buffer: string[] = []

  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '§') {
      entries.push(buffer.join('\n'))
      buffer = []
    } else {
      buffer.push(line)
    }
  }

  entries.push(buffer.join('\n'))

  return entries.map(entry => entry.trim()).filter(Boolean)
}

/** Inverse of `parse`, byte-compatible with what Hermes writes (no trailing newline). */
export function serialize(entries: readonly string[]): string {
  return entries.map(entry => entry.trim()).filter(Boolean).join(ENTRY_DELIMITER)
}

const PREFERENCE = /\b(prefers?|preferred|likes?|wants?|style|timezone|time zone|hours|favou?rites?|dislikes?|communication|tone|format|exports?|voice|language)\b/i
const PROJECT = /\b(projects?|repos?|repositor(y|ies)|building|builds?|apps?|skills?|boards?|codebase|features?|deploy(ed|ment)?|api|library|packages?|kanban|pipeline|roadmap)\b/i
const PERSON = /\b(is an?|team|colleagues?|co-?workers?|manager|friends?|partner|wife|husband|works? (at|with|for)|contact|reports? to)\b|(^|\s)@\w+/i

/** Cheap keyword heuristics; USER.md entries fall back to `preference` (or `person` when they read like one). */
export function classifyKind(text: string, file: MemoryFile = 'MEMORY.md'): MemoryKind {
  if (PREFERENCE.test(text)) {
    return 'preference'
  }

  if (PROJECT.test(text)) {
    return 'project'
  }

  if (PERSON.test(text)) {
    return 'person'
  }

  return file === 'USER.md' ? 'preference' : 'knowledge'
}

const ISO_DATE = /\b(\d{4}-\d{2}-\d{2})\b/
const BOLD_LEAD = /^\*\*(.+?)\*\*\s*[:\-–—]?\s*/
const FIRST_SENTENCE = /^(.+?[.!?:;])(?:\s+|$)([\s\S]*)$/
const TITLE_MAX = 60
const SUMMARY_MAX = 160

export function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

const stripMarkers = (text: string) => text.replace(/\*\*/g, '').replace(/^#+\s*/, '')

/** Title = first sentence (or the leading **bold** label) up to 60 chars; summary = the rest. */
export function splitTitle(text: string): { title: string; summary: string } {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  const flat = stripMarkers(collapsed).trim()
  const bold = BOLD_LEAD.exec(collapsed)
  let head: string
  let rest: string

  if (bold) {
    head = bold[1]
    rest = stripMarkers(collapsed.slice(bold[0].length))
  } else {
    const sentence = FIRST_SENTENCE.exec(flat)
    head = sentence ? sentence[1] : flat
    rest = sentence ? sentence[2] : ''
  }

  const title = truncateText(
    stripMarkers(head)
      .replace(/\s*\(\d{4}-\d{2}-\d{2}\)\s*/g, ' ')
      .replace(/[.:;,\s]+$/, '')
      .trim(),
    TITLE_MAX
  )
  const summary = truncateText(rest.replace(/^[.:;,\-–—\s]+/, '').trim(), SUMMARY_MAX)

  return { title: title || truncateText(flat, TITLE_MAX), summary }
}

/** First ISO date in the entry (as local midnight), else the fallback. */
export function parseEntryDate(text: string, fallback: number): number {
  const match = ISO_DATE.exec(text)

  if (!match) {
    return fallback
  }

  const [year, month, day] = match[1].split('-').map(Number)
  const date = new Date(year, month - 1, day)

  return Number.isNaN(date.getTime()) ? fallback : date.getTime()
}

const STOPWORDS = new Set(['this', 'that', 'with', 'from', 'about', 'user', 'users', 'when', 'then', 'they', 'them', 'their', 'have', 'been', 'will', 'into', 'over', 'also', 'more', 'than', 'your', 'hermes', 'memory', 'prefers', 'prefer', 'likes', 'wants', 'style'])

/** Words worth matching against session titles: 4+ letters, not boilerplate. */
export function keywordsOf(title: string): string[] {
  return Array.from(
    new Set(
      title
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(word => word.length >= 4 && !STOPWORDS.has(word))
    )
  )
}

/** How many known sessions mention one of the entry's title keywords. Cheap: substring test on title/preview. */
export function countRelatedSessions(entry: MemoryEntry, sessions: readonly SessionListRow[]): number {
  const keywords = keywordsOf(entry.title)

  if (keywords.length === 0) {
    return 0
  }

  let count = 0

  for (const session of sessions) {
    const haystack = `${session.title ?? ''} ${session.preview ?? ''}`.toLowerCase()

    if (haystack && keywords.some(word => haystack.includes(word))) {
      count++
    }
  }

  return count
}

export function buildEntries(file: MemoryFileState): MemoryEntry[] {
  return file.texts.map((text, index) => {
    const { title, summary } = splitTitle(text)

    return {
      id: `${file.file}:${index}`,
      file: file.file,
      index,
      text,
      title,
      summary,
      kind: classifyKind(text, file.file),
      date: parseEntryDate(text, file.modifiedAt),
      fileModifiedAt: file.modifiedAt
    }
  })
}

// ---------------------------------------------------------------------------------------------
// Disk IO through the Electron bridge.
// ---------------------------------------------------------------------------------------------

export const memoriesDir = (hermesHome: string) => `${hermesHome.replace(/\/$/, '')}/memories`
export const memoryPath = (hermesHome: string, file: MemoryFile) => `${memoriesDir(hermesHome)}/${file}`

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

let generation = 0

async function readMemoryFile(hermesHome: string, file: MemoryFile, listing: readonly DirEntry[]): Promise<MemoryFileState> {
  const path = memoryPath(hermesHome, file)
  const dirEntry = listing.find(entry => entry.name === file)

  if (!dirEntry) {
    return { file, path, exists: false, modifiedAt: 0, truncated: false, texts: [] }
  }

  const preview = await window.heraldOS.fs.readFile(path)

  if (preview.kind !== 'text') {
    // Binary or too large to preview: show nothing rather than a garbled list, and never write back.
    return { file, path, exists: true, modifiedAt: dirEntry.modifiedAt, truncated: true, texts: [] }
  }

  return {
    file,
    path,
    exists: true,
    modifiedAt: dirEntry.modifiedAt,
    truncated: Boolean(preview.truncated),
    texts: parse(preview.content ?? '')
  }
}

/** Re-read both files from disk. Stale loads never overwrite newer ones. */
export async function loadMemory(hermesHome: string): Promise<void> {
  const mine = ++generation
  $memory.set({ ...$memory.get(), loading: true })

  try {
    let listing: DirEntry[] = []

    try {
      listing = await window.heraldOS.fs.readDir(memoriesDir(hermesHome))
    } catch {
      // No memories folder yet: both files are simply absent.
    }

    const states = await Promise.all(MEMORY_FILES.map(file => readMemoryFile(hermesHome, file, listing)))

    if (mine !== generation) {
      return
    }

    const files = Object.fromEntries(states.map(state => [state.file, state])) as Record<MemoryFile, MemoryFileState>
    $memory.set({ files, entries: states.flatMap(buildEntries), loading: false, loaded: true, error: null })
  } catch (err) {
    if (mine !== generation) {
      return
    }

    $memory.set({ ...$memory.get(), loading: false, loaded: true, error: errorMessage(err) })
  }
}

/** Replace one file's entries: optimistic cache update, write, then re-read from disk (honest). */
async function commitFile(hermesHome: string, file: MemoryFile, texts: string[]): Promise<void> {
  const state = $memory.get()
  const current = state.files?.[file]

  if (current?.truncated) {
    throw new Error(`${file} is too large to edit safely from here`)
  }

  if (state.files && current) {
    const next: MemoryFileState = { ...current, texts, exists: true, modifiedAt: Date.now() }
    const files = { ...state.files, [file]: next }
    $memory.set({ ...state, files, entries: MEMORY_FILES.flatMap(name => buildEntries(files[name])) })
  }

  try {
    if (!current?.exists) {
      try {
        await window.heraldOS.fs.mkdir(memoriesDir(hermesHome))
      } catch {
        // Folder probably exists already; the write below reports real failures.
      }
    }

    await window.heraldOS.fs.writeText(memoryPath(hermesHome, file), serialize(texts))
  } finally {
    await loadMemory(hermesHome)
  }
}

const textsOf = (file: MemoryFile) => [...($memory.get().files?.[file]?.texts ?? [])]

export function updateEntry(hermesHome: string, entry: MemoryEntry, text: string): Promise<void> {
  const texts = textsOf(entry.file)
  texts[entry.index] = text.trim()

  return commitFile(hermesHome, entry.file, texts)
}

export function forgetEntry(hermesHome: string, entry: MemoryEntry): Promise<void> {
  return commitFile(
    hermesHome,
    entry.file,
    textsOf(entry.file).filter((_, index) => index !== entry.index)
  )
}

/** Append an entry and return the id it will have once written. */
export async function addEntry(hermesHome: string, file: MemoryFile, text: string): Promise<string> {
  const texts = textsOf(file)
  const id = `${file}:${texts.length}`
  await commitFile(hermesHome, file, [...texts, text.trim()])

  return id
}
