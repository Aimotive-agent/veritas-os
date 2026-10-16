const READY_RE = /^(?:HERMES_BACKEND_READY|HERMES_DASHBOARD_READY)\s+port=(\d+)\s*$/
const READY_FILE_RE = /^backend-ready-(\d+)\.json$/

/** The ready file `hermes serve` writes for the Electron process `pid`. */
export function readyFileName(pid: number): string {
  return `backend-ready-${pid}.json`
}

/** Ready files left by Electron processes that are gone (a crash skips the cleanup after each launch). */
export function staleReadyFiles(names: readonly string[], ownPid: number, isAlive: (pid: number) => boolean): string[] {
  return names.filter(name => {
    const pid = Number(READY_FILE_RE.exec(name)?.[1])

    return pid > 0 && pid !== ownPid && !isAlive(pid)
  })
}

/** Parse the machine sentinel `hermes serve` writes to fd 1 once it is listening. */
export function parseReadyLine(line: string): number | null {
  const match = READY_RE.exec(line.trim())

  if (!match) {
    return null
  }

  const port = Number(match[1])

  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}

/** Incremental line splitter for a byte stream; returns complete lines, keeps the remainder. */
export class LineBuffer {
  private rest = ''

  push(chunk: string): string[] {
    this.rest += chunk
    const parts = this.rest.split(/\r?\n/)
    this.rest = parts.pop() ?? ''

    return parts
  }

  flush(): string[] {
    const last = this.rest
    this.rest = ''

    return last ? [last] : []
  }
}
