import { delegate, fail, type OsCommand } from '../store/os-commands.ts'
import { looksLikeFileName, looksLikeFileNotUrl, PLACE_NAMES, resolvePlace } from './files.ts'
import { resolveAppId } from './navigation.ts'

/*
 * "Open X" is the most common utterance and X can be a page, a Hermes app, the app launcher, a
 * file, a folder, a web address or an installed application. This command routes to the right one,
 * in that order, and everything it opens stays inside Veritas OS except native Mac apps.
 */

const LAUNCHER_WORDS = new Set(['apps', 'applications', 'my apps', 'all apps', 'all my apps', 'app launcher', 'launcher', 'the launcher', 'app list'])

const WEB_ADDRESS = /^(?:https?:\/\/)?[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}(?:\/\S*)?$/i

export const openCommands: readonly OsCommand[] = [
  {
    id: 'open.any',
    title: 'Open',
    description: 'Open a page, Hermes app, the app launcher, a file, a folder, a web page (inside Veritas OS) or an installed application by name.',
    tier: 'act',
    args: [{ name: 'name', type: 'string', description: 'What to open', required: true }],
    phrases: ['open {name}', 'show {name}', 'go to {name}', 'take me to {name}', 'show me {name}', 'launch {name}', 'bring up {name}', 'pull up {name}'],
    hidden: true,
    run: async ({ name }, context) => {
      const text = String(name).trim()
      const key = text.toLowerCase().replace(/^(the|my)\s+/, '')

      if (LAUNCHER_WORDS.has(key) || LAUNCHER_WORDS.has(text.toLowerCase())) {
        return delegate('overlay.applications', {}, context)
      }

      if (resolveAppId(text)) {
        return delegate('page.open', { name: text }, context)
      }

      if (looksLikeFileName(text)) {
        return delegate('file.open', { name: text }, context)
      }

      const place = await resolvePlace(text).catch(() => null)

      if (place || PLACE_NAMES.includes(key)) {
        return delegate('files.open', { place: text }, context)
      }

      if (WEB_ADDRESS.test(text) && !looksLikeFileNotUrl(text)) {
        return delegate('web.open', { url: text }, context)
      }

      const launched = await delegate('native.launch', { name: text }, context)

      if (launched.ok) {
        return launched
      }

      // Last try: a file whose name contains the words ("open the budget spreadsheet").
      const file = await delegate('file.open', { name: text }, context)

      return file.ok ? file : fail(`I could not find a page, app, folder or file called "${text}".`)
    }
  }
]
