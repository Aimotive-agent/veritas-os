import { IconCode, IconExternalLink, IconPin, IconPinnedOff } from '@tabler/icons-react'
import type { ThemedToken } from 'shiki/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { EmptyState, Spinner } from '../../components/ui/primitives.tsx'
import { cn } from '../../lib/cn.ts'
import { highlightLines } from '../../lib/highlight.ts'
import type { StudioFile, StudioState } from '../../lib/studio-model.ts'
import { openInEditor } from './open-in-editor.ts'

const MAX_LINES = 5000
/** How long a file Hermes is writing takes to "type" onto the screen. */
const REVEAL_MS = 1400

const relative = (path: string, root: string | null): string => (root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path)

const STATUS_LABEL: Partial<Record<StudioFile['status'], string>> = {
  writing: 'Hermes is writing this file',
  editing: 'Hermes is editing this file',
  written: 'Created',
  edited: 'Edited',
  failed: 'The last change failed',
  changed: 'Changed on disk'
}

/** Reveal `text` progressively while Hermes writes it, so the file visibly appears line by line. */
function useReveal(text: string | undefined): string | undefined {
  const [shown, setShown] = useState(text)

  useEffect(() => {
    if (text === undefined) {
      setShown(undefined)
      return
    }

    const started = performance.now()
    let frame = 0
    const tick = () => {
      const progress = Math.min(1, (performance.now() - started) / REVEAL_MS)
      setShown(text.slice(0, Math.ceil(text.length * progress)))

      if (progress < 1) {
        frame = requestAnimationFrame(tick)
      }
    }
    frame = requestAnimationFrame(tick)

    return () => cancelAnimationFrame(frame)
  }, [text])

  return shown
}

/** Seconds since `since`, ticking once a second while set. */
function useElapsed(since: number | null): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (since === null) {
      return
    }

    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)

    return () => clearInterval(timer)
  }, [since])

  return since === null ? 0 : Math.max(0, Math.round((now - since) / 1000))
}

const COMPOSING: Record<string, string> = {
  write_file: 'Hermes is writing a file',
  patch: 'Hermes is preparing an edit',
  terminal: 'Hermes is preparing a command'
}

/** A model composes a whole file before the write runs; say so instead of looking stuck. */
function ComposingBanner({ generating }: { generating: StudioState['generating'] }) {
  const seconds = useElapsed(generating?.since ?? null)
  const label = generating ? COMPOSING[generating.tool] : undefined

  if (!label) {
    return null
  }

  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line bg-accent/10 px-3 text-[11.5px] text-accent-strong">
      <Spinner />
      <span>{label}…</span>
      <span className="ml-auto tabular-nums text-fg-3">{seconds}s</span>
    </div>
  )
}

