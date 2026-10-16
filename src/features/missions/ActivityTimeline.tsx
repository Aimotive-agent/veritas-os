import { IconActivity } from '@tabler/icons-react'
import { EmptyGlass } from '../../components/ui/glass.tsx'
import type { ActivityEntry } from '../../store/missions.ts'
import { activityIcon, formatTime } from './mission-helpers.ts'

export function ActivityTimeline({ entries }: { entries: ActivityEntry[] }) {
  if (entries.length === 0) {
    return <EmptyGlass icon={<IconActivity />} title="No activity yet" description="Tool calls, plan updates and saved files show up here as Hermes works." />
  }

  return (
    <ol className="stagger relative before:absolute before:top-4 before:bottom-4 before:left-[15px] before:w-px before:bg-line" aria-label="Recent activity">
      {entries.map(entry => {
        const Icon = activityIcon(entry.kind)

        return (
          <li key={entry.id} className="flex items-start gap-3 py-1.5">
            <span className="hairline relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-strong">
              <Icon size={15} stroke={1.75} />
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="truncate text-[12.5px] text-fg">{entry.title}</div>
              {entry.detail && <div className="truncate text-[12px] text-fg-3">{entry.detail}</div>}
            </div>
            <span className="shrink-0 pt-0.5 text-[11.5px] text-fg-4 tabular-nums">{formatTime(entry.ts)}</span>
          </li>
        )
      })}
    </ol>
  )
}
