import { IconChevronRight } from '@tabler/icons-react'
import { GlassCard } from '../../components/ui/glass.tsx'
import { MemoryTile } from './memory-icons.tsx'
import type { MemoryEntry } from './memory-store.ts'

export const formatShortDate = (epochMs: number): string => (epochMs ? new Date(epochMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—')

export function MemoryRow({ entry, selected, onSelect }: { entry: MemoryEntry; selected: boolean; onSelect: () => void }) {
  return (
    <GlassCard as="button" interactive selected={selected} onClick={onSelect} className="flex w-full items-center gap-3.5 px-3.5 py-3" data-os-target={`memory:${entry.id}`}>
      <MemoryTile entry={entry} size={40} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-fg">{entry.title}</div>
        {entry.summary && <div className="truncate text-[12px] text-fg-3">{entry.summary}</div>}
      </div>
      <span className="shrink-0 text-[12px] text-fg-3 tabular-nums">{formatShortDate(entry.date)}</span>
      <IconChevronRight size={16} className="shrink-0 text-fg-4" aria-hidden="true" />
    </GlassCard>
  )
}
