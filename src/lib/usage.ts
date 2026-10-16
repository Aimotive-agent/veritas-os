import type { UsageModel } from '@herald-os/client'

/** The parts of `GET /api/analytics/usage` Veritas OS shows (Hermes's own token accounting per session). */
export interface AnalyticsResponse {
  daily?: { day?: string; input_tokens?: number | null; output_tokens?: number | null; sessions?: number | null; estimated_cost?: number | null }[]
  by_model?: { model?: string | null; input_tokens?: number | null; output_tokens?: number | null; sessions?: number | null }[]
  totals?: { total_input?: number | null; total_output?: number | null; total_estimated_cost?: number | null; total_actual_cost?: number | null; total_sessions?: number | null }
  period_days?: number
}

export interface UsageSummary {
  days: number
  tokens: number
  input: number
  output: number
  sessions: number
  /** Dollars: the provider's actual figure when it reports one, else Hermes's estimate. */
  cost: number
  topModel: string | null
  daily: { day: string; tokens: number }[]
}

const n = (value: number | null | undefined) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

export function summariseUsage(raw: AnalyticsResponse, days: number): UsageSummary {
  const totals = raw.totals ?? {}
  const input = n(totals.total_input)
  const output = n(totals.total_output)
  const top = [...(raw.by_model ?? [])].filter(row => row.model).sort((a, b) => n(b.input_tokens) + n(b.output_tokens) - (n(a.input_tokens) + n(a.output_tokens)))[0]

  return {
    days: raw.period_days ?? days,
    tokens: input + output,
    input,
    output,
    sessions: n(totals.total_sessions),
    cost: n(totals.total_actual_cost) || n(totals.total_estimated_cost),
    topModel: top?.model ?? null,
    daily: (raw.daily ?? []).filter(row => row.day).map(row => ({ day: String(row.day), tokens: n(row.input_tokens) + n(row.output_tokens) }))
  }
}

/** 1234 -> "1.2k", 3_400_000 -> "3.4M". */
export function formatTokens(value: number): string {
  if (value < 1000) {
    return String(Math.round(value))
  }

  const [scale, unit] = value >= 1_000_000_000 ? [1_000_000_000, 'B'] : value >= 1_000_000 ? [1_000_000, 'M'] : [1000, 'k']
  const scaled = value / scale

  return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, '')}${unit}`
}

export function formatDollars(value: number): string {
  return value >= 100 ? `$${Math.round(value)}` : `$${value.toFixed(2)}`
}

/** Percent of the plan used, when the plan reports one. */
export function planPercent(plan: UsageModel | null | undefined): number | null {
  const pct = plan?.available ? plan.plan_bar?.pct_used : null

  return typeof pct === 'number' && Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : null
}

/** A plan past `threshold`% that has not been mentioned in this billing period yet: the key to remember, else null. */
export function limitAlertKey(plan: UsageModel | null | undefined, threshold: number, lastKey: string | null): string | null {
  const pct = planPercent(plan)

  if (pct === null || pct < threshold) {
    return null
  }

  const key = `${plan?.renews_at ?? plan?.plan_name ?? 'plan'}:${threshold}`

  return key === lastKey ? null : key
}
