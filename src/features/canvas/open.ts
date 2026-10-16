import { isPanels } from '../../store/shell.ts'
import { openApp } from '../../store/windows.ts'

/** Show Veritas Canvas, opening a file in it when one is given; the editor loads only when needed. */
export function openInCanvas(file?: string): void {
  if (isPanels) {
    // Canvas runs in its own window process there: the file goes over as the window's payload.
    openApp('canvas', { payload: file ? { path: file, at: Date.now() } : undefined })

    return
  }

  openApp('canvas')

  if (file) {
    void import('./store.ts').then(({ notify, openPath }) =>
      openPath(file).catch((error: unknown) => notify(`Could not open ${file.split('/').pop()}: ${error instanceof Error ? error.message : String(error)}`, 'error'))
    )
  }
}
