/*
 * The menu bar's right-hand items: which show, in what order, and how the clock reads. Shared by
 * main (which keeps the preference tidy), the bar, Settings and the commands; pure and tested.
 */

export const MENU_BAR_ITEMS = ['search', 'widgets', 'voice', 'indicators', 'usage', 'wifi', 'bluetooth', 'sound', 'battery', 'notifications', 'clock'] as const

export type MenuBarItem = (typeof MENU_BAR_ITEMS)[number]

export const MENU_BAR_LABELS: Record<MenuBarItem, string> = {
  search: 'Search',
  widgets: 'Widgets',
  voice: 'Voice',
  indicators: 'Status lights',
  usage: 'Plan usage',
  wifi: 'Wi-Fi',
  bluetooth: 'Bluetooth',
  sound: 'Sound',
  battery: 'Battery',
  notifications: 'Notifications',
  clock: 'Clock'
}

/** Always shown: they say the screen is being recorded or the microphone is typing for you. */
export const PINNED_ITEMS: readonly MenuBarItem[] = ['indicators']

const ALIASES: Record<string, MenuBarItem> = {
  'wi-fi': 'wifi',
  network: 'wifi',
  volume: 'sound',
  audio: 'sound',
  bell: 'notifications',
  time: 'clock',
  date: 'clock',
  mic: 'voice',
  lights: 'indicators',
  status: 'indicators',
  plan: 'usage'
}

export interface MenuBarClock {
  /** `system` follows the language and region settings. */
  hours: 'system' | '12' | '24'
  seconds: boolean
  date: 'short' | 'long' | 'none'
}

export interface MenuBarLayout {
  order: MenuBarItem[]
  /** Never holds pinned items or `usage`, whose switch is `usageInMenuBar`. */
  hidden: MenuBarItem[]
  clock: MenuBarClock
}

export const DEFAULT_CLOCK: MenuBarClock = { hours: 'system', seconds: false, date: 'short' }

const isItem = (value: unknown): value is MenuBarItem => typeof value === 'string' && (MENU_BAR_ITEMS as readonly string[]).includes(value)

/** An item from its id, its label or a common word for it ("volume", "time"), or null. */
export function resolveMenuBarItem(name: string): MenuBarItem | null {
  const needle = name.trim().toLowerCase()

  if (isItem(needle)) {
    return needle
  }

  return ALIASES[needle] ?? MENU_BAR_ITEMS.find(item => MENU_BAR_LABELS[item].toLowerCase() === needle) ?? null
}

/**
 * A stored layout made whole: unknown ids dropped, duplicates removed, and items it does not
 * mention (new ones in a later release) put back beside their default neighbours.
 */
export function normalizeMenuBar(value: unknown): MenuBarLayout {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const order: MenuBarItem[] = []

  for (const item of Array.isArray(raw.order) ? raw.order : []) {
    if (isItem(item) && !order.includes(item)) {
      order.push(item)
    }
  }

  MENU_BAR_ITEMS.forEach((item, index) => {
    if (!order.includes(item)) {
      const before = MENU_BAR_ITEMS.slice(0, index).filter(other => order.includes(other))
      const anchor = before.length ? order.indexOf(before[before.length - 1]) + 1 : 0
      order.splice(anchor, 0, item)
    }
  })

  const hidden = [...new Set((Array.isArray(raw.hidden) ? raw.hidden : []).filter(isItem))].filter(item => !PINNED_ITEMS.includes(item) && item !== 'usage')
  const clock = raw.clock && typeof raw.clock === 'object' ? (raw.clock as Record<string, unknown>) : {}

  return {
    order,
    hidden,
    clock: {
      hours: clock.hours === '12' || clock.hours === '24' ? clock.hours : 'system',
      seconds: clock.seconds === true,
      date: clock.date === 'long' || clock.date === 'none' ? clock.date : 'short'
    }
  }
}

/** The items to draw, in order. */
export function visibleMenuBarItems(layout: MenuBarLayout): MenuBarItem[] {
  return layout.order.filter(item => !layout.hidden.includes(item))
}

/** `order` with `item` moved to `index` (clamped). */
export function moveMenuBarItem(order: readonly MenuBarItem[], item: MenuBarItem, index: number): MenuBarItem[] {
  const rest = order.filter(other => other !== item)
  const at = Math.max(0, Math.min(rest.length, Math.round(index)))

  return [...rest.slice(0, at), item, ...rest.slice(at)]
}

/** The clock's date and time text. */
export function clockText(now: Date, clock: MenuBarClock, locale?: string): { date: string | null; time: string } {
  const hourCycle = clock.hours === '12' ? 'h12' : clock.hours === '24' ? 'h23' : undefined
  const time = now.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', ...(clock.seconds ? { second: '2-digit' } : {}), ...(hourCycle ? { hourCycle } : {}) })
  const date =
    clock.date === 'none'
      ? null
      : now.toLocaleDateString(locale, clock.date === 'long' ? { weekday: 'long', day: 'numeric', month: 'long' } : { weekday: 'short', day: 'numeric', month: 'short' })

  return { date, time }
}
