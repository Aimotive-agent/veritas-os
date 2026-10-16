import type { ContinuityItem, ContinuityThread, ProjectActivity, RecentFile } from '../../shared/ipc.ts'

/*
 * "Pick up where you left off", the pure half: the evidence Hermes reads (each entry tagged with a
 * short id it cites back), and the parser that turns its answer into threads. Only cited ids
 * become items, so a thread can never point at a file the evidence did not contain.
 */

export interface CatchUpChat {
  /** Stored session id. */
  id: string
  title: string
  /** How the conversation began. */
  preview?: string
  at: number
  messages: number
  /** The unfinished plan step, when there is one. */
  step?: string
  /** The start of Hermes's last reply: what was done or proposed last. */
  last?: string
  /** The last turn ended before Hermes finished it. */
  stopped?: boolean
}

export interface CatchUpEvent {
  title: string
  start: number
  end: number
  allDay: boolean
}

export interface CatchUpEvidence {
  now: number
  home: string
  /** Set when the user just came back from a break. */
  awayMs?: number
  files: readonly RecentFile[]
  projects: readonly ProjectActivity[]
  chats: readonly CatchUpChat[]
  events: readonly CatchUpEvent[]
  apps: readonly string[]
}

export interface CatchUpRequest {
  input: string
  refs: Record<string, ContinuityItem>
}

export const MAX_THREADS = 3

export const CATCH_UP_INSTRUCTIONS = `You are the memory of Veritas OS, a desktop built around the Hermes agent. You get evidence of what the user was recently doing on this computer: documents, project folders, Hermes conversations and today's calendar. Find the threads of work they will most likely want to pick up again.

Rules:
- At most ${MAX_THREADS} threads, the one most worth resuming first. Fewer is fine, and an empty list is fine when nothing is worth resuming.
- Use only the evidence. Never invent files, people, deadlines or progress.
- A thread groups the items of one piece of work: a project folder, the conversation about it, the files it produced.
- Favour unfinished work: uncommitted changes, unfinished steps, things changed today, events still to come today.
- Ignore noise such as screenshots, installers and caches unless they clearly belong to a thread. Open apps alone never make a thread.
- Speak to the user as "you", plainly and briefly, without hype or technical terms such as model, response, session or tool.

Reply with JSON only, no prose and no code fence:
{"threads":[{"title":"","summary":"","stopped":"","next":"","prompt":"","items":[]}]}
- title: the work in 2 to 5 words, named the way the user would say it: the product, site or document, not a folder name when the evidence shows a better one.
- summary: one sentence starting with "You were", saying what the work is about.
- stopped: where it stopped, under 14 words, from the evidence: what was done last, or what is still open.
- next: the most useful next step Hermes can take now, 2 to 6 words, starting with a verb. Make it concrete ("Add an online ordering page"), never generic ("Continue the project"), and prefer a step that moves the work forward (writes, builds, fixes or sends something) over one that only looks at it.
- prompt: the request the user would send Hermes to take that step: first person, specific, with the paths it needs.
- items: ids of the evidence entries that belong to the thread, like ["p1", "c2", "f3"].`

const MAX_FILES = 16
const MAX_PROJECTS = 8
const MAX_CHATS = 8
const MAX_EVENTS = 8

