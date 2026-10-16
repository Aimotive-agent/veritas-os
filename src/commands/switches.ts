import type { SwitchName } from '../../shared/ipc.ts'
import { $prefs, updatePrefs } from '../store/backend.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'
import { $switches, setSwitch, SWITCH_LABELS } from '../store/switches.ts'

/* Quick switches: do not disturb, staying awake, night light, the screensaver, idle timings. */

const switchCommand = (id: string, name: SwitchName, description: string, on: string[], off: string[]): OsCommand => ({
  id,
  title: SWITCH_LABELS[name],
  description,
  tier: 'act',
  args: [{ name: 'enabled', type: 'boolean', description: 'true to turn it on, false to turn it off; leave it out to flip it' }],
  phrases: [...on.map(phrase => ({ phrase, args: { enabled: true } })), ...off.map(phrase => ({ phrase, args: { enabled: false } }))],
  run: async ({ enabled }) => {
    const state = await setSwitch(name, enabled === undefined ? !$switches.get()[name] : Boolean(enabled))

    return ok(`${SWITCH_LABELS[name]} ${state[name] ? 'on' : 'off'}`, { data: { ...state } })
  }
})

export const switchCommands: readonly OsCommand[] = [
  switchCommand('dnd.set', 'doNotDisturb', 'Do not disturb: notifications collect in the bell without popping up, sounding or being read aloud.', ['turn on do not disturb', "don't disturb me", 'focus mode on'], ['turn off do not disturb', 'focus mode off']),
  switchCommand('awake.set', 'stayAwake', 'Keep the computer awake: the screens stay on and nothing locks or sleeps on its own.', ['stay awake', 'keep the screen on', "don't let the computer sleep"], ['let the computer sleep', 'stop staying awake']),
  switchCommand('nightlight.set', 'nightLight', 'Night light (Veritas OS Linux): warmer colours that are easier on the eyes in the evening.', ['turn on night light', 'make the screen warmer'], ['turn off night light']),
  switchCommand('screensaver.set', 'screensaver', 'The screensaver after a few idle minutes: the living wallpaper and a large clock.', ['turn on the screensaver'], ['turn off the screensaver']),
  {
    id: 'switches.status',
    title: 'Switch status',
    description: 'Which quick switches are on: do not disturb, staying awake, night light, the screensaver.',
    tier: 'read',
    args: [],
    run: async () => {
      const state = await window.heraldOS.switches.get()
      $switches.set(state)
      const on = (Object.keys(SWITCH_LABELS) as SwitchName[]).filter(name => state[name])

      return ok(on.length ? `On: ${on.map(name => SWITCH_LABELS[name].toLowerCase()).join(', ')}` : 'Every switch is off', { data: { ...state } })
    }
  },
  {
    id: 'idle.set',
    title: 'When to lock and sleep',
    description: 'Veritas OS Linux: minutes without input before locking (lock), turning the screens off (screenOff) and sleeping (suspend; 0 = never).',
    tier: 'mutate',
    args: [
      { name: 'lock', type: 'number', description: 'Minutes before locking' },
      { name: 'screenOff', type: 'number', description: 'Minutes before the screens turn off' },
      { name: 'suspend', type: 'number', description: 'Minutes before sleeping, 0 for never' }
    ],
    run: async ({ lock, screenOff, suspend }) => {
      if (lock === undefined && screenOff === undefined && suspend === undefined) {
        return fail('Say which timing to change: lock, screenOff or suspend (minutes).')
      }

      const current = { lockAfter: 10, screenOffAfter: 15, suspendAfter: 0, ...$prefs.get().idle }
      const next = {
        lockAfter: lock === undefined ? current.lockAfter : Math.max(1, Number(lock)),
        screenOffAfter: screenOff === undefined ? current.screenOffAfter : Math.max(1, Number(screenOff)),
        suspendAfter: suspend === undefined ? current.suspendAfter : Math.max(0, Number(suspend))
      }
      await updatePrefs({ idle: next })

      return ok(`Locks after ${next.lockAfter} min, screens off after ${next.screenOffAfter} min, ${next.suspendAfter ? `sleeps after ${next.suspendAfter} min` : 'never sleeps on its own'}`, { highlight: { kind: 'setting', id: 'general' } })
    }
  }
]
