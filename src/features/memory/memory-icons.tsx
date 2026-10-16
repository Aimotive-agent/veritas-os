import { type Icon, IconCalendarEvent, IconFileText, IconFolder, IconPhoto, IconUpload, IconUser } from '@tabler/icons-react'
import { cn } from '../../lib/cn.ts'
import type { MemoryEntry } from './memory-store.ts'

const SCHEDULE = /\b(weekly|daily|monthly|fortnightly|every (day|week|month|morning|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|standup|stand-up|meeting|reminder|recurring)\b/i
const DESIGN = /\b(design|mockups?|references?|brand(ing)?|visuals?|palette|logo|typography|screenshots?|images?|photos?|figma)\b/i
const EXPORT = /\b(exports?|pdf|docx?|csv|xlsx|file formats?|deliverables?|attachments?)\b/i

/** Pick a glyph for an entry: content cues first, then kind, then the file it came from. */
export function iconFor(entry: Pick<MemoryEntry, 'text' | 'kind' | 'file'>): Icon {
  if (SCHEDULE.test(entry.text)) {
    return IconCalendarEvent
  }

  if (DESIGN.test(entry.text)) {
    return IconPhoto
  }

  if (EXPORT.test(entry.text)) {
    return IconUpload
  }

  switch (entry.kind) {
    case 'person':
      return IconUser
    case 'project':
      return IconFolder
    default:
      return entry.file === 'USER.md' ? IconUser : IconFileText
  }
}

/** Blue glass tile with the entry's glyph (40px in rows, 56px in the detail). */
export function MemoryTile({ entry, size = 40, className }: { entry: Pick<MemoryEntry, 'text' | 'kind' | 'file'>; size?: number; className?: string }) {
  const Glyph = iconFor(entry)

  return (
    <span className={cn('icon-tile shrink-0 text-fg', className)} style={{ width: size, height: size, borderRadius: Math.round(size * 0.24) }} aria-hidden="true">
      <Glyph size={Math.round(size * 0.5)} stroke={1.7} />
    </span>
  )
}
