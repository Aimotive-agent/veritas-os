import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const FALLBACK_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']

/**
 * GUI apps on macOS inherit a minimal PATH. The backend (and the tools the agent runs through it)
 * expect the user's login-shell PATH, so ask the login shell once and merge with sane fallbacks.
 */
export async function loginShellPath(timeoutMs = 4000): Promise<string> {
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  const fromShell = await new Promise<string>(resolve => {
    const child = execFile(shell, ['-lc', 'printf "%s" "$PATH"'], { timeout: timeoutMs }, (error, stdout) => {
      resolve(error ? '' : stdout.trim())
    })
    child.on('error', () => resolve(''))
  })

  const seen = new Set<string>()
  const merged: string[] = []

  for (const dir of [
    ...fromShell.split(path.delimiter),
    ...(process.env.PATH ?? '').split(path.delimiter),
    path.join(os.homedir(), '.local', 'bin'),
    ...FALLBACK_DIRS
  ]) {
    if (dir && !seen.has(dir)) {
      seen.add(dir)
      merged.push(dir)
    }
  }

  return merged.join(path.delimiter)
}
