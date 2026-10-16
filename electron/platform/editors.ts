import type { InstalledApp } from '../../shared/ipc.ts'

/** The code editors `openIn('editor')` looks for, in order of preference. */
export const CODE_EDITORS = ['Visual Studio Code', 'Cursor', 'Zed'] as const

/** The first of `CODE_EDITORS` among the installed apps, matched by name. */
export function findCodeEditor(apps: readonly InstalledApp[]): InstalledApp {
  for (const name of CODE_EDITORS) {
    const app = apps.find(candidate => candidate.name.toLowerCase() === name.toLowerCase())

    if (app) {
      return app
    }
  }

  throw new Error(`No code editor is installed (Veritas OS looks for ${CODE_EDITORS.join(', ')})`)
}
