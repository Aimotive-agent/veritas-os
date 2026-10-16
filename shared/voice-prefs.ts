// Voice preference defaults, shared by Electron main (prefs.json) and the renderer ($prefs seed)
// so a partially written `voice` object always resolves to a complete one.
import type { VoicePrefs } from './ipc.ts'

export const DEFAULT_VOICE_HOTKEY = 'Alt+Space'

export const VOICE_DEFAULTS: VoicePrefs = {
  enabled: false,
  engine: 'chained',
  wakeWord: false,
  hotkey: DEFAULT_VOICE_HOTKEY,
  followUpSeconds: 8,
  announceNotifications: false,
  followHermes: false,
  sttTuned: false,
  liveIdleSeconds: 45,
  liveDailyCapMinutes: 60,
  liveUsage: { day: '', seconds: 0 }
}

/** Merge a possibly partial or malformed stored value onto the defaults. */
export function normalizeVoicePrefs(raw: unknown): VoicePrefs {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Partial<VoicePrefs>
  const usage = source.liveUsage && typeof source.liveUsage === 'object' ? source.liveUsage : VOICE_DEFAULTS.liveUsage

  return {
    ...VOICE_DEFAULTS,
    ...source,
    engine: source.engine === 'live' ? 'live' : 'chained',
    hotkey: typeof source.hotkey === 'string' ? source.hotkey : VOICE_DEFAULTS.hotkey,
    followUpSeconds: clampNumber(source.followUpSeconds, 0, 120, VOICE_DEFAULTS.followUpSeconds),
    liveIdleSeconds: clampNumber(source.liveIdleSeconds, 10, 600, VOICE_DEFAULTS.liveIdleSeconds),
    liveDailyCapMinutes: clampNumber(source.liveDailyCapMinutes, 0, 24 * 60, VOICE_DEFAULTS.liveDailyCapMinutes),
    liveUsage: { day: typeof usage.day === 'string' ? usage.day : '', seconds: clampNumber(usage.seconds, 0, Number.MAX_SAFE_INTEGER, 0) }
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}