/** The file Hermes is working on: syntax coloured, changed lines marked, following along as it writes. */
export function CodeView({ path, file, root, pinned, onTogglePin, running = false, generating = null }: { path: string | null; file: StudioFile | undefined; root: string | null; pinned: boolean; onTogglePin: () => void; running?: boolean; generating?: StudioState['generating'] }) {
  const [disk, setDisk] = useState<{ path: string; text: string | null; note?: string } | null>(null)
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const revealed = useReveal(file?.pending)
  const updatedAt = file?.updatedAt ?? 0

  useEffect(() => {
    if (!path || file?.pending !== undefined) {
      return
    }

    let cancelled = false
    window.heraldOS.fs
      .readFile(path)
      .then(preview => {
        if (cancelled) {
          return
        }

        if (preview.kind === 'text') {
          setDisk({ path, text: preview.content ?? '', note: preview.truncated ? 'Only the first 2 MB are shown.' : undefined })
        } else {
          setDisk({ path, text: null, note: preview.kind === 'image' ? 'An image; see it in the preview.' : preview.kind === 'directory' ? 'A folder.' : 'Not a text file.' })
        }
      })
      .catch(() => !cancelled && setDisk({ path, text: null, note: 'Hermes has not saved this file yet.' }))

    return () => {
      cancelled = true
    }
  }, [path, updatedAt, file?.pending])

  const text = file?.pending !== undefined ? revealed ?? '' : disk?.path === path ? disk.text : null
  const lines = useMemo(() => (text === null ? [] : text.split('\n').slice(0, MAX_LINES)), [text])
  const writing = file?.pending !== undefined

  // Colour the settled text; while a file streams in, plain text keeps up with the reveal.
  useEffect(() => {
    setTokens(null)

    if (!path || text === null || writing) {
      return
    }

    let cancelled = false
    void highlightLines(text, path)
      .then(result => !cancelled && setTokens(result))
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [path, text, writing])

  const changed = useMemo(() => new Set(file?.changedLines ?? []), [file?.changedLines])

  // Bring the first change into view after each edit; follow the end while a file is being written.
  useEffect(() => {
    const node = scroller.current

    if (!node) {
      return
    }

    if (writing) {
      node.scrollTop = node.scrollHeight
      return
    }

    const first = file?.changedLines?.[0]

    if (first) {
      const row = node.querySelector<HTMLElement>(`[data-line="${first}"]`)
      row?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [writing, revealed, file?.changedLines, tokens])

  if (!path) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <ComposingBanner generating={generating} />
        {running ? (
          <EmptyState icon={<Spinner />} title={generating?.tool === 'write_file' ? 'Hermes is writing the first file' : 'Hermes is planning the build'} description="Each file appears here the moment Hermes saves it." className="min-h-0 flex-1" />
        ) : (
          <EmptyState icon={<IconCode size={28} />} title="Nothing written yet" description="The file Hermes is writing shows here as it types." className="min-h-0 flex-1" />
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ComposingBanner generating={generating} />
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3 text-[12px]">
        <span className="truncate text-fg">{relative(path, root)}</span>
        {file && <span className={cn('shrink-0 text-fg-3', writing && 'text-accent-strong')}>{STATUS_LABEL[file.status]}</span>}
        {writing && <Spinner className="shrink-0" />}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <button type="button" onClick={onTogglePin} className="flex size-6 items-center justify-center rounded-md text-fg-3 hover:bg-white/8 hover:text-fg" title={pinned ? 'Follow Hermes from file to file' : 'Stay on this file'} aria-label={pinned ? 'Follow Hermes' : 'Stay on this file'}>
            {pinned ? <IconPinnedOff size={14} /> : <IconPin size={14} />}
          </button>
          <button type="button" onClick={() => openInEditor(path)} className="flex size-6 items-center justify-center rounded-md text-fg-3 hover:bg-white/8 hover:text-fg" title="Open in editor" aria-label="Open in editor">
            <IconExternalLink size={14} />
          </button>
        </span>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto bg-[#0d1117] py-2 font-mono text-[12.5px] leading-[1.55]">
        {text === null ? (
          <div className="px-4 text-fg-3">{disk?.note ?? 'Loading…'}</div>
        ) : (
          <table className="w-full border-collapse">
            <tbody>
              {lines.map((line, index) => {
                const number = index + 1
                const isChanged = changed.has(number)

                return (
                  <tr key={number} data-line={number} className={cn(isChanged && 'bg-accent/15')}>
                    <td className={cn('w-12 select-none border-r border-white/5 pr-3 text-right align-top text-[11.5px] text-fg-4', isChanged && 'border-r-2 border-r-accent text-accent-strong')}>{number}</td>
                    <td className="whitespace-pre pl-4 pr-6 align-top text-[#e6edf3]">
                      {tokens?.[index]
                        ? tokens[index].map((token, i) => (
                            <span key={i} style={{ color: token.color }}>
                              {token.content}
                            </span>
                          ))
                        : line || ' '}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        {disk?.note && text !== null && <div className="px-4 pt-2 text-[11.5px] text-fg-3">{disk.note}</div>}
      </div>
    </div>
  )
}
