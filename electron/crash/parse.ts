import type { CrashReport } from '../../shared/ipc.ts'

/** journald's MESSAGE_ID for systemd-coredump's "Process … dumped core" entries. */
export const COREDUMP_MESSAGE_ID = 'fc2e22bc6ee647b6b90729ab34a250b1'

/** macOS bug types that mean "a process crashed" (309: current format, 109: older releases). */
const CRASH_BUG_TYPES = new Set(['309', '109'])

/** Report names that are diagnostics rather than crashes. */
const NOT_CRASHES = /^(JetsamEvent|Analytics|ExcUserFault|stacks|WakeupsResource|CPUResource|DiskWrites|shutdown_stall)/i

/** Our own processes: a crashed Veritas window reloads by itself, and reporting it inside Veritas is noise. */
const OURSELVES = /^(Veritas OS|Electron)\b/i

interface IpsHeader {
  app_name?: string
  name?: string
  bug_type?: string
  incident_id?: string
  timestamp?: string
}

interface IpsBody {
  pid?: number
  procName?: string
  procPath?: string
  exception?: { type?: string; signal?: string }
}

/**
 * A macOS `.ips` crash report: a one-line JSON header, then the JSON body. Returns null for
 * reports that are not crashes (hangs, resource reports, analytics) or that cannot be read.
 */
export function parseIpsReport(fileName: string, text: string, fallbackAt = Date.now()): CrashReport | null {
  if (!fileName.endsWith('.ips') || NOT_CRASHES.test(fileName)) {
    return null
  }

  const newline = text.indexOf('\n')
  const header = parseJson<IpsHeader>(newline >= 0 ? text.slice(0, newline) : text)

  if (!header || !CRASH_BUG_TYPES.has(String(header.bug_type ?? ''))) {
    return null
  }

  const body = newline >= 0 ? parseJson<IpsBody>(text.slice(newline + 1)) : null
  const app = (header.app_name || header.name || body?.procName || '').trim()

  if (!app) {
    return null
  }

  const exception = body?.exception
  const reason = exception?.type ? (exception.signal ? `${exception.type} (${exception.signal})` : exception.type) : exception?.signal
  const at = header.timestamp ? parseIpsTimestamp(header.timestamp) : null

  return {
    id: `ips:${header.incident_id || fileName}`,
    app,
    pid: typeof body?.pid === 'number' ? body.pid : undefined,
    exe: body?.procPath || undefined,
    reason: reason || undefined,
    at: at ?? fallbackAt,
    source: 'macos'
  }
}

/** "2026-10-06 14:22:05.00 +1100" -> epoch ms. */
export function parseIpsTimestamp(value: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)? ([+-])(\d{2})(\d{2})$/.exec(value.trim())

  if (!match) {
    return null
  }

  const [, day, clock, fraction = '', sign, hours, minutes] = match
  const millis = `${fraction.slice(1)}000`.slice(0, 3)
  const ms = Date.parse(`${day}T${clock}.${millis}${sign}${hours}:${minutes}`)

  return Number.isFinite(ms) ? ms : null
}

/** One `journalctl -o json` line for a systemd-coredump entry; null for anything else. */
export function parseCoredumpEntry(line: string, uid: number | null): CrashReport | null {
  const entry = parseJson<Record<string, unknown>>(line)

  if (!entry || entry.MESSAGE_ID !== COREDUMP_MESSAGE_ID) {
    return null
  }

  const field = (name: string): string | undefined => {
    const value = entry[name]

    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  }

  // The system journal holds everyone's crashes; only ours are worth offering help with.
  if (uid !== null && field('COREDUMP_UID') !== undefined && Number(field('COREDUMP_UID')) !== uid) {
    return null
  }

  const exe = field('COREDUMP_EXE')
  const app = field('COREDUMP_PACKAGE_NAME') ?? field('COREDUMP_COMM') ?? exe?.split('/').pop()

  if (!app) {
    return null
  }

  const pid = Number(field('COREDUMP_PID'))
  const micros = Number(field('COREDUMP_TIMESTAMP') ?? field('__REALTIME_TIMESTAMP'))

  return {
    id: `coredump:${Number.isFinite(pid) ? pid : app}:${Number.isFinite(micros) ? micros : Date.now()}`,
    app,
    pid: Number.isFinite(pid) ? pid : undefined,
    exe,
    reason: field('COREDUMP_SIGNAL_NAME') ?? (field('COREDUMP_SIGNAL') ? `signal ${field('COREDUMP_SIGNAL')}` : undefined),
    at: Number.isFinite(micros) && micros > 0 ? Math.floor(micros / 1000) : Date.now(),
    source: 'coredump'
  }
}

export interface CrashFilter {
  muted: readonly string[]
  /** Processes Veritas OS runs itself (the Hermes backend), which it restarts on its own. */
  ownPids: readonly number[]
  /** When each program last raised a notification, epoch ms. */
  lastNotified: ReadonlyMap<string, number>
  now: number
}

/** A program that keeps crashing gets one offer per this window, not one per crash. */
export const CRASH_QUIET_MS = 10 * 60_000

/** Veritas OS itself or a process it runs (and restarts on its own). */
export function isOwnCrash(report: CrashReport, ownPids: readonly number[]): boolean {
  return OURSELVES.test(report.app) || (report.pid !== undefined && ownPids.includes(report.pid))
}

/** Whether a crash deserves a notification. */
export function shouldOffer(report: CrashReport, filter: CrashFilter): boolean {
  const name = report.app.toLowerCase()

  if (isOwnCrash(report, filter.ownPids)) {
    return false
  }

  if (filter.muted.some(entry => entry.toLowerCase() === name || (report.exe !== undefined && entry === report.exe))) {
    return false
  }

  const last = filter.lastNotified.get(name)

  return last === undefined || filter.now - last >= CRASH_QUIET_MS
}

function parseJson<T>(text: string): T | null {
  try {
    const value = JSON.parse(text) as unknown

    return value && typeof value === 'object' ? (value as T) : null
  } catch {
    return null
  }
}
