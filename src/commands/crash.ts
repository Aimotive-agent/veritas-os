import { findCrash } from '../lib/crash.ts'
import { $prefs } from '../store/backend.ts'
import { $crashes, diagnoseCrash, loadCrashes, setCrashHelpEnabled, setCrashMuted } from '../store/crashes.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'

/* Crash help: Hermes explains why a program crashed. */

export const crashCommands: readonly OsCommand[] = [
  {
    id: 'crash.list',
    title: 'Recent crashes',
    description: 'List the programs that crashed since Veritas OS started.',
    tier: 'read',
    args: [],
    phrases: ['what crashed', 'show recent crashes', 'list crashes'],
    run: async () => {
      const reports = await loadCrashes()

      if (reports.length === 0) {
        return ok('Nothing has crashed since Veritas OS started', { spoken: 'Nothing has crashed.' })
      }

      return ok(`${reports.length} crash${reports.length === 1 ? '' : 'es'}: ${[...new Set(reports.map(report => report.app))].slice(0, 5).join(', ')}`, {
        items: reports.map(({ id, app, pid, reason, at, reportPath }) => ({ id, app, pid, reason, at: new Date(at).toISOString(), report: reportPath }))
      })
    }
  },
  {
    id: 'crash.diagnose',
    title: 'Diagnose a crash',
    description:
      'Start a chat where Hermes reads a crash report and explains what went wrong: the newest crash, one named by id, program or pid, or one Veritas OS did not see (pass pid or report, with app).',
    tier: 'act',
    args: [
      { name: 'crash', type: 'string', description: 'Crash id, program name or pid' },
      { name: 'pid', type: 'number', description: 'The crashed process id (Linux core dumps)' },
      { name: 'report', type: 'string', description: 'A crash report path (macOS)' },
      { name: 'app', type: 'string', description: 'The program name, with pid or report' },
      { name: 'reason', type: 'string', description: 'The signal or exception, with pid or report' },
      { name: 'at', type: 'string', description: 'When it crashed (ISO 8601), with pid or report' }
    ],
    phrases: ['why did {crash} crash', 'diagnose the {crash} crash', 'what happened to {crash}', { phrase: 'why did that crash', args: {} }],
    run: async ({ crash, pid, report: reportPath, app, reason, at }) => {
      const when = at ? Date.parse(String(at)) : Number.NaN
      const reports = $crashes.get().length > 0 ? $crashes.get() : await loadCrashes()
      const known = findCrash(reports, crash ? String(crash) : pid !== undefined ? String(pid) : undefined)
      // A crash from before Veritas OS started (`herald-os crash diagnose <pid>`, or Hermes naming a report).
      const named =
        !known && (pid !== undefined || reportPath)
          ? {
              id: reportPath ? `ips:${String(reportPath)}` : `coredump:${String(pid)}`,
              app: app ? String(app) : reportPath ? String(reportPath).split('/').pop()?.replace(/[-_]\d{4}-.*$|\.ips$/g, '') || 'The program' : `Process ${String(pid)}`,
              pid: typeof pid === 'number' ? pid : undefined,
              reportPath: reportPath ? String(reportPath) : undefined,
              reason: reason ? String(reason) : undefined,
              at: Number.isFinite(when) ? when : Date.now(),
              source: reportPath ? ('macos' as const) : ('coredump' as const)
            }
          : undefined
      const report = known ?? named

      if (!report) {
        return fail(crash ? `No recent crash matches "${String(crash)}".` : 'Nothing has crashed since Veritas OS started.')
      }

      const sessionId = await diagnoseCrash(report)

      return ok(`Asked Hermes why ${report.app} crashed`, { page: 'hermes', data: { sessionId } })
    }
  },
  {
    id: 'crash.mute',
    title: 'Mute crash offers for a program',
    description: 'Stop (or resume) offering help when a particular program crashes.',
    tier: 'mutate',
    args: [
      { name: 'app', type: 'string', description: 'Program name', required: true },
      { name: 'muted', type: 'boolean', description: 'false to offer help again' }
    ],
    phrases: ['stop telling me when {app} crashes', 'mute crashes from {app}', { phrase: 'tell me again when {app} crashes', args: { muted: false } }],
    run: async ({ app, muted }) => {
      const name = String(app)
      const mute = muted !== false
      await setCrashMuted(name, mute)

      return ok(mute ? `Crashes from ${name} stay quiet now` : `Veritas OS offers help again when ${name} crashes`, { highlight: { kind: 'setting', id: 'notifications' } })
    }
  },
  {
    id: 'crash.help',
    title: 'Crash help',
    description: 'Turn the offer to diagnose crashes on or off.',
    tier: 'mutate',
    args: [{ name: 'enabled', type: 'boolean', description: 'true to offer help when programs crash', required: true }],
    phrases: [
      { phrase: 'turn on crash help', args: { enabled: true } },
      { phrase: 'turn off crash help', args: { enabled: false } },
      { phrase: 'stop telling me about crashes', args: { enabled: false } }
    ],
    run: async ({ enabled }) => {
      await setCrashHelpEnabled(Boolean(enabled))

      return ok(`Crash help ${enabled ? 'on' : 'off'}`, { highlight: { kind: 'setting', id: 'notifications' }, data: { muted: $prefs.get().crashHelp.muted } })
    }
  }
]
