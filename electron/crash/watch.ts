import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ipcMain } from 'electron'
import { type CrashReport, IPC } from '../../shared/ipc.ts'
import { log } from '../log.ts'
import { readPrefs } from '../prefs.ts'
import { COREDUMP_MESSAGE_ID, isOwnCrash, parseCoredumpEntry, parseIpsReport, shouldOffer } from './parse.ts'

const RECENT_MAX = 20
const SEEN_MAX = 500
/** The crash reporter writes a report in pieces; read it once the writer has had a moment. */
const SETTLE_MS = 1500
/** fs.watch also fires for renames and deletions; a crash is only news while its report is fresh. */
const FRESH_MS = 5 * 60_000
const JOURNAL_RESTARTS = 5
const JOURNAL_RETRY_MS = 60_000

/**
 * Notices when a program crashes so Hermes can offer to explain it: macOS crash reports in
 * ~/Library/Logs/DiagnosticReports, Linux core dumps through systemd-coredump's journal entries.
 * It only offers (a notification the renderer shows with "Ask Hermes"); it never opens anything.
 */
export class CrashWatcher {
  private readonly recent: CrashReport[] = []
  private readonly seen = new Set<string>()
  private readonly lastNotified = new Map<string, number>()
  private watcher: fs.FSWatcher | null = null
  private journal: ChildProcess | null = null
  private journalRestarts = 0
  private stopped = false

  constructor(
    /** Hand a crash worth offering help with to the Hermes window. */
    private readonly deliver: (report: CrashReport) => void,
    /** Processes Veritas OS restarts on its own (the Hermes backend). */
    private readonly ownPids: () => number[],
    /** Every crash that is not Veritas OS's own, muted or not (hooks and automations react to these). */
    private readonly onCrash?: (report: CrashReport) => void
  ) {}

  start(): void {
    ipcMain.handle(IPC.crashRecent, () => this.recent)

    if (process.platform === 'darwin') {
      this.watchDiagnosticReports()
    } else if (process.platform === 'linux') {
      this.followJournal()
    }
  }

  stop(): void {
    this.stopped = true
    this.watcher?.close()
    this.watcher = null
    this.journal?.kill()
    this.journal = null
  }

  private watchDiagnosticReports(): void {
    const dir = path.join(os.homedir(), 'Library', 'Logs', 'DiagnosticReports')

    try {
      fs.mkdirSync(dir, { recursive: true })
      this.watcher = fs.watch(dir, (_event, file) => {
        if (file && file.endsWith('.ips')) {
          setTimeout(() => this.readReport(path.join(dir, file)), SETTLE_MS).unref()
        }
      })
      this.watcher.on('error', error => log('crash', `watching ${dir} stopped: ${error.message}`))
    } catch (error) {
      log('crash', `cannot watch ${dir}: ${(error as Error).message}`)
    }
  }

  private readReport(file: string): void {
    let stat: fs.Stats
    let text: string

    try {
      stat = fs.statSync(file)
      text = stat.isFile() && Date.now() - stat.mtimeMs < FRESH_MS ? fs.readFileSync(file, 'utf8') : ''
    } catch {
      return
    }

    const report = text ? parseIpsReport(path.basename(file), text, stat.mtimeMs) : null

    if (report) {
      this.handle({ ...report, reportPath: file })
    }
  }

  private followJournal(): void {
    let missing = false
    const child = spawn('journalctl', ['-f', '-o', 'json', '-n', '0', `MESSAGE_ID=${COREDUMP_MESSAGE_ID}`], { stdio: ['ignore', 'pipe', 'ignore'] })
    this.journal = child
    let buffer = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf('\n')

      while (index >= 0) {
        const report = parseCoredumpEntry(buffer.slice(0, index), process.getuid?.() ?? null)
        buffer = buffer.slice(index + 1)

        if (report) {
          this.handle(report)
        }

        index = buffer.indexOf('\n')
      }
    })
    child.on('error', error => {
      missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
      log('crash', `journalctl unavailable: ${error.message}`)
    })
    child.on('exit', () => {
      if (this.journal === child) {
        this.journal = null
      }

      // Without systemd there is nothing to follow; a journal that went away gets a few retries.
      if (missing || this.stopped || this.journalRestarts >= JOURNAL_RESTARTS) {
        return
      }

      this.journalRestarts += 1
      setTimeout(() => {
        if (!this.stopped) {
          this.followJournal()
        }
      }, JOURNAL_RETRY_MS).unref()
    })
  }

  private handle(report: CrashReport): void {
    if (this.seen.has(report.id)) {
      return
    }

    if (this.seen.size >= SEEN_MAX) {
      this.seen.clear()
    }

    this.seen.add(report.id)
    this.recent.unshift(report)
    this.recent.splice(RECENT_MAX)
    log('crash', `${report.app} crashed${report.reason ? ` (${report.reason})` : ''}`)

    const prefs = readPrefs().crashHelp
    const ownPids = [process.pid, ...this.ownPids()]
    const now = Date.now()

    if (!isOwnCrash(report, ownPids)) {
      this.onCrash?.(report)
    }

    if (!prefs.enabled || !shouldOffer(report, { muted: prefs.muted, ownPids, lastNotified: this.lastNotified, now })) {
      return
    }

    this.lastNotified.set(report.app.toLowerCase(), now)
    this.deliver(report)
  }
}
