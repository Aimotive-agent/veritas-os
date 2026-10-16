import { hostPlatform } from '../lib/platform-labels.ts'
import { $prefs, updatePrefs } from '../store/backend.ts'
import { $dictation, toggleDictation } from '../store/dictation.ts'
import { openEmojiPicker } from '../store/emoji.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'
import { isMainSurface, relayToMain } from '../store/shell.ts'

/* Typing helpers that work in every app: dictation, the emoji picker and the keyboard layout. */

export const typingCommands: readonly OsCommand[] = [
  {
    id: 'dictation.toggle',
    title: 'Dictate',
    description: 'Start dictation (or finish it): what you say next is typed into the focused app, with spoken punctuation. It ends by itself after a pause.',
    tier: 'act',
    args: [],
    phrases: ['start dictation', 'dictate into this app', 'stop dictation'],
    run: async () => {
      if (!isMainSurface) {
        relayToMain({ type: 'dictate' })

        return ok('Dictation toggled')
      }

      const wasListening = $dictation.get().phase === 'listening'
      toggleDictation()

      return ok(wasListening ? 'Finishing dictation' : 'Listening: speak, then pause to type it')
    }
  },
  {
    id: 'emoji.pick',
    title: 'Emoji',
    description: 'Open the emoji picker; the pick is typed into the field you were in.',
    tier: 'act',
    args: [],
    phrases: ['emoji', 'insert an emoji', 'open the emoji picker'],
    run: async () => {
      openEmojiPicker()

      return ok('Emoji picker open')
    }
  },
  {
    id: 'keymap.set',
    title: 'Keyboard layout',
    description: "Veritas OS Linux: Veritas's keys, or the Omarchy keymap where Super+C, X and V copy, cut and paste in every app (voice moves to Super+Shift+V).",
    tier: 'mutate',
    args: [{ name: 'keymap', type: 'string', description: 'herald or omarchy', required: true, enum: ['herald', 'omarchy'] }],
    phrases: [
      { phrase: 'use the omarchy keymap', args: { keymap: 'omarchy' } },
      { phrase: 'use the herald keymap', args: { keymap: 'herald' } }
    ],
    run: async ({ keymap }) => {
      if (hostPlatform() !== 'linux') {
        return fail('The keymap applies to Veritas OS Linux; macOS keeps its own shortcuts.')
      }

      const next = keymap === 'omarchy' ? 'omarchy' : 'herald'

      if (($prefs.get().keymap ?? 'herald') !== next) {
        await updatePrefs({ keymap: next })
      }

      return ok(next === 'omarchy' ? 'Omarchy keymap: Super+C, X and V copy, cut and paste; voice is Super+Shift+V' : "Veritas's keymap is back", { highlight: { kind: 'setting', id: 'general' } })
    }
  }
]
