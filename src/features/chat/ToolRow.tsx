import { IconCheck, IconChevronRight, IconTool } from '@tabler/icons-react'
import { memo, useState } from 'react'
import { Spinner } from '../../components/ui/primitives.tsx'
import { cn } from '../../lib/cn.ts'
import { formatDuration, truncate } from '../../lib/format.ts'
import type { ToolMessage } from '../../lib/chat-model.ts'

const FRIENDLY: Record<string, string> = {
  terminal: 'Ran a command',
  read_file: 'Read a file',
  write_file: 'Wrote a file',
  patch: 'Edited a file',
  search_files: 'Searched files',
  web_search: 'Searched the web',
  web_extract: 'Read a web page',
  browser_navigate: 'Browsed',
  memory: 'Updated memory',
  todo: 'Updated the plan',
  delegate_task: 'Delegated a task',
  skill_view: 'Read a skill',
  system_info: 'Checked system info',
  system_processes: 'Inspected processes',
  system_disk_usage: 'Measured disk usage',
  system_find_files: 'Searched for files',
  system_apps: 'Listed apps',
  system_open: 'Opened',
  system_kill_process: 'Stopped a process',
  system_files: 'Changed files'
}

function argsPreview(tool: ToolMessage): string {
  if (tool.context) {
    return tool.context
  }

  const args = tool.args ?? {}

  for (const key of ['command', 'path', 'file_path', 'query', 'url', 'target', 'name', 'action', 'goal', 'pattern']) {
    const value = args[key]

    if (typeof value === 'string' && value) {
      return value
    }
  }

  const entries = Object.entries(args)

  return entries.length ? entries.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' · ') : ''
}

function resultPreview(tool: ToolMessage): string {
  if (tool.resultText) {
    return tool.resultText
  }

  if (typeof tool.result === 'string') {
    return tool.result
  }

  // The terminal tool and most bridge tools answer {output, error, ...}; show the human part.
  if (tool.result && typeof tool.result === 'object') {
    const record = tool.result as Record<string, unknown>
    const output = typeof record.output === 'string' ? record.output : typeof record.result === 'string' ? record.result : ''
    const error = typeof record.error === 'string' && record.error ? `Error: ${record.error}` : ''

    if (output || error) {
      return [error, output].filter(Boolean).join('\n')
    }
  }

  if (tool.result != null) {
    try {
      return JSON.stringify(tool.result, null, 2)
    } catch {
      return String(tool.result)
    }
  }

  return ''
}

export const ToolRow = memo(function ToolRow({ tool }: { tool: ToolMessage }) {
  const [open, setOpen] = useState(false)
  const label = FRIENDLY[tool.name] ?? tool.name.replace(/_/g, ' ')
  const preview = argsPreview(tool)
  const result = resultPreview(tool)
  const failed = !tool.running && /^(error|failed|blocked)\b/i.test(result.trim())

  return (
    <div className="my-1 text-[12.5px]">
      <button type="button" onClick={() => setOpen(v => !v)} className="group flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left hover:bg-white/4">
        <span className={cn('flex size-4 items-center justify-center text-fg-3', failed && 'text-danger')}>
          {tool.running ? <Spinner /> : failed ? <IconTool size={13} /> : <IconCheck size={13} />}
        </span>
        <span className="text-fg-2">{label}</span>
        {preview && <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-3">{truncate(preview, 140)}</span>}
        {!preview && <span className="flex-1" />}
        {tool.durationS != null && <span className="text-[11px] tabular-nums text-fg-4">{formatDuration(tool.durationS)}</span>}
        <IconChevronRight size={13} className={cn('text-fg-4 transition-transform duration-100', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="mt-1 ml-6 flex flex-col gap-2">
          {tool.args && Object.keys(tool.args).length > 0 && (
            <pre className="selectable max-h-48 overflow-auto rounded-md bg-surface px-3 py-2 font-mono text-[11.5px] leading-relaxed text-fg-2 hairline">{JSON.stringify(tool.args, null, 2)}</pre>
          )}
          {tool.summary && <div className="text-fg-2">{tool.summary}</div>}
          {result && (
            <pre className={cn('selectable max-h-72 overflow-auto rounded-md bg-surface px-3 py-2 font-mono text-[11.5px] leading-relaxed hairline whitespace-pre-wrap', failed ? 'text-danger' : 'text-fg-2')}>
              {truncate(result, 12_000)}
            </pre>
          )}
        </div>
      )}
    </div>
  )
})