const pad = (n: number) => String(n).padStart(2, '0')
const clock = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`
const startOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0)

/** `today 14:05`, `yesterday 09:12`, `Saturday 18:40`, then `3 Oct`. */
export function whenLabel(ms: number, now: number): string {
  const date = new Date(ms)
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000)

  if (days <= 0) {
    return `today ${clock(date)}`
  }

  if (days === 1) {
    return `yesterday ${clock(date)}`
  }

  if (days < 7) {
    return `${date.toLocaleDateString('en-US', { weekday: 'long' })} ${clock(date)}`
  }

  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

export function durationLabel(ms: number): string {
  const minutes = Math.round(ms / 60_000)

  if (minutes < 90) {
    return `${minutes} minutes`
  }

  const hours = Math.round(minutes / 60)

  return hours < 36 ? `${hours} hours` : `${Math.round(hours / 24)} days`
}

function tilde(target: string, home: string): string {
  return home && (target === home || target.startsWith(`${home}/`)) ? `~${target.slice(home.length)}` : target
}

function folderOf(target: string, home: string): string {
  return tilde(target.slice(0, target.lastIndexOf('/')) || '/', home)
}

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

/** A stored transcript message, as `GET /api/sessions/{id}/messages` returns it. */
export interface StoredMessage {
  role?: string
  content?: unknown
  /** Epoch seconds. */
  timestamp?: number | null
}

export interface TranscriptFacts {
  /** The newest message, epoch ms. */
  at?: number
  last?: string
  step?: string
  stopped: boolean
}

/** Hermes's own note when a turn is stopped; it is not a reply. */
const INTERRUPTED = /^\s*operation interrupted\b/i

const textOf = (message: StoredMessage) => (typeof message.content === 'string' ? message.content : '')

function planOf(raw: string): { content: string; status: string }[] | null {
  if (!raw.includes('"todos"')) {
    return null
  }

  try {
    const todos = (JSON.parse(raw) as { todos?: unknown }).todos

    return Array.isArray(todos) ? todos.filter((todo): todo is { content: string; status: string } => typeof todo?.content === 'string' && typeof todo?.status === 'string') : null
  } catch {
    return null
  }
}

/**
 * Where a stored conversation stopped, from its newest messages (oldest first): a session that is
 * not live has no plan or status in the app, but its transcript still says.
 */
export function readTranscript(messages: readonly StoredMessage[]): TranscriptFacts {
  const newest = messages.at(-1)
  const last = messages.filter(message => message.role === 'assistant' && textOf(message).trim() && !INTERRUPTED.test(textOf(message))).at(-1)
  const plan = [...messages].reverse().reduce<ReturnType<typeof planOf>>((found, message) => found ?? (message.role === 'tool' ? planOf(textOf(message)) : null), null)
  const step = plan?.find(todo => todo.status === 'in_progress') ?? plan?.find(todo => todo.status === 'pending')
  const seconds = newest?.timestamp ?? 0

  return {
    at: seconds > 0 ? Math.round(seconds < 1e12 ? seconds * 1000 : seconds) : undefined,
    last: last && oneLine(textOf(last), 300),
    step: step && oneLine(step.content, 120),
    stopped: Boolean(newest) && (newest?.role !== 'assistant' || INTERRUPTED.test(textOf(newest)))
  }
}

/** The evidence as numbered lines for the model, or null when there is nothing to look at. */
export function buildCatchUp(evidence: CatchUpEvidence): CatchUpRequest | null {
  const { now, home } = evidence
  const refs: Record<string, ContinuityItem> = {}
  const sections: string[] = []
  const files = evidence.files.slice(0, MAX_FILES)
  const projects = evidence.projects.slice(0, MAX_PROJECTS)
  const chats = evidence.chats.slice(0, MAX_CHATS)

  if (!files.length && !projects.length && !chats.length) {
    return null
  }

  if (files.length) {
    const lines = files.map((file, index) => {
      const id = `f${index + 1}`
      const opened = file.lastUsedAt >= file.modifiedAt
      refs[id] = { kind: file.kind === 'directory' ? 'folder' : 'file', ref: file.path, label: file.name }

      return `${id} ${file.name} (${folderOf(file.path, home)}), ${opened ? 'opened' : 'changed'} ${whenLabel(Math.max(file.lastUsedAt, file.modifiedAt), now)}`
    })
    sections.push(['Documents', ...lines].join('\n'))
  }

  if (projects.length) {
    const lines = projects.map((project, index) => {
      const id = `p${index + 1}`
      refs[id] = { kind: 'project', ref: project.path, label: project.name }

      if (!project.branch) {
        return `${id} ${project.name} (${tilde(project.path, home)}): files changed ${whenLabel(project.touchedAt, now)}`
      }

      const files = project.changedFiles.length ? `, including ${project.changedFiles.join(', ')}` : ''
      const changes = project.changed ? `${project.changed} uncommitted ${project.changed === 1 ? 'change' : 'changes'}${files}` : 'nothing uncommitted'
      const commits = project.commits.map(commit => `"${oneLine(commit.subject, 100)}" (${whenLabel(commit.at, now)})`).join(', ')

      return `${id} ${project.name} (${tilde(project.path, home)}): git branch ${project.branch}; ${changes}${commits ? `; recent commits: ${commits}` : ''}`
    })
    sections.push(['Projects', ...lines].join('\n'))
  }

  if (chats.length) {
    const lines = chats.map((chat, index) => {
      const id = `c${index + 1}`
      refs[id] = { kind: 'chat', ref: chat.id, label: chat.title }
      const preview = chat.preview && oneLine(chat.preview, 160)
      const parts = [`${id} "${oneLine(chat.title, 100)}", ${whenLabel(chat.at, now)}, ${chat.messages > 1 ? `${chat.messages} messages` : 'asked but never answered'}`]

      if (chat.stopped && chat.messages > 1) {
        parts.push('stopped before Hermes finished')
      }

      if (chat.step) {
        parts.push(`unfinished step: "${oneLine(chat.step, 100)}"`)
      }

      if (preview && preview !== oneLine(chat.title, 160)) {
        parts.push(`it began: "${preview}"`)
      }

      if (chat.last) {
        parts.push(`Hermes's last reply: "${oneLine(chat.last, 240)}"`)
      }

      return parts.join('; ')
    })
    sections.push(['Hermes conversations', ...lines].join('\n'))
  }

  const events = evidence.events.filter(event => startOfDay(event.start) <= startOfDay(now) && event.end >= startOfDay(now)).slice(0, MAX_EVENTS)

  if (events.length) {
    const lines = events.map((event, index) => `e${index + 1} ${event.allDay ? 'all day' : `${clock(new Date(event.start))}-${clock(new Date(event.end))}`} ${oneLine(event.title, 100)}`)
    sections.push(["Today's calendar", ...lines].join('\n'))
  }

  if (evidence.apps.length) {
    sections.push(`Apps open: ${evidence.apps.join(', ')}`)
  }

  const date = new Date(now)
  const today = `${date.toLocaleDateString('en-US', { weekday: 'long' })} ${date.getDate()} ${date.toLocaleDateString('en-US', { month: 'long' })} ${date.getFullYear()}`
  const header = [`Now: ${today}, ${clock(date)}.`, evidence.awayMs ? `The user just came back after ${durationLabel(evidence.awayMs)} away.` : ''].filter(Boolean).join(' ')

  return { input: [header, ...sections].join('\n\n'), refs }
}

