import type { CronJob } from '../../lib/rest.ts'

/*
 * Turns the cron backend's schedule shapes into the short human lines the Automations page shows:
 * 'Weekdays at 8:00', 'Fridays at 16:00', 'Every evening at 18:00', 'Every 6 hours', 'Once on Sep 21 at 09:00'.
 * Everything falls back to the backend's own `schedule_display` when an expression is too exotic.
 */

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const NAMED_DOW: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

const pad = (n: number): string => String(n).padStart(2, '0')

/** '8:00', '16:05' (24-hour, no leading zero on the hour, like the mockups). */
export function formatClockShort(hour: number, minute: number): string {
  return `${hour}:${pad(minute)}`
}

export function formatTimeOfDay(date: Date): string {
  return formatClockShort(date.getHours(), date.getMinutes())
}

/** Epoch millis from the ISO strings / epoch numbers the cron API mixes. */
export function toMs(value: string | number | null | undefined): number | undefined {
  if (value == null || value === '') {
    return undefined
  }

  if (typeof value === 'number') {
    return value < 1e12 ? value * 1000 : value
  }

  const parsed = Date.parse(value)

  return Number.isNaN(parsed) ? undefined : parsed
}

const ordinal = (n: number): string => {
  const rem10 = n % 10
  const rem100 = n % 100

  if (rem10 === 1 && rem100 !== 11) {
    return `${n}st`
  }

  if (rem10 === 2 && rem100 !== 12) {
    return `${n}nd`
  }

  if (rem10 === 3 && rem100 !== 13) {
    return `${n}rd`
  }

  return `${n}th`
}

/** Expand a cron day-of-week field ('1-5', 'MON,WED', '0,6', '7') into sorted day numbers, or undefined when not simple. */
function expandDow(field: string): number[] | undefined {
  const days = new Set<number>()

  for (const part of field.toLowerCase().split(',')) {
    const range = part.split('-')

    if (range.length > 2 || part.includes('/')) {
      return undefined
    }

    const bounds = range.map(token => {
      if (/^\d+$/.test(token)) {
        return Number(token) % 7
      }

      return NAMED_DOW[token.slice(0, 3)]
    })

    if (bounds.some(b => b === undefined || Number.isNaN(b))) {
      return undefined
    }

    const [start, end = start] = bounds as number[]

    if (start <= end) {
      for (let d = start; d <= end; d++) {
        days.add(d)
      }
    } else {
      for (let d = start; d <= 6; d++) {
        days.add(d)
      }

      for (let d = 0; d <= end; d++) {
        days.add(d)
      }
    }
  }

  return [...days].sort((a, b) => a - b)
}

const sameSet = (a: number[], b: number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i])

function dailyPrefix(hour: number): string {
  if (hour >= 5 && hour < 12) {
    return 'Every morning'
  }

  if (hour >= 12 && hour < 17) {
    return 'Every afternoon'
  }

  if (hour >= 17 && hour < 22) {
    return 'Every evening'
  }

  return 'Every day'
}

function humanizeInterval(minutes: number): string {
  if (minutes % 1440 === 0) {
    const days = minutes / 1440

    return days === 1 ? 'Every day' : `Every ${days} days`
  }

  if (minutes % 60 === 0) {
    const hours = minutes / 60

    return hours === 1 ? 'Every hour' : `Every ${hours} hours`
  }

  return minutes === 1 ? 'Every minute' : `Every ${minutes} minutes`
}

/** Humanize a 5+ field cron expression, or undefined when it is not one of the simple shapes. */
export function humanizeCronExpr(expr: string): string | undefined {
  const parts = expr.trim().split(/\s+/)

  if (parts.length < 5) {
    return undefined
  }

  const [minuteField, hourField, domField, monthField, dowField] = parts

  if (monthField !== '*') {
    return undefined
  }

  // Sub-daily cadences: '*/15 * * * *', '0 * * * *', '0 */6 * * *'.
  if (hourField === '*' && domField === '*' && dowField === '*') {
    if (minuteField === '*') {
      return 'Every minute'
    }

    const step = /^\*\/(\d+)$/.exec(minuteField)

    if (step) {
      return humanizeInterval(Number(step[1]))
    }

    if (/^\d+$/.test(minuteField)) {
      return Number(minuteField) === 0 ? 'Every hour' : `Every hour at :${pad(Number(minuteField))}`
    }

    return undefined
  }

  const hourStep = /^\*\/(\d+)$/.exec(hourField)

  if (hourStep && domField === '*' && dowField === '*' && /^\d+$/.test(minuteField)) {
    return humanizeInterval(Number(hourStep[1]) * 60)
  }

  if (!/^\d+$/.test(minuteField) || !/^\d+$/.test(hourField)) {
    return undefined
  }

  const time = formatClockShort(Number(hourField), Number(minuteField))

  // Monthly: '0 9 1 * *'.
  if (domField !== '*' && dowField === '*') {
    if (/^\d+$/.test(domField)) {
      return `Monthly on the ${ordinal(Number(domField))} at ${time}`
    }

    return undefined
  }

  if (domField !== '*') {
    return undefined
  }

  if (dowField === '*') {
    return `${dailyPrefix(Number(hourField))} at ${time}`
  }

  const days = expandDow(dowField)

  if (!days || days.length === 0) {
    return undefined
  }

  if (sameSet(days, [1, 2, 3, 4, 5])) {
    return `Weekdays at ${time}`
  }

  if (sameSet(days, [0, 6])) {
    return `Weekends at ${time}`
  }

  if (days.length === 7) {
    return `${dailyPrefix(Number(hourField))} at ${time}`
  }

  const names = days.map(d => `${DAY_NAMES[d]}s`)
  const list = names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

  return `${list} at ${time}`
}

