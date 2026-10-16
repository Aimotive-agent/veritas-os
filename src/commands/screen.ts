import { focusSettings } from '../features/settings/sections/shared.tsx'
import { formatDollars, formatTokens, planPercent } from '../lib/usage.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'
import { isPanels, openSurface } from '../store/shell.ts'
import { openAsk } from '../store/surface.ts'
import { loadUsage } from '../store/usage.ts'
import { showPage } from '../store/windows.ts'

/* What is on the screen (ask about part of it) and what Hermes has used. */

export const screenCommands: readonly OsCommand[] = [
  {
    id: 'screen.askRegion',
    title: 'Ask about part of the screen',
    description: 'Select part of the screen, then ask Hermes about it (the selection is attached as an image).',
    tier: 'act',
    args: [{ name: 'question', type: 'string', description: 'The question, if already known' }],
    phrases: ['ask about part of the screen', 'ask about this part of the screen', 'what is this on my screen'],
    run: async ({ question }, context) => {
      const file = await window.heraldOS.capture.region()

      if (!file) {
        return fail('Nothing was selected.')
      }

      // Hermes asked for the picture itself: hand it the file instead of opening a prompt for the person.
      if (context.source === 'agent') {
        return ok(`Captured the selection as ${file}`, { data: { file } })
      }

      const text = question ? String(question) : ''

      if (isPanels) {
        openSurface('command', { type: 'ask', text, attachments: [file] })
      } else {
        openAsk({ text, attachments: [file] })
      }

      return ok('Selection captured; ask your question', { spoken: 'Got it. What would you like to know?', data: { file } })
    }
  },
  {
    id: 'usage.show',
    title: 'Show usage',
    description: "Show how much Hermes has used this week and what is left on the model plan (Settings > Usage).",
    tier: 'read',
    args: [],
    phrases: ['how much have i used', 'show my usage', 'how many tokens have i used', 'how much of my plan is left'],
    run: async () => {
      const usage = await loadUsage()
      showPage('settings')
      focusSettings({ section: 'usage' })
      const pct = planPercent(usage.plan)
      const week = usage.week
      const parts = [
        week ? `this week ${formatTokens(week.tokens)} tokens over ${week.sessions} session${week.sessions === 1 ? '' : 's'}${week.cost > 0 ? ` (about ${formatDollars(week.cost)})` : ''}` : null,
        pct !== null ? `${Math.round(pct)}% of your ${usage.plan?.plan_name ?? 'plan'} used` : null
      ].filter(Boolean)

      return ok(parts.length ? `Usage: ${parts.join('; ')}` : 'Opened usage', { page: 'settings', highlight: { kind: 'setting', id: 'usage' }, data: { planPercent: pct, week, month: usage.month } })
    }
  }
]