/** The first JSON object or array in `text`, tolerating fences and prose around it. */
function extractJson(text: string): unknown {
  const start = text.search(/[{[]/)

  if (start < 0) {
    return undefined
  }

  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))

  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
}

const field = (value: unknown, max: number): string => (typeof value === 'string' ? oneLine(value, max) : '')

export function threadId(title: string): string {
  return `t-${title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)}`
}

const ORDINALS: Record<string, number> = { first: 0, '1': 0, one: 0, second: 1, '2': 1, two: 1, third: 2, '3': 2, three: 2, last: -1 }

/** A thread by title words or position ("second"); the first one when nothing is named. */
export function findThread(threads: readonly ContinuityThread[], query: unknown): ContinuityThread | null {
  const text = String(query ?? '')
    .trim()
    .toLowerCase()
    .replace(/^the\s+/, '')

  if (!text) {
    return threads[0] ?? null
  }

  const position = ORDINALS[text.replace(/\s+(one|thread)$/, '')]

  if (position !== undefined) {
    return threads.at(position) ?? null
  }

  const exact = threads.find(thread => thread.title.toLowerCase().includes(text))

  if (exact) {
    return exact
  }

  const words = text.split(/\s+/).filter(word => word.length > 3)

  return threads.find(thread => words.some(word => thread.title.toLowerCase().includes(word))) ?? null
}

/** Threads from Hermes's answer; null when the answer is not the JSON asked for. */
export function parseThreads(text: string, refs: Record<string, ContinuityItem>): ContinuityThread[] | null {
  const json = extractJson(text)
  const list = Array.isArray(json) ? json : json && typeof json === 'object' && Array.isArray((json as { threads?: unknown }).threads) ? (json as { threads: unknown[] }).threads : null

  if (!list) {
    return null
  }

  const threads: ContinuityThread[] = []

  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || threads.length >= MAX_THREADS) {
      continue
    }

    const entry = raw as Record<string, unknown>
    const title = field(entry.title, 60)
    const summary = field(entry.summary, 240)

    if (!title || !summary || threads.some(t => t.id === threadId(title))) {
      continue
    }

    const cited = Array.isArray(entry.items) ? entry.items : []
    const items = [...new Map(cited.map(id => refs[String(id).trim()]).filter((item): item is ContinuityItem => Boolean(item)).map(item => [`${item.kind}:${item.ref}`, item])).values()].slice(0, 6)
    const label = field(entry.next, 48)
    const prompt = field(entry.prompt, 1500)

    threads.push({ id: threadId(title), title, summary, stopped: field(entry.stopped, 160), next: label && prompt ? { label, prompt } : undefined, items })
  }

  return threads
}