/** 'Once on Sep 21 at 09:00' (adds the year when it is not this year). */
export function humanizeOnce(runAt: string | number): string | undefined {
  const ms = toMs(runAt)

  if (ms === undefined) {
    return undefined
  }

  const date = new Date(ms)
  const year = date.getFullYear() === new Date().getFullYear() ? '' : `, ${date.getFullYear()}`

  return `Once on ${MONTH_SHORT[date.getMonth()]} ${date.getDate()}${year} at ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** The card's schedule line. Falls back to the backend's display text. */
export function humanizeSchedule(job: Pick<CronJob, 'schedule' | 'schedule_display'>): string {
  const schedule = job.schedule ?? {}
  const fallback = job.schedule_display ?? schedule.display ?? schedule.expr ?? ''
  const kind = schedule.kind ?? (schedule.expr ? 'cron' : schedule.minutes != null ? 'interval' : schedule.run_at ? 'once' : undefined)

  if (kind === 'interval' && typeof schedule.minutes === 'number' && schedule.minutes > 0) {
    return humanizeInterval(schedule.minutes)
  }

  if (kind === 'once' && schedule.run_at) {
    return humanizeOnce(schedule.run_at) ?? fallback
  }

  if (kind === 'cron' && schedule.expr) {
    return humanizeCronExpr(schedule.expr) ?? (fallback && !/^[\d*\/,\-\s]+$/.test(fallback) ? capitalize(fallback) : schedule.expr)
  }

  return capitalize(fallback)
}

/** The schedule string the cron REST accepts, reconstructed from a stored job (for Duplicate / edit prefill). */
export function scheduleToString(job: Pick<CronJob, 'schedule' | 'schedule_display'>): string {
  const schedule = job.schedule ?? {}

  if (schedule.kind === 'cron' && schedule.expr) {
    return schedule.expr
  }

  if (schedule.kind === 'interval' && typeof schedule.minutes === 'number') {
    const minutes = schedule.minutes

    if (minutes > 0 && minutes % 1440 === 0) {
      return `every ${minutes / 1440}d`
    }

    if (minutes > 0 && minutes % 60 === 0) {
      return `every ${minutes / 60}h`
    }

    return `every ${minutes}m`
  }

  if (schedule.kind === 'once' && schedule.run_at) {
    const ms = toMs(schedule.run_at)

    if (ms !== undefined) {
      const d = new Date(ms)

      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
    }
  }

  return job.schedule_display ?? schedule.display ?? schedule.expr ?? ''
}

const startOfDay = (date: Date): number => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()

/** 'Today, 8:00' / 'Tomorrow, 8:00' / 'Monday, 8:00' / 'Sep 21, 9:00'. */
export function formatRunMoment(ms: number, now: Date = new Date()): string {
  const date = new Date(ms)
  const dayDelta = Math.round((startOfDay(date) - startOfDay(now)) / 86_400_000)
  const time = formatTimeOfDay(date)

  if (dayDelta === 0) {
    return `Today, ${time}`
  }

  if (dayDelta === 1) {
    return `Tomorrow, ${time}`
  }

  if (dayDelta === -1) {
    return `Yesterday, ${time}`
  }

  if (dayDelta > 1 && dayDelta < 7) {
    return `${DAY_NAMES[date.getDay()]}, ${time}`
  }

  const year = date.getFullYear() === now.getFullYear() ? '' : `, ${date.getFullYear()}`

  return `${MONTH_SHORT[date.getMonth()]} ${date.getDate()}${year}, ${time}`
}

/** The third card line: 'Next run: Monday, 8:00', or 'Paused' / 'Completed' when there is no next run. */
export function formatNextRun(job: Pick<CronJob, 'next_run_at' | 'state' | 'enabled'>): string {
  if (job.state === 'paused' || job.enabled === false) {
    return 'Paused'
  }

  if (job.state === 'completed') {
    return 'Completed'
  }

  if (job.state === 'error') {
    return 'Needs attention'
  }

  const ms = toMs(job.next_run_at)

  return ms === undefined ? 'Not scheduled' : `Next run: ${formatRunMoment(ms)}`
}

/** 'Sep 17, 2024 8:00' for run history rows. */
export function formatRunTimestamp(ms: number): string {
  const date = new Date(ms)

  return `${MONTH_SHORT[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()} ${formatTimeOfDay(date)}`
}

/** '42 seconds', '1 minute 12 seconds', '2 hours 5 minutes'. */
export function formatRunDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))

  if (total < 60) {
    return `${total} second${total === 1 ? '' : 's'}`
  }

  const minutes = Math.floor(total / 60)
  const rest = total % 60

  if (minutes < 60) {
    const m = `${minutes} minute${minutes === 1 ? '' : 's'}`

    return rest ? `${m} ${rest} second${rest === 1 ? '' : 's'}` : m
  }

  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  const h = `${hours} hour${hours === 1 ? '' : 's'}`

  return restMinutes ? `${h} ${restMinutes} minute${restMinutes === 1 ? '' : 's'}` : h
}

/** 'Sydney' from 'Australia/Sydney'; 'UTC' when the zone is unknown. */
export function localTimezoneCity(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
    const city = zone.split('/').pop() ?? zone

    return city.replace(/_/g, ' ')
  } catch {
    return 'UTC'
  }
}

/** Formats the backend accepts, shown as helper text next to schedule inputs. */
export const SCHEDULE_FORMATS_HINT = "'every 30m', 'every 6h', 'weekdays at 8:00', 'every monday 9am', 'daily at 7am', a cron expression ('0 9 * * 1-5') or a timestamp ('2026-02-03T14:00')"

export const SCHEDULE_PLACEHOLDER = 'weekdays at 8:00 · every 6h · 0 9 * * 1-5'

function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text
}
