import { IconChevronDown, IconStack2 } from '@tabler/icons-react'
import { memo, useState } from 'react'
import { Spinner } from '../../components/ui/primitives.tsx'
import { cn } from '../../lib/cn.ts'
import type { ToolMessage } from '../../lib/chat-model.ts'
import { deviceNoun } from '../../lib/platform-labels.ts'
import { ToolRow } from '../chat/ToolRow.tsx'

type Category = 'read' | 'web' | 'terminal' | 'system' | 'write' | 'other'

function categoryOf(name: string): Category {
  if (name === 'read_file' || name === 'search_files') {
    return 'read'
  }

  if (name.startsWith('web_')) {
    return 'web'
  }

  if (name === 'terminal') {
    return 'terminal'
  }

  if (name.startsWith('system_')) {
    return 'system'
  }

  if (name === 'write_file' || name === 'patch') {
    return 'write'
  }

  return 'other'
}

const ORDER: Category[] = ['read', 'write', 'web', 'terminal', 'system', 'other']

function phrase(category: Category, n: number): string {
  switch (category) {
    case 'read':
      return n === 1 ? 'Read 1 file' : `Read ${n} files`
    case 'web':
      return n === 1 ? 'Searched the web' : `Searched the web ${n} times`
    case 'terminal':
      return n === 1 ? 'Ran 1 command' : `Ran ${n} commands`
    case 'system':
      return n === 1 ? `Checked 1 thing on your ${deviceNoun()}` : `Checked ${n} things on your ${deviceNoun()}`
    case 'write':
      return n === 1 ? 'Wrote 1 file' : `Wrote ${n} files`
    case 'other':
      return n === 1 ? '1 step' : `${n} steps`
  }
}

/** Human summary of a run of tool calls: "Read 6 files · Checked 2 projects". */
export function summarizeTools(tools: ToolMessage[]): string {
  const counts = new Map<Category, number>()

  for (const tool of tools) {
    const category = categoryOf(tool.name)
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }

  return ORDER.filter(c => counts.has(c))
    .map(c => phrase(c, counts.get(c) ?? 0))
    .join(' · ')
}

/** One collapsed row for all the tool calls of a turn; expands into the regular ToolRow list. */
export const ToolSummaryRow = memo(function ToolSummaryRow({ tools }: { tools: ToolMessage[] }) {
  const [open, setOpen] = useState(false)
  const running = tools.some(t => t.running)
  const summary = summarizeTools(tools)

  return (
    <div className="glass-card rounded-xl">
      <button type="button" aria-expanded={open} aria-label={open ? 'Hide steps' : 'Show steps'} onClick={() => setOpen(v => !v)} className="flex h-11 w-full items-center gap-3 rounded-xl px-3.5 text-left hover:bg-white/4">
        <span className="flex size-6 shrink-0 items-center justify-center text-fg-2">{running ? <Spinner /> : <IconStack2 size={17} stroke={1.6} />}</span>
        <span className={cn('min-w-0 flex-1 truncate text-[12.5px]', running ? 'text-fg' : 'text-fg-2')}>{running ? `Working · ${summary}` : summary}</span>
        <IconChevronDown size={15} className={cn('shrink-0 text-fg-3 transition-transform duration-150', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="border-t border-line px-2.5 pt-1.5 pb-2 animate-fade-in">
          {tools.map(tool => (
            <ToolRow key={tool.id} tool={tool} />
          ))}
        </div>
      )}
    </div>
  )
})
