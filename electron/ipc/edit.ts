import { ipcMain, type WebContents } from 'electron'
import { type EditAction, IPC, type KeyModifier } from '../../shared/ipc.ts'
import type { WebViews } from './web.ts'

/*
 * Typing and editing on behalf of the user (voice "type hello", "select all", "copy", "press
 * enter"). Chromium performs them on the focused element of the target contents exactly as if the
 * keyboard had, so they work in text fields, the composer, xterm's terminal input and web pages.
 * The renderer restores focus to the last text field before asking, and names a web view when the
 * focused Hermes window hosts one.
 */

const NAMED_KEYS: Record<string, { keyCode: string; char?: string }> = {
  enter: { keyCode: 'Enter', char: '\r' },
  return: { keyCode: 'Enter', char: '\r' },
  tab: { keyCode: 'Tab', char: '\t' },
  escape: { keyCode: 'Escape' },
  esc: { keyCode: 'Escape' },
  backspace: { keyCode: 'Backspace' },
  delete: { keyCode: 'Delete' },
  space: { keyCode: 'Space', char: ' ' },
  up: { keyCode: 'Up' },
  down: { keyCode: 'Down' },
  left: { keyCode: 'Left' },
  right: { keyCode: 'Right' },
  home: { keyCode: 'Home' },
  end: { keyCode: 'End' },
  pageup: { keyCode: 'PageUp' },
  pagedown: { keyCode: 'PageDown' }
}

/** Resolve a spoken/typed key name to Electron's keyCode (pure; `null` when unknown). */
export function resolveKey(name: string): { keyCode: string; char?: string } | null {
  const key = name.toLowerCase().replace(/\s+/g, '')

  if (NAMED_KEYS[key]) {
    return NAMED_KEYS[key]
  }

  if (/^[a-z0-9]$/.test(key)) {
    return { keyCode: key.toUpperCase(), char: key }
  }

  if (/^f([1-9]|1[0-2])$/.test(key)) {
    return { keyCode: key.toUpperCase() }
  }

  return null
}

function pressKey(contents: WebContents, name: string, modifiers: KeyModifier[] = []): void {
  const key = resolveKey(name)

  if (!key) {
    throw new Error(`Unknown key "${name}"`)
  }

  contents.sendInputEvent({ type: 'keyDown', keyCode: key.keyCode, modifiers })

  // Printable keys and Enter/Tab also need a char event, except when a modifier turns them into a shortcut.
  if (key.char && !modifiers.some(m => m === 'meta' || m === 'control' || m === 'alt')) {
    contents.sendInputEvent({ type: 'char', keyCode: key.char, modifiers })
  }

  contents.sendInputEvent({ type: 'keyUp', keyCode: key.keyCode, modifiers })
}

export function performEdit(contents: WebContents, action: EditAction): void {
  switch (action.kind) {
    case 'insert':
      if (action.text) {
        void contents.insertText(action.text)
      }

      return
    case 'key':
      pressKey(contents, action.key, action.modifiers)

      return
    case 'copy':
      contents.copy()

      return
    case 'cut':
      contents.cut()

      return
    case 'paste':
      contents.paste()

      return
    case 'selectAll':
      contents.selectAll()

      return
    case 'unselect':
      contents.unselect()

      return
    case 'undo':
      contents.undo()

      return
    case 'redo':
      contents.redo()

      return
    case 'delete':
      contents.delete()

      return
  }
}

export function registerEditIpc(getWebViews: () => WebViews | null): void {
  ipcMain.handle(IPC.editAction, (event, action: EditAction, webViewId?: string) => {
    const target = webViewId ? getWebViews()?.contentsFor(webViewId, event.sender) : event.sender

    if (!target) {
      throw new Error('That web page is no longer open.')
    }

    // Input events only reach a focused page; the guest view must hold focus to receive keys.
    if (webViewId) {
      target.focus()
    }

    performEdit(target, action)
  })
}
