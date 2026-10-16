import { IconCheck, IconPlayerPlay, IconTerminal2, IconX } from '@tabler/icons-react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'
import { Spinner } from '../../components/ui/primitives.tsx'
import { cn } from '../../lib/cn.ts'
import { stripAnsi, type StudioCommand, type StudioProcess } from '../../lib/studio-model.ts'

const THEME = { background: '#0a1230', foreground: '#e9eefb', cursor: '#0a1230', selectionBackground: 'rgba(82, 150, 255, 0.3)' }
const TAIL_LINES = 40

function CommandLog({ commands }: { commands: StudioCommand[] }) {
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [commands])

  if (commands.length === 0) {
    return <div className="p-3 text-[12px] text-fg-3">Commands Hermes runs (installs, builds, servers) appear here with their output.</div>
  }

  return (
    <div className="space-y-2 p-2.5 font-mono text-[12px] leading-[1.5]">
      {commands.map(command => {
        const output = stripAnsi(command.output).trimEnd()
        const lines = output ? output.split('\n') : []
        const hidden = Math.max(0, lines.length - TAIL_LINES)

        return (
          <div key={command.id}>
            <div className="flex items-start gap-2">
              <span className="mt-[2px] flex size-4 shrink-0 items-center justify-center">
                {command.status === 'running' ? <Spinner /> : command.status === 'done' ? <IconCheck size={13} className="text-ok" /> : command.status === 'background' ? <IconPlayerPlay size={12} className="text-accent-strong" /> : <IconX size={13} className="text-danger" />}
              </span>
              <span className="min-w-0 whitespace-pre-wrap break-all text-fg">
                <span className="text-fg-4">$ </span>
                {command.command}
              </span>
              {command.status === 'background' && <span className="ml-auto shrink-0 text-[11px] text-accent-strong">running in the background</span>}
              {command.status === 'failed' && command.exitCode !== null && <span className="ml-auto shrink-0 text-[11px] text-danger">exit {command.exitCode}</span>}
            </div>
            {lines.length > 0 && command.status !== 'background' && (
              <pre className="ml-6 mt-0.5 whitespace-pre-wrap break-all text-fg-3">
                {hidden > 0 && <span className="text-fg-4">… {hidden} more lines{'\n'}</span>}
                {lines.slice(-TAIL_LINES).join('\n')}
              </pre>
            )}
          </div>
        )
      })}
      <div ref={end} />
    </div>
  )
}

/** A background process's live output (the dev server), read-only, with its colours. */
function ProcessOutput({ process }: { process: StudioProcess }) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<{ terminal: Terminal; fit: FitAddon; written: number } | null>(null)

  useEffect(() => {
    const node = host.current

    if (!node) {
      return
    }

    const terminal = new Terminal({ theme: THEME, fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', disableStdin: true, cursorBlink: false, convertEol: true, scrollback: 5000 })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(node)
    term.current = { terminal, fit, written: 0 }
    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        // Hidden or zero-sized: fit again on the next resize.
      }
    })
    observer.observe(node)

    return () => {
      observer.disconnect()
      terminal.dispose()
      term.current = null
    }
  }, [process.id])

  useEffect(() => {
    const current = term.current

    if (!current) {
      return
    }

    // The buffer is capped at the front, so a shorter buffer means it was trimmed: repaint it whole.
    if (process.output.length < current.written) {
      current.terminal.reset()
      current.written = 0
    }

    current.terminal.write(process.output.slice(current.written))
    current.written = process.output.length
  }, [process.output])

  return <div ref={host} className="h-full w-full px-2 py-1" />
}

/** Bottom of the Studio: what Hermes ran, and a live tab per background process. */
export function TerminalPane({ commands, processes }: { commands: StudioCommand[]; processes: Record<string, StudioProcess> }) {
  const list = Object.values(processes)
  const [tab, setTab] = useState<string>('commands')
  const seen = useRef(new Set<string>())

  // A new dev server gets its own tab and takes focus once, so its address is visible.
  useEffect(() => {
    for (const id of Object.keys(processes)) {
      if (!seen.current.has(id)) {
        seen.current.add(id)
        setTab(id)
      }
    }
  }, [processes])

  const active = tab === 'commands' ? null : processes[tab]

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0a1230]">
      <div className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-2">
        <button type="button" onClick={() => setTab('commands')} className={cn('flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11.5px] text-fg-3 hover:text-fg', tab === 'commands' && 'bg-white/8 text-fg')}>
          <IconTerminal2 size={13} /> Commands
          {commands.some(c => c.status === 'running') && <Spinner />}
        </button>
        {list.map(process => (
          <button key={process.id} type="button" onClick={() => setTab(process.id)} className={cn('flex h-6 max-w-[220px] shrink-0 items-center gap-1.5 rounded-md px-2 text-[11.5px] text-fg-3 hover:text-fg', tab === process.id && 'bg-white/8 text-fg')} title={process.command}>
            <span className={cn('size-1.5 shrink-0 rounded-full', process.running ? 'bg-ok' : 'bg-fg-4')} />
            <span className="truncate font-mono">{process.command}</span>
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{active ? <ProcessOutput key={active.id} process={active} /> : <CommandLog commands={commands} />}</div>
    </div>
  )
}
