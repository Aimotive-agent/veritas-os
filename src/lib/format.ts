const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '—'
  }

  let value = bytes
  let unit = 0

  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }

  return `${value.toFixed(unit === 0 ? 0 : digits)} ${UNITS[unit]}`
}

export function formatPercent(value: number, digits = 0): string {
  return `${value.toFixed(digits)}%`
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) {
    return '—'
  }

  if (seconds < 1) {
    return `${Math.round(seconds * 1000)} ms`
  }

  if (seconds < 60) {
    return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`
  }

  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) {
    return `${days}d ${hours % 24}h`
  }

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`
  }

  return `${minutes}m ${Math.round(seconds % 60)}s`
}

export function formatRelative(epochMsOrSeconds: number | undefined | null): string {
  if (!epochMsOrSeconds) {
    return ''
  }

  const ms = epochMsOrSeconds < 1e12 ? epochMsOrSeconds * 1000 : epochMsOrSeconds
  const delta = Date.now() - ms
  const minutes = Math.round(delta / 60_000)

  if (minutes < 1) {
    return 'just now'
  }

  if (minutes < 60) {
    return `${minutes}m ago`
  }

  const hours = Math.round(minutes / 60)

  if (hours < 24) {
    return `${hours}h ago`
  }

  const days = Math.round(hours / 24)

  if (days < 7) {
    return `${days}d ago`
  }

  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function formatClock(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function greetingFor(date: Date): string {
  const hour = date.getHours()

  if (hour < 5) {
    return 'Good night'
  }

  if (hour < 12) {
    return 'Good morning'
  }

  if (hour < 18) {
    return 'Good afternoon'
  }

  return 'Good evening'
}
