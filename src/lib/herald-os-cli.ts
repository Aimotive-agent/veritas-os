import type { HeraldOsResult } from '../../shared/ipc.ts'
import { relayToMain } from '../store/shell.ts'

/** Exit code main returns when the `herald-os` CLI does not exist on this platform (macOS, desktop mode). */
export const CLI_UNAVAILABLE_CODE = 127

export const CLI_UNAVAILABLE_MESSAGE = 'Available on Veritas OS Linux'

export interface CliOutcome {
  ok: boolean
  /** True when the CLI is not present here at all (not an error worth a toast). */
  unavailable: boolean
  code: number
  /** The last few lines of stdout (on success) or stderr (on failure), trimmed. */
  output: string
}

/** Keep the last `lines` non-empty lines of a stream so the overlay can show a compact result. */
export function tailLines(text: string, lines = 4): string {
  const parts = text
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(line => line.length > 0)

  return parts.slice(-lines).join('\n')
}

function summarize(result: HeraldOsResult): CliOutcome {
  if (result.code === CLI_UNAVAILABLE_CODE) {
    return { ok: false, unavailable: true, code: result.code, output: CLI_UNAVAILABLE_MESSAGE }
  }

  const ok = result.code === 0
  const output = tailLines(ok ? result.stdout || result.stderr : result.stderr || result.stdout)

  return { ok, unavailable: false, code: result.code, output }
}

/**
 * Run a `herald-os` CLI command from any surface. Never throws: a missing bridge or a rejected IPC
 * becomes a failed outcome so callers can show it inline.
 */
export async function runHeraldOs(argv: string[]): Promise<CliOutcome> {
  const bridge = window.heraldOS?.shell?.heraldOs

  if (typeof bridge !== 'function') {
    return { ok: false, unavailable: true, code: CLI_UNAVAILABLE_CODE, output: CLI_UNAVAILABLE_MESSAGE }
  }

  try {
    return summarize(await bridge(argv))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    return { ok: false, unavailable: false, code: 1, output: tailLines(message) }
  }
}

/** Run a command and relay a toast describing the result to the Hermes window (silent when the CLI is unavailable). */
export async function runHeraldOsWithToast(argv: string[], title: string): Promise<CliOutcome> {
  const outcome = await runHeraldOs(argv)

  if (!outcome.unavailable) {
    const body = outcome.ok ? outcome.output || 'Done' : outcome.output || `herald-os exited with code ${outcome.code}`
    relayToMain({ type: 'notify', args: [outcome.ok ? title : `${title} failed`, body] })
  }

  return outcome
}

/** Theme names from `herald-os theme list`: one per line, blanks and comments dropped. */
export function parseThemeList(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
}
