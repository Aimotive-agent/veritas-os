import type { ContinuityThread } from '../../shared/ipc.ts'
import { findThread } from '../lib/continuity.ts'
import { $catchUp, $continuity, $threads, continueThread, refreshThreads, startNextStep } from '../store/continuity.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'
import { showPage } from '../store/windows.ts'

/* "Pick up where you left off": catch up, then resume a thread or start its next step. */

const threadArg = { name: 'thread', type: 'string', description: 'Which thread: words from its title, or first / second / third (default: the first)' } as const

function threadOrFail(query: unknown): ContinuityThread | string {
  const threads = $threads.get()

  if (!threads.length) {
    return 'There is nothing to pick up yet. Ask "what was I doing?" first.'
  }

  return findThread(threads, query) ?? `No thread matches "${String(query)}". The threads are: ${threads.map(t => t.title).join('; ')}.`
}

export const continuityCommands: readonly OsCommand[] = [
  {
    id: 'continuity.catchUp',
    title: 'Pick up where I left off',
    description: 'Look at recent documents, projects, chats and the calendar, and suggest where to continue.',
    tier: 'read',
    args: [],
    phrases: ['what was I doing', 'where did I leave off', 'pick up where I left off', 'catch me up', 'what should I continue'],
    run: async () => {
      if ($continuity.get().enabled !== true) {
        return fail('Pick up where you left off is off. Turn it on from the Overview or in Settings, Privacy.', { page: 'overview' })
      }

      showPage('overview')
      const threads = await refreshThreads({ force: true })
      const status = $catchUp.get()

      if (status.phase === 'error') {
        return fail(status.message, { page: 'overview' })
      }

      if (!threads.length) {
        return ok('Nothing to pick up right now.', { page: 'overview' })
      }

      return ok(`You can pick up: ${threads.map(t => t.title).join('; ')}.`, {
        page: 'overview',
        items: threads.map(t => ({ id: t.id, title: t.title, summary: t.summary, stopped: t.stopped, next: t.next?.label }))
      })
    }
  },
  {
    id: 'continuity.continue',
    title: 'Continue where I left off',
    description: "Reopen a thread's conversation, folder and documents.",
    tier: 'act',
    args: [threadArg],
    phrases: ['continue where I left off', 'continue {thread}', 'reopen {thread}'],
    run: async args => {
      const thread = threadOrFail(args.thread)

      if (typeof thread === 'string') {
        return fail(thread)
      }

      await continueThread(thread)

      return ok(`Reopened ${thread.title}.`)
    }
  },
  {
    id: 'continuity.nextStep',
    title: 'Do the suggested next step',
    description: 'Start the next step Hermes suggested for a thread, in its own conversation when it has one.',
    tier: 'act',
    args: [threadArg],
    phrases: ['do the next step', 'start the next step', 'next step for {thread}'],
    run: async args => {
      const thread = threadOrFail(args.thread)

      if (typeof thread === 'string') {
        return fail(thread)
      }

      if (!thread.next) {
        return fail(`Hermes did not suggest a next step for ${thread.title}.`)
      }

      await startNextStep(thread)

      return ok(`Started: ${thread.next.label}.`, { page: 'hermes' })
    }
  }
]
