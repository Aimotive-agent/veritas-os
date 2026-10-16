import { useStore } from '@nanostores/react'
import { IconCalendar, IconChevronDown, IconChevronUp, IconClock, IconGripVertical, IconRestore } from '@tabler/icons-react'
import { useState } from 'react'
import { clockText, MENU_BAR_LABELS, type MenuBarClock, type MenuBarItem, normalizeMenuBar, PINNED_ITEMS } from '../../../../shared/menu-bar.ts'
import { Chips, GlassButton, Toggle } from '../../../components/ui/glass.tsx'
import { cn } from '../../../lib/cn.ts'
import { useClock } from '../../../shell/MenuBar.tsx'
import { $prefs } from '../../../store/backend.ts'
import { notify } from '../../../store/notifications.ts'
import { runCommand } from '../../../store/os-commands.ts'
import { Filterable, markSaved, SettingsGroup, SettingsRow } from './shared.tsx'

const HINTS: Partial<Record<MenuBarItem, string>> = {
  widgets: 'Widgets you turned on for the menu bar',
  voice: 'While Hermes is listening or speaking',
  indicators: 'Recording, dictation and switches that are on. Always shown.',
  usage: 'How much of your model plan is used',
  battery: 'On computers with a battery'
}

const HOURS: { id: MenuBarClock['hours']; label: string }[] = [
  { id: 'system', label: 'Automatic' },
  { id: '12', label: '12-hour' },
  { id: '24', label: '24-hour' }
]

const DATES: { id: MenuBarClock['date']; label: string }[] = [
  { id: 'short', label: 'Short' },
  { id: 'long', label: 'Long' },
  { id: 'none', label: 'None' }
]

async function run(command: string, args: Record<string, unknown> = {}) {
  const result = await runCommand(command, args, { source: 'ui' })

  if (result.ok) {
    markSaved()
  } else {
    notify({ title: 'Could not change the menu bar', body: result.error ?? result.summary, level: 'error' })
  }
}

/** Settings > Appearance > Menu bar: the items in order (drag or the arrows), each one's switch, and the clock. */
export function MenuBarSettings() {
  const prefs = useStore($prefs)
  const layout = normalizeMenuBar(prefs.menuBar)
  const [dragging, setDragging] = useState<MenuBarItem | null>(null)
  const [slot, setSlot] = useState<number | null>(null)
  const now = useClock(1000)
  const preview = clockText(now, layout.clock)
  const shown = (item: MenuBarItem) => (item === 'usage' ? Boolean(prefs.usageInMenuBar) : !layout.hidden.includes(item))
  const last = layout.order.length - 1

  const endDrag = () => {
    setDragging(null)
    setSlot(null)
  }

  const drop = () => {
    if (dragging && slot !== null) {
      const from = layout.order.indexOf(dragging)
      // Slots count the dragged row itself; positions are among the others, 1 being leftmost.
      void run('bar.move', { item: dragging, position: String((slot > from ? slot - 1 : slot) + 1) })
    }

    endDrag()
  }

  return (
    <SettingsGroup title="Menu bar">
      <Filterable label="Menu bar items" description="Drag to reorder; the switch shows or hides each item." keywords="menu bar status icons order hide show reorder wifi bluetooth battery search">
        <div className="settings-row px-3.5 py-2.5">
          <div className="mb-1.5 text-[12px] text-fg-3">Top to bottom is left to right in the menu bar. Drag an item, or use its arrows, to move it.</div>
          <ol aria-label="Menu bar items" className="flex flex-col">
            {layout.order.map((item, index) => {
              const label = MENU_BAR_LABELS[item]

              return (
                <li
                  key={item}
                  draggable
                  onDragStart={event => {
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', item)
                    setDragging(item)
                  }}
                  onDragOver={event => {
                    if (!dragging) {
                      return
                    }

                    event.preventDefault()
                    const box = event.currentTarget.getBoundingClientRect()
                    setSlot(event.clientY < box.top + box.height / 2 ? index : index + 1)
                  }}
                  onDrop={event => {
                    event.preventDefault()
                    drop()
                  }}
                  onDragEnd={endDrag}
                  className={cn('relative flex h-10 cursor-grab items-center gap-2.5 rounded-lg px-1.5 hover:bg-white/4', dragging === item && 'opacity-40')}
                >
                  {dragging && slot === index && <span aria-hidden="true" className="absolute inset-x-1 -top-px h-0.5 rounded-full bg-accent" />}
                  {dragging && slot === last + 1 && index === last && <span aria-hidden="true" className="absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-accent" />}
                  <IconGripVertical size={14} className="shrink-0 text-fg-4" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className={cn('text-[13px]', shown(item) ? 'text-fg' : 'text-fg-3')}>{label}</div>
                    {HINTS[item] && <div className="truncate text-[11.5px] text-fg-4">{HINTS[item]}</div>}
                  </div>
                  <GlassButton size="icon" variant="ghost" aria-label={`Move ${label} earlier`} disabled={index === 0} onClick={() => void run('bar.move', { item, position: String(index) })}>
                    <IconChevronUp size={14} />
                  </GlassButton>
                  <GlassButton size="icon" variant="ghost" aria-label={`Move ${label} later`} disabled={index === last} onClick={() => void run('bar.move', { item, position: String(index + 2) })}>
                    <IconChevronDown size={14} />
                  </GlassButton>
                  <Toggle checked={shown(item)} disabled={PINNED_ITEMS.includes(item)} onChange={next => void run(next ? 'bar.show' : 'bar.hide', { item })} label={`Show ${label}`} />
                </li>
              )
            })}
          </ol>
        </div>
      </Filterable>
      <SettingsRow icon={<IconClock />} label="Clock" description={<span className="tabular-nums">{[preview.date, preview.time].filter(Boolean).join('  ')}</span>} keywords="time 12 hour 24 hour format">
        <Chips items={HOURS} value={layout.clock.hours} onChange={hours => void run('bar.clock', { hours })} />
      </SettingsRow>
      <SettingsRow icon={<IconClock />} label="Show seconds" keywords="clock seconds time">
        <Toggle checked={layout.clock.seconds} onChange={seconds => void run('bar.clock', { seconds })} label="Show seconds" />
      </SettingsRow>
      <SettingsRow icon={<IconCalendar />} label="Date" description="Next to the time." keywords="clock date weekday">
        <Chips items={DATES} value={layout.clock.date} onChange={date => void run('bar.clock', { date })} />
      </SettingsRow>
      <SettingsRow icon={<IconRestore />} label="Reset the menu bar" description="Every item back in its place and shown, and the default clock." keywords="menu bar default restore">
        <GlassButton size="sm" variant="ghost" onClick={() => void run('bar.reset')}>
          Reset
        </GlassButton>
      </SettingsRow>
    </SettingsGroup>
  )
}
