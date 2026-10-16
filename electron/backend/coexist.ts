import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/*
 * Sharing a Hermes home with another app (Hermes Desktop on Omarchy, a gateway the person runs).
 * Hermes itself keeps scheduled jobs to one run (each tick takes cron/.tick.lock) and messaging to one
 * gateway (gateway.pid), so a second backend is safe. To not run one at all, point Veritas at the
 * backend already running: HERALD_OS_BACKEND_URL plus its token.
 */

export interface AttachTarget {
  baseUrl: string
  token: string
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** The running backend to use instead of starting one, or null. Loopback only: the token travels in the clear. */
export function attachTarget(env: NodeJS.ProcessEnv = process.env, readFile: (file: string) => string = file => fs.readFileSync(file, 'utf8')): AttachTarget | null {
  const raw = env.HERALD_OS_BACKEND_URL?.trim()

  if (!raw) {
    return null
  }

  let url: URL

  try {
    url = new URL(raw)
  } catch {
    throw new Error(`HERALD_OS_BACKEND_URL is not a URL: ${raw}`)
  }

  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname)) {
    throw new Error('HERALD_OS_BACKEND_URL must be an http:// address on this machine (127.0.0.1)')
  }

  let token = env.HERALD_OS_BACKEND_TOKEN?.trim() ?? ''

  if (!token) {
    const file = env.HERALD_OS_BACKEND_TOKEN_FILE?.trim() || path.join(os.homedir(), '.config', 'herald-os', 'backend-token')

    try {
      token = readFile(file).trim()
    } catch {
      throw new Error(`HERALD_OS_BACKEND_URL needs the backend's token: set HERALD_OS_BACKEND_TOKEN or write it to ${file}`)
    }
  }

  return { baseUrl: url.origin, token }
}

/** `gateway.pid`: JSON (`{"pid": …, "hermes_home": …}`) in current Hermes, a bare number in older ones. */
export function parseGatewayPid(text: string): { pid: number; home?: string } | null {
  const raw = text.trim()

  if (!raw) {
    return null
  }

  if (/^\d+$/.test(raw)) {
    return { pid: Number(raw) }
  }

  try {
    const data = JSON.parse(raw) as { pid?: unknown; hermes_home?: unknown }

    return typeof data.pid === 'number' && data.pid > 0 ? { pid: data.pid, ...(typeof data.hermes_home === 'string' ? { home: data.hermes_home } : {}) } : null
  } catch {
    return null
  }
}

/**
 * A messaging gateway on this Hermes home that is not ours (its parent is neither this app nor the
 * backend it started), or null.
 */
export function foreignGateway(
  hermesHome: string,
  own: { appPid: number; backendPid: number | null },
  probe: { alive: (pid: number) => boolean; parentOf: (pid: number) => number | null; read?: (file: string) => string }
): { pid: number } | null {
  let record: { pid: number; home?: string } | null

  try {
    record = parseGatewayPid((probe.read ?? (file => fs.readFileSync(file, 'utf8')))(path.join(hermesHome, 'gateway.pid')))
  } catch {
    return null
  }

  if (!record || !probe.alive(record.pid)) {
    return null
  }

  if (record.home && path.resolve(record.home) !== path.resolve(hermesHome)) {
    return null
  }

  const parent = probe.parentOf(record.pid)

  return parent !== null && (parent === own.appPid || parent === own.backendPid) ? null : { pid: record.pid }
}
