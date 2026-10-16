import { $activeChatId, $chats } from '../store/chat.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'
import { isPanels } from '../store/shell.ts'
import { $studios, focusStudioFile, openStudio, setPreview, studioWindowFor } from '../store/studio.ts'
import { startBuild } from '../store/studio-actions.ts'
import { $focusedWindowId, $windows, closeWindow } from '../store/windows.ts'

/* The Studio: build something and watch Hermes do it. */

/** The session a Studio command means: the Studio in front, else the newest Studio, else the active chat. */
function studioSession(): string | null {
  const windows = $windows.get()
  const focused = windows[$focusedWindowId.get() ?? '']

  if (focused?.appId === 'studio' && typeof focused.payload?.sessionId === 'string') {
    return focused.payload.sessionId
  }

  const newest = Object.values(windows)
    .filter(w => w.appId === 'studio' && w.phase !== 'closing' && typeof w.payload?.sessionId === 'string')
    .sort((a, b) => b.z - a.z)[0]

  return (newest?.payload?.sessionId as string | undefined) ?? $activeChatId.get()
}

const titleOf = (sessionId: string): string | undefined => $chats.get()[sessionId]?.title || undefined

/** "a website for" + "a hair salon" without doubling the article the speaker already said. */
const joinGoal = (prefix: unknown, goal: string): string => (typeof prefix === 'string' && prefix ? `${prefix} ${goal}` : goal)

const website = (verb: string) => [
  { phrase: `${verb} a website for {goal}`, args: { prefix: 'a website for' } },
  { phrase: `${verb} me a website for {goal}`, args: { prefix: 'a website for' } },
  { phrase: `${verb} a landing page for {goal}`, args: { prefix: 'a landing page for' } },
  { phrase: `${verb} an app that {goal}`, args: { prefix: 'an app that' } },
  { phrase: `${verb} an app for {goal}`, args: { prefix: 'an app for' } },
  { phrase: `${verb} me an app that {goal}`, args: { prefix: 'an app that' } },
  { phrase: `${verb} a game where {goal}`, args: { prefix: 'a game where' } }
]

export const studioCommands: readonly OsCommand[] = [
  {
    id: 'build.start',
    title: 'Build something',
    description: 'Create a project folder, have Hermes build it there, and watch in the Studio (files, code, terminal, live preview).',
    tier: 'mutate',
    args: [
      { name: 'goal', type: 'string', description: 'What to build, e.g. "a website for a hair salon"', required: true },
      { name: 'prefix', type: 'string', description: 'Words the phrase already said ("a website for")' }
    ],
    phrases: [...website('create'), ...website('build'), ...website('make'), 'build me {goal}', 'start a project to {goal}', 'start a new project {goal}'],
    run: async ({ goal, prefix }) => {
      const { sessionId, folder, title } = await startBuild(joinGoal(prefix, String(goal)))

      return ok(`Building ${title}`, { spoken: 'On it. Watch the Studio.', highlight: { kind: 'window', id: studioWindowFor(sessionId) ?? '' }, data: { sessionId, folder } })
    }
  },
  {
    id: 'studio.open',
    title: 'Show the Studio',
    description: 'Watch Hermes work: its files, code, commands and the live preview.',
    tier: 'read',
    args: [],
    phrases: ['show me the code', 'show me what you are doing', 'show me what youre doing', 'show me what you did', 'open the studio', 'show the studio', 'show me the build', 'show me', 'let me watch', 'show me the site', 'show me the website', 'show me the preview'],
    run: () => {
      const sessionId = studioSession()

      if (!sessionId) {
        return fail('Hermes is not working on anything yet. Say "build …" to start.')
      }

      const id = openStudio(sessionId, titleOf(sessionId))

      return ok('Opened the Studio', { highlight: { kind: 'window', id }, data: { sessionId } })
    }
  },
  {
    id: 'studio.preview',
    title: 'Preview a site in the Studio',
    description: 'Show a URL (usually the dev server, http://localhost:PORT) or a project file in the Studio preview.',
    tier: 'act',
    args: [{ name: 'url', type: 'string', description: 'http(s) address or absolute path to an HTML file', required: true }],
    phrases: ['preview {url}', 'preview {url} in the studio'],
    run: ({ url }) => {
      const sessionId = studioSession()
      const target = String(url).trim()

      if (!sessionId) {
        return fail('No Studio to preview in.')
      }

      if (!/^https?:\/\//i.test(target) && !target.startsWith('/') && !target.startsWith('file://')) {
        return fail('Preview a web address (http://localhost:5173) or an absolute path.')
      }

      setPreview(sessionId, target)
      const id = openStudio(sessionId, titleOf(sessionId))

      return ok(`Previewing ${target}`, { highlight: { kind: 'window', id } })
    }
  },
  {
    id: 'studio.file',
    title: 'Show a file in the Studio',
    description: 'Put a project file in the Studio code view.',
    tier: 'read',
    args: [{ name: 'path', type: 'string', description: 'Absolute path, or relative to the project folder', required: true }],
    phrases: ['open {path} in the studio', 'show {path} in the studio'],
    run: ({ path }) => {
      const sessionId = studioSession()

      if (!sessionId) {
        return fail('No Studio open.')
      }

      const raw = String(path).trim()
      const cwd = $studios.get()[sessionId]?.cwd
      const absolute = raw.startsWith('/') || !cwd ? raw : `${cwd}/${raw.replace(/^\.\//, '')}`
      focusStudioFile(sessionId, absolute)
      const id = openStudio(sessionId, titleOf(sessionId))

      return ok(`Showing ${absolute.split('/').pop()}`, { highlight: { kind: 'window', id } })
    }
  },
  {
    id: 'studio.close',
    title: 'Close the Studio',
    description: 'Close the Studio window (Hermes keeps working).',
    tier: 'act',
    args: [],
    phrases: ['close the studio', 'hide the studio'],
    run: async () => {
      // Panels mode: the Studio is its own compositor window.
      if (isPanels) {
        await window.heraldOS.shell.close('window:studio')

        return ok('Closed the Studio')
      }

      const sessionId = studioSession()
      const id = sessionId ? studioWindowFor(sessionId) : null

      if (!id) {
        return ok('The Studio is not open')
      }

      closeWindow(id)

      return ok('Closed the Studio')
    }
  },
  {
    id: 'studio.hint',
    title: 'Studio hint',
    description: 'Caption telling the user they can watch Hermes build.',
    tier: 'read',
    args: [],
    hidden: true,
    run: () => ok('Hermes is building. Say "show me" to watch.', { spoken: '' })
  }
]
