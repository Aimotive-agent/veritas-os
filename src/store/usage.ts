import type { BillingStateResult, UsageModel } from '@herald-os/client'
import { atom } from 'nanostores'
import { type AnalyticsResponse, limitAlertKey, planPercent, summariseUsage, type UsageSummary } from '../lib/usage.ts'
import { rest } from '../lib/rest.ts'
import { $connectionEpoch, gatewayRequest } from './gateway.ts'
import { notify } from './notifications.ts'
import { isMainSurface } from './shell.ts'

export interface UsageSnapshot {
  /** The model provider's plan and top-up bars (Nous Portal); unavailable for other providers. */
  plan: UsageModel | null
  billing: BillingStateResult | null
  week: UsageSummary | null
  month: UsageSummary | null
  loadedAt: number
}

export const $usage = atom<UsageSnapshot | null>(null)

async function analytics(days: number): Promise<UsageSummary | null> {
  try {
    return summariseUsage(await rest.get<AnalyticsResponse>('/api/analytics/usage', { days }), days)
  } catch {
    return null
  }
}

export async function loadUsage(): Promise<UsageSnapshot> {
  const [plan, billing, week, month] = await Promise.all([
    gatewayRequest('usage.bars', {}).catch(() => null),
    gatewayRequest('billing.state', {}).catch(() => null),
    analytics(7),
    analytics(30)
  ])
  const snapshot: UsageSnapshot = { plan, billing, week, month, loadedAt: Date.now() }
  $usage.set(snapshot)

  return snapshot
}

const ALERT_AT = 90
const ALERT_KEY = 'herald-os.usage.alerted'
const CHECK_MS = 15 * 60_000

/** One notification per billing period once the plan passes 90%; it offers, it never stops anything. */
async function checkLimit(): Promise<void> {
  const { plan } = await loadUsage()
  let last: string | null = null

  try {
    last = localStorage.getItem(ALERT_KEY)
  } catch {
    // Without storage the alert may repeat after a reload; that is acceptable.
  }

  const key = limitAlertKey(plan, ALERT_AT, last)

  if (!key) {
    return
  }

  try {
    localStorage.setItem(ALERT_KEY, key)
  } catch {
    // See above.
  }

  notify({
    title: `${Math.round(planPercent(plan) ?? ALERT_AT)}% of your ${plan?.plan_name ?? 'plan'} is used`,
    body: plan?.renews_display ? `It renews ${plan.renews_display}.` : 'Top up, or switch models for lighter work.',
    level: 'warn',
    key: 'usage-limit',
    native: true,
    actions: [{ label: 'See usage', command: 'usage.show' }]
  })
}

let bound = false

export function bindUsage(): () => void {
  if (bound || !isMainSurface) {
    return () => undefined
  }

  bound = true
  const run = () => void checkLimit().catch(() => undefined)
  const timer = setInterval(run, CHECK_MS)
  let first: ReturnType<typeof setTimeout> | null = null
  const offEpoch = $connectionEpoch.subscribe(epoch => {
    if (epoch > 0) {
      // Give the gateway a moment after (re)connecting before asking about billing.
      if (first) {
        clearTimeout(first)
      }

      first = setTimeout(run, 20_000)
    }
  })

  return () => {
    clearInterval(timer)
    offEpoch()
    bound = false
  }
}
