import { atom, computed } from 'nanostores'
import { isExcluded } from '../../shared/continuity.ts'
import type { ContinuityItem, ContinuityPrefs, ContinuityThread } from '../../shared/ipc.ts'
import { type FileItem, messageOf, navigate, openItem } from '../features/files/files-store.ts'
import type { ChatState } from '../lib/chat-model.ts'
import { buildCatchUp, CATCH_UP_INSTRUCTIONS, type CatchUpChat, type CatchUpEvidence, parseThreads, readTranscript, type StoredMessage, type TranscriptFacts } from '../lib/continuity.ts'
import { rest } from '../lib/rest.ts'
import { $env, $prefs, updatePrefs } from './backend.ts'
import { createChat, LISTED_SESSION_SOURCES, openStoredSession, sendPrompt } from './chat.ts'
import { $connectionEpoch, gatewayRequest, isGatewayOpen } from './gateway.ts'
import { $missions } from './missions.ts'
import { notify } from './notifications.ts'
import { isMainSurface } from './shell.ts'
import { openStudio } from './studio.ts'
import { $page, showPage } from './windows.ts'

/*
 * "Pick up where you left off". On boot and whenever the user comes back from a break, Hermes
 * reads what this computer shows of their recent work (main's context snapshot, conversations,
 * today's calendar) in one stateless call, with no session and no tools, and answers with up to
 * three threads. Threads live in prefs so the Overview shows the last ones at once. Resuming is
 * always the user's click.
 */

export type CatchUpStatus = { phase: 'idle' } | { phase: 'thinking' } | { phase: 'error'; message: string }

export const $catchUp = atom<CatchUpStatus>({ phase: 'idle' })
export const $continuity = computed($prefs, prefs => prefs.continuity)
export const $threads = computed($continuity, continuity => {
  if (continuity.enabled !== true) {
    return []
  }

  const dismissed = new Set(continuity.dismissed ?? [])

  return (continuity.threads ?? []).filter(thread => !dismissed.has(thread.id))
})

/** Boot and short returns reuse threads younger than this; Refresh always asks again. */
const FRESH_MS = 10 * 60_000
const CHAT_WINDOW_MS = 3 * 86_400_000
/** Room for a reasoning model to think before it writes the JSON. */
const MAX_TOKENS = 4000
/** Let prefs and the session list arrive before the first catch-up. */
const BOOT_DELAY_MS = 3000
/** Conversations whose newest messages go into the evidence (one small read each). */
const CHATS_READ = 8

/** Where a stored conversation stopped, read from its transcript (no session is resumed). */
async function storedFacts(storedId: string): Promise<TranscriptFacts> {
  try {
    const page = await rest.get<{ messages?: StoredMessage[] }>(`/api/sessions/${encodeURIComponent(storedId)}/messages`, { limit: 12, order: 'latest' })

    return readTranscript(page.messages ?? [])
  } catch {
    return { stopped: false }
  }
}

let running: Promise<ContinuityThread[]> | null = null

export function refreshThreads(options: { force?: boolean; awayMs?: number } = {}): Promise<ContinuityThread[]> {
  const continuity = $continuity.get()

  if (continuity.enabled !== true) {
    return Promise.resolve([])
  }

  if (running) {
    return running
  }

  if (!options.force && continuity.updatedAt && Date.now() - continuity.updatedAt < FRESH_MS) {
    return Promise.resolve($threads.get())
  }

  running = catchUp(options.awayMs).finally(() => {
    running = null
  })

  return running
}

async function catchUp(awayMs?: number): Promise<ContinuityThread[]> {
  if (!isGatewayOpen()) {
    $catchUp.set({ phase: 'error', message: 'Hermes is still starting.' })

    return $threads.get()
  }

  $catchUp.set({ phase: 'thinking' })

  try {
    const request = buildCatchUp(await gatherEvidence(awayMs))
    let threads: ContinuityThread[] = []

    if (request) {
      const answer = await gatewayRequest('llm.oneshot', { instructions: CATCH_UP_INSTRUCTIONS, input: request.input, max_tokens: MAX_TOKENS, temperature: 0.2 }, 150_000)
      const parsed = parseThreads(answer.text, request.refs)

      if (!parsed) {
        throw new Error('Hermes answered in a form Veritas OS could not read. Try again.')
      }

      threads = parsed
    }

    const current = $continuity.get()
    await patchContinuity({ threads, updatedAt: Date.now(), dismissed: (current.dismissed ?? []).filter(id => threads.some(thread => thread.id === id)) })
    $catchUp.set({ phase: 'idle' })
  } catch (error) {
    $catchUp.set({ phase: 'error', message: messageOf(error) })
  }

  return $threads.get()
}

async function gatherEvidence(awayMs?: number): Promise<CatchUpEvidence> {
  const { exclude } = $continuity.get()
  const home = $env.get()?.homeDir ?? ''
  const hidden = (text: string | undefined) => Boolean(text && isExcluded(text, exclude, home))
  const [snapshot, calendar] = await Promise.all([window.heraldOS.context.snapshot(), window.heraldOS.calendar.today().catch(() => null)])
  const now = Date.now()
  // Conversations only: automation runs (a reminder every half hour) would crowd them out. A request
  // Hermes never answered (stopped or failed) counts: that is unfinished work.
  const candidates = $missions
    .get()
    .filter(mission => (!mission.source || LISTED_SESSION_SOURCES.has(mission.source)) && mission.messageCount > 0 && !hidden(mission.title) && !hidden(mission.goal))
    .slice(0, CHATS_READ)
  const read = await Promise.all(
    candidates.map(async (mission): Promise<CatchUpChat> => {
      const facts = await storedFacts(mission.id)

      return {
        id: mission.id,
        title: mission.title,
        preview: mission.goal,
        // A stored row only says when the conversation started; its transcript says when it was last used.
        at: Math.max(mission.updatedAt, facts.at ?? 0),
        messages: mission.messageCount,
        step: (mission.status === 'completed' ? undefined : mission.currentStep) ?? facts.step,
        last: facts.last && !hidden(facts.last) ? facts.last : undefined,
        stopped: facts.stopped && mission.status !== 'active'
      }
    })
  )
  const chats = read.filter(chat => now - chat.at < CHAT_WINDOW_MS).sort((a, b) => b.at - a.at)
  const events =
    calendar?.status === 'authorized' ? calendar.events.filter(event => !hidden(event.title)).map(event => ({ title: event.title, start: event.start, end: event.end, allDay: event.allDay })) : []

  return { now, home, awayMs, files: snapshot.files, projects: snapshot.projects, chats, events, apps: snapshot.apps }
}

