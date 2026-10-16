import type { CrashReport } from '../../shared/ipc.ts'

/** "Safari quit unexpectedly". */
export function crashTitle(report: CrashReport): string {
  return `${report.app} quit unexpectedly`
}

/** Where Hermes finds the details: the report file on macOS, the core dump's pid on Linux. */
export function crashReference(report: CrashReport): string | null {
  return report.reportPath ?? (report.pid !== undefined ? String(report.pid) : null)
}

/** The opening message of a diagnosis chat. Facts only; the diagnose-crash skill carries the method. */
export function crashPrompt(report: CrashReport, now = Date.now()): string {
  const when = new Date(report.at)
  const minutes = Math.round((now - report.at) / 60_000)
  const ago = minutes < 1 ? 'just now' : minutes < 90 ? `${minutes} minute${minutes === 1 ? '' : 's'} ago` : `at ${when.toLocaleString()}`
  const reference = crashReference(report)
  const lines = [`${report.app} crashed ${ago}${report.reason ? ` (${report.reason})` : ''}.`]

  if (report.reportPath) {
    lines.push(`The crash report is ${report.reportPath}.`)
  } else if (report.pid !== undefined) {
    lines.push(`It left a core dump: pid ${report.pid}${report.exe ? `, ${report.exe}` : ''}.`)
  }

  lines.push(
    `Use the diagnose-crash skill${reference ? `: read it with system_logs (action=crash_report, report=${reference})` : ''}, ` +
      'work out what happened from the facts in the report, then tell me in plain words what went wrong, whether it is likely to happen again, ' +
      'what I can do about it, and whether it is worth reporting to the developers (offer to draft the report).'
  )

  return lines.join('\n')
}

/** Words that mean "the crash we were just talking about". */
const LATEST = new Set(['that', 'it', 'this', 'the app', 'that app', 'last', 'latest'])

/** Find a crash by id, by program name, or the newest one. */
export function findCrash(reports: readonly CrashReport[], query?: string): CrashReport | undefined {
  const needle = query?.trim().toLowerCase()

  if (!needle || LATEST.has(needle)) {
    return reports[0]
  }

  return reports.find(report => report.id === query) ?? reports.find(report => report.app.toLowerCase() === needle) ?? reports.find(report => String(report.pid) === needle) ?? reports.find(report => report.app.toLowerCase().includes(needle))
}
