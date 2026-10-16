import { type BrowserWindow, clipboard, globalShortcut, ipcMain } from 'electron'
import { IPC, type ShellCommand } from '../../shared/ipc.ts'
import { log } from '../log.ts'
import { run } from '../platform/exec.ts'

/** macOS: Cmd+Ctrl+X starts and ends dictation from any app (Linux binds Mod+Ctrl+X in niri). */
const MAC_DICTATION_KEY = 'Command+Control+X'
/** The pasted text must land before the clipboard gets its old contents back. */
const RESTORE_CLIPBOARD_MS = 700

export interface TypeResult {
  /** Typed (or pasted) into the focused app. */
  typed: boolean
  /** Left on the clipboard instead, for the person to paste. */
  copied: boolean
}

/** Line by line with Return between: wtype stops reading options after "--", so keys need their own call. */
async function typeLinux(text: string, submit: boolean): Promise<TypeResult> {
  const lines = text.split('\n')

  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      await run('wtype', ['-k', 'Return'], 5000)
    }

    if (lines[i]) {
      const result = await run('wtype', ['--', lines[i]], 20_000)

      if (result.code !== 0) {
        await clipboard.writeText(text)
        log('dictation', `wtype failed (${result.code === 127 ? 'not installed' : result.stderr.trim()}); left the text on the clipboard`)

        return { typed: false, copied: true }
      }
    }
  }

  if (submit) {
    await run('wtype', ['-k', 'Return'], 5000)
  }

  return { typed: true, copied: false }
}

async function typeMac(text: string, submit: boolean): Promise<TypeResult> {
  const previous = await clipboard.readText().catch(() => '')
  await clipboard.writeText(text)
  const keys = ['-e', 'tell application "System Events" to keystroke "v" using command down', ...(submit ? ['-e', 'tell application "System Events" to key code 36'] : [])]
  const result = await run('osascript', keys, 10_000)

  if (result.code !== 0) {
    // Without Accessibility permission System Events cannot press keys; the text stays copied.
    log('dictation', `paste failed: ${result.stderr.trim()}`)

    return { typed: false, copied: true }
  }

  setTimeout(() => void clipboard.writeText(previous).catch(() => undefined), RESTORE_CLIPBOARD_MS)

  return { typed: true, copied: false }
}

export function registerDictationIpc(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.dictationType, async (_event, text: string, options: { submit?: boolean; delayMs?: number } = {}) => {
    const clean = String(text ?? '')

    if (!clean && !options.submit) {
      return { typed: false, copied: false } satisfies TypeResult
    }

    // Give an overlay that just closed time to hand focus back to the app being typed into.
    if (options.delayMs) {
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, options.delayMs ?? 0)))
    }

    if (process.platform === 'linux') {
      return typeLinux(clean, Boolean(options.submit))
    }

    if (process.platform === 'darwin') {
      return typeMac(clean, Boolean(options.submit))
    }

    await clipboard.writeText(clean)

    return { typed: false, copied: true } satisfies TypeResult
  })

  if (process.platform === 'darwin') {
    const registered = globalShortcut.register(MAC_DICTATION_KEY, () => getMainWindow()?.webContents.send(IPC.shellCommand, { type: 'dictate' } satisfies ShellCommand))

    if (!registered) {
      log('dictation', `${MAC_DICTATION_KEY} is taken by another app; dictation stays in the command bar`)
    }
  }
}