function patchContinuity(patch: Partial<ContinuityPrefs>): Promise<void> {
  return updatePrefs({ continuity: { ...$continuity.get(), ...patch } })
}

export async function setContinuityEnabled(enabled: boolean): Promise<void> {
  await patchContinuity({ enabled })

  if (enabled) {
    void refreshThreads({ force: true })
  }
}

export function dismissThread(id: string): Promise<void> {
  return patchContinuity({ dismissed: [...new Set([...($continuity.get().dismissed ?? []), id])] })
}

export function forgetThreads(): Promise<void> {
  $catchUp.set({ phase: 'idle' })

  return patchContinuity({ threads: [], updatedAt: undefined, dismissed: [] })
}

export function setExclusions(exclude: string[]): Promise<void> {
  return patchContinuity({ exclude: [...new Set(exclude.map(entry => entry.trim()).filter(Boolean))] })
}

const samePath = (a: string | null | undefined, b: string) => Boolean(a) && a!.replace(/\/+$/, '') === b.replace(/\/+$/, '')

const placeOf = (thread: ContinuityThread) => thread.items.find(item => item.kind === 'project' || item.kind === 'folder')

function asFileItem(item: ContinuityItem): FileItem {
  const name = item.ref.split('/').pop() ?? item.label

  return { name, path: item.ref, kind: 'file', size: 0, modifiedAt: 0, extension: name.includes('.') ? name.split('.').pop()!.toLowerCase() : '', hidden: name.startsWith('.') }
}

/** Show a resumed conversation: in Studio when it built the thread's project folder, else on the Hermes page. */
function showChat(chat: ChatState, thread: ContinuityThread): void {
  const place = placeOf(thread)

  if (place && samePath(chat.info.cwd, place.ref)) {
    openStudio(chat.sessionId, thread.title)
  } else {
    showPage('hermes')
  }
}

/** Open one item of a thread: a document in its viewer, a folder in Files, a conversation on the Hermes page. */
export async function openThreadItem(item: ContinuityItem): Promise<void> {
  try {
    if (item.kind === 'chat') {
      await openStoredSession(item.ref)
      showPage('hermes')
    } else if (item.kind === 'file') {
      openItem(asFileItem(item))
    } else {
      showPage('files')
      navigate({ kind: 'dir', path: item.ref })
    }
  } catch (error) {
    notify({ title: `Could not open "${item.label}"`, body: messageOf(error), level: 'error' })
  }
}

/** Bring a thread's work back: its conversation, its folder and up to two of its documents. */
export async function continueThread(thread: ContinuityThread): Promise<void> {
  const chatItem = thread.items.find(item => item.kind === 'chat')
  const place = placeOf(thread)

  try {
    if (chatItem) {
      showChat(await openStoredSession(chatItem.ref), thread)
    } else if (place) {
      showPage('files')
      navigate({ kind: 'dir', path: place.ref })
    }

    for (const file of thread.items.filter(item => item.kind === 'file').slice(0, 2)) {
      openItem(asFileItem(file))
    }
  } catch (error) {
    notify({ title: `Could not reopen "${thread.title}"`, body: messageOf(error), level: 'error' })
  }
}

/** Start the suggested next step: in the thread's own conversation when it has one, else in a new chat in its folder. */
export async function startNextStep(thread: ContinuityThread): Promise<void> {
  if (!thread.next) {
    return
  }

  const chatItem = thread.items.find(item => item.kind === 'chat')

  try {
    const chat = chatItem ? await openStoredSession(chatItem.ref) : await createChat({ cwd: placeOf(thread)?.ref, title: thread.next.label })
    showChat(chat, thread)
    await sendPrompt(thread.next.prompt, { sessionId: chat.sessionId })
  } catch (error) {
    notify({ title: `Could not start "${thread.next.label}"`, body: messageOf(error), level: 'error' })
  }
}

let bound = false

export function bindContinuity(): () => void {
  if (bound || !isMainSurface) {
    return () => undefined
  }

  bound = true
  let booted = false
  const offEpoch = $connectionEpoch.subscribe(epoch => {
    if (epoch === 0 || booted) {
      return
    }

    booted = true
    setTimeout(() => void refreshThreads(), BOOT_DELAY_MS)
  })
  const offReturned = window.heraldOS.context.onReturned(event => {
    void refreshThreads({ force: true, awayMs: event.awayMs }).then(threads => {
      // Offer, never navigate: the Overview already shows the cards.
      if (threads.length && $page.get() !== 'overview') {
        notify({ title: 'Welcome back', body: `Pick up where you left off: ${threads[0].title}.`, level: 'info', key: 'continuity' })
      }
    })
  })

  return () => {
    offEpoch()
    offReturned()
    bound = false
  }
}
