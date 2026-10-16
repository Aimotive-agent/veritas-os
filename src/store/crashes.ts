import { atom } from 'nanostores'
import type { CrashReport } from '../../shared/ipc.ts'
import { crashPrompt, crashTitle } from '../lib/crash.ts'
import { $prefs, updatePrefs } from './backend.ts'
import { createChat, sendPrompt } from './chat.ts'
import { notify } from './notifications.ts'
import { showPage } from './windows.ts'

/** Crashes seen since Veritas OS started, newest first (main keeps the list; this caches it). */
export const $crashes = atom<CrashReport[]>([])

export async function loadCrashes(): Promise<CrashReport[]> {
  const reports = (await window.heraldOS.crash?.recent().catch(() => [])) ?? []
  $crashes.set(reports)

  return reports
}

/** Main saw a crash worth mentioning: offer help, never open anything by itself. */
export function offerCrashHelp(report: CrashReport): void {
  $crashes.set([report, ...$crashes.get().filter(entry => entry.id !== report.id)].slice(0, 20))
  notify({
    title: crashTitle(report),
    body: 'Hermes can read the crash report and tell you what happened.',
    level: 'warn',
    key: `crash:${report.app.toLowerCase()}`,
    native: true,
    actions: [
      { label: 'Ask Hermes', command: 'crash.diagnose', args: { crash: report.id } },
      { label: `Mute ${report.app}`, command: 'crash.mute', args: { app: report.app } }
    ]
  })
}

/** Start a chat that hands the crash to Hermes with the diagnose-crash skill. */
export async function diagnoseCrash(report: CrashReport): Promise<string | null> {
  const chat = await createChat({ title: `Why ${report.app} crashed` })
  showPage('hermes')

  return sendPrompt(crashPrompt(report), { sessionId: chat.sessionId })
}

export async function setCrashMuted(app: string, muted: boolean): Promise<string[]> {
  const current = $prefs.get().crashHelp
  const others = current.muted.filter(entry => entry.toLowerCase() !== app.toLowerCase())
  const next = muted ? [...others, app] : others
  await updatePrefs({ crashHelp: { ...current, muted: next } })

  return next
}

export async function setCrashHelpEnabled(enabled: boolean): Promise<void> {
  await updatePrefs({ crashHelp: { ...$prefs.get().crashHelp, enabled } })
}
