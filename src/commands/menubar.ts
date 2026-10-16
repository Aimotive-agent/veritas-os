import { MENU_BAR_ITEMS, MENU_BAR_LABELS, type MenuBarItem, moveMenuBarItem, normalizeMenuBar, PINNED_ITEMS, resolveMenuBarItem } from '../../shared/menu-bar.ts'
import { $prefs, updatePrefs } from '../store/backend.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'

/* The menu bar's items and clock: the commands behind Settings > Appearance > Menu bar and `herald-os bar`. */

const layout = () => normalizeMenuBar($prefs.get().menuBar)
const shown = (item: MenuBarItem) => (item === 'usage' ? Boolean($prefs.get().usageInMenuBar) : !layout().hidden.includes(item))
const ITEM_NAMES = MENU_BAR_ITEMS.join(', ')

function describe() {
  const current = layout()

  return {
    items: current.order.map(item => ({ id: item, label: MENU_BAR_LABELS[item], shown: shown(item), pinned: PINNED_ITEMS.includes(item) })),
    clock: current.clock
  }
}

function itemArg(name: unknown): MenuBarItem | string {
  return resolveMenuBarItem(String(name ?? '')) ?? `No menu bar item "${String(name ?? '')}". Items: ${ITEM_NAMES}.`
}

async function setShown(name: unknown, visible: boolean) {
  const item = itemArg(name)

  if (!(MENU_BAR_ITEMS as readonly string[]).includes(item)) {
    return fail(item)
  }

  const id = item as MenuBarItem

  if (!visible && PINNED_ITEMS.includes(id)) {
    return fail('The status lights always show: they say when the screen is being recorded or dictation is typing.')
  }

  if (id === 'usage') {
    await updatePrefs({ usageInMenuBar: visible })
  } else {
    const hidden = layout().hidden.filter(other => other !== id)
    await updatePrefs({ menuBar: { ...layout(), hidden: visible ? hidden : [...hidden, id] } })
  }

  return ok(`${visible ? 'Showing' : 'Hid'} ${MENU_BAR_LABELS[id]} in the menu bar`, { highlight: { kind: 'setting', id: 'appearance' } })
}

export const menuBarCommands: readonly OsCommand[] = [
  {
    id: 'bar.layout',
    title: 'Menu bar items',
    description: 'The menu bar items in order (left to right), which are shown, and the clock format.',
    tier: 'read',
    args: [],
    run: () => {
      const data = describe()

      return ok(
        data.items
          .filter(item => item.shown)
          .map(item => item.label)
          .join(', '),
        { data }
      )
    }
  },
  {
    id: 'bar.show',
    title: 'Show a menu bar item',
    description: `Show an item in the menu bar: ${ITEM_NAMES}.`,
    tier: 'act',
    args: [{ name: 'item', type: 'string', description: 'The item, e.g. battery, bluetooth, clock', required: true }],
    phrases: ['show {item} in the menu bar'],
    run: ({ item }) => setShown(item, true)
  },
  {
    id: 'bar.hide',
    title: 'Hide a menu bar item',
    description: `Hide an item from the menu bar: ${ITEM_NAMES} (the status lights always show).`,
    tier: 'act',
    args: [{ name: 'item', type: 'string', description: 'The item, e.g. bluetooth, search, battery', required: true }],
    phrases: ['hide {item} from the menu bar', 'hide {item} in the menu bar'],
    run: ({ item }) => setShown(item, false)
  },
  {
    id: 'bar.move',
    title: 'Move a menu bar item',
    description: 'Move a menu bar item: to a position (1 is leftmost), first or last, or before or after another item.',
    tier: 'act',
    args: [
      { name: 'item', type: 'string', description: 'The item to move', required: true },
      { name: 'position', type: 'string', description: 'first, last, or a number (1 is leftmost)' },
      { name: 'before', type: 'string', description: 'Put it just left of this item' },
      { name: 'after', type: 'string', description: 'Put it just right of this item' }
    ],
    run: async ({ item, position, before, after }) => {
      const id = itemArg(item)

      if (!(MENU_BAR_ITEMS as readonly string[]).includes(id)) {
        return fail(id)
      }

      const current = layout()
      const rest = current.order.filter(other => other !== id)
      let index: number

      if (before || after) {
        const anchor = itemArg(before ?? after)

        if (!(rest as string[]).includes(anchor)) {
          return fail(anchor === id ? 'Pick another item to move it next to.' : anchor)
        }

        index = rest.indexOf(anchor as MenuBarItem) + (after ? 1 : 0)
      } else if (position === 'first') {
        index = 0
      } else if (position === 'last' || position === undefined) {
        index = rest.length
      } else if (Number.isFinite(Number(position))) {
        index = Number(position) - 1
      } else {
        return fail('position is first, last or a number (1 is leftmost).')
      }

      await updatePrefs({ menuBar: { ...current, order: moveMenuBarItem(current.order, id as MenuBarItem, index) } })

      return ok(`Moved ${MENU_BAR_LABELS[id as MenuBarItem]}`, { data: describe(), highlight: { kind: 'setting', id: 'appearance' } })
    }
  },
  {
    id: 'bar.clock',
    title: 'Menu bar clock',
    description: 'How the menu bar clock reads: 12 or 24 hours (or the system setting), with or without seconds, and a short, long or no date.',
    tier: 'act',
    // No `enum` here: the registry fills a missing enum argument with its first value, and each
    // argument left out must keep its current setting.
    args: [
      { name: 'hours', type: 'string', description: '12, 24 or system' },
      { name: 'seconds', type: 'boolean', description: 'Show seconds' },
      { name: 'date', type: 'string', description: 'short, long or none' }
    ],
    phrases: [{ phrase: 'use a 24 hour clock', args: { hours: '24' } }, { phrase: 'use a 12 hour clock', args: { hours: '12' } }, { phrase: 'show seconds in the clock', args: { seconds: true } }],
    run: async ({ hours, seconds, date }) => {
      const current = layout()
      const wantHours = hours === undefined ? current.clock.hours : String(hours).toLowerCase().replace(/h$/, '')
      const wantDate = date === undefined ? current.clock.date : String(date).toLowerCase()

      if (!['system', '12', '24'].includes(wantHours)) {
        return fail('hours is 12, 24 or system.')
      }

      if (!['short', 'long', 'none'].includes(wantDate)) {
        return fail('date is short, long or none.')
      }

      const clock = { hours: wantHours, seconds: seconds === undefined ? current.clock.seconds : Boolean(seconds), date: wantDate }
      const next = normalizeMenuBar({ ...current, clock })
      await updatePrefs({ menuBar: next })

      return ok(`The clock shows ${next.clock.hours === 'system' ? 'the system format' : `${next.clock.hours} hours`}${next.clock.seconds ? ' with seconds' : ''}${next.clock.date === 'none' ? ', no date' : `, ${next.clock.date} date`}`, {
        highlight: { kind: 'setting', id: 'appearance' }
      })
    }
  },
  {
    id: 'bar.reset',
    title: 'Reset the menu bar',
    description: 'Put every menu bar item back in its place, show them all, and use the default clock.',
    tier: 'act',
    args: [],
    run: async () => {
      await updatePrefs({ menuBar: normalizeMenuBar(undefined) })

      return ok('The menu bar is back to its default layout', { highlight: { kind: 'setting', id: 'appearance' } })
    }
  }
]
