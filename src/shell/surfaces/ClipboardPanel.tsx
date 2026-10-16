import { IconClipboard, IconFileUnknown, IconSearch } from '@tabler/icons-react'
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState } from 'react'
import type { ClipboardEntry } from '../../../shared/ipc.ts'
import { HermesAvatar } from '../../components/app-icon.tsx'
import { EmptyGlass } from '../../components/ui/glass.tsx'
import { Kbd, Spinner } from '../../components/ui/primitives.tsx'
import { cn } from '../../lib/cn.ts'
import { InlineMessage } from './ControlMenu.tsx'

const LIMIT = 50

/** cliphist labels non-text entries like `[[ binary data 12 KiB png ]]`. */
const BINARY = /^\[\[\s*binary data/i

export const isBinaryEntry = (entry: ClipboardEntry): boolean => BINARY.test(entry.preview.trim())

/**
 * Clipboard history (Mod+Ctrl+V): the last entries from cliphist, filterable; Enter or a click
 * pastes one back onto the clipboard and closes the overlay.
 */
export function ClipboardPanel({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<ClipboardEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [pasting, setPasting] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    const bridge = window.heraldOS?.clipboard

    if (!bridge) {
      setEntries([])

      return
    }

    bridge
      .history(LIMIT)
      .then(list => {
        if (!cancelled) {
          setEntries(list)
          inputRef.current?.focus()
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason))
          setEntries([])
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  const trimmed = query.trim().toLowerCase()
  const visible = (entries ?? []).filter(entry => !trimmed || entry.preview.toLowerCase().includes(trimmed))

  useEffect(() => {
    setActive(0)
  }, [trimmed])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, visible.length])

  const paste = (entry: ClipboardEntry) => {
    if (pasting) {
      return
    }

    setPasting(entry.id)
    window.heraldOS.clipboard
      .paste(entry.id)
      .then(onClose)
      .catch((reason: unknown) => {
        setPasting(null)
        setError(reason instanceof Error ? reason.message : String(reason))
      })
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()

      if (visible.length > 0) {
        setActive(index => (index + (event.key === 'ArrowDown' ? 1 : visible.length - 1)) % visible.length)
      }
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const entry = visible[active]

      if (entry) {
        paste(entry)
      }
    }
  }

  return (
    <div className="float flex flex-col overflow-hidden rounded-2xl animate-pop" onKeyDown={onKeyDown}>
      <div className="flex items-center gap-3 px-4 pt-4 pb-3">
        <HermesAvatar size={22} rounded={6} />
        <span className="text-[14px] font-semibold">Clipboard</span>
        {entries && entries.length > 0 && <span className="text-[11.5px] text-fg-4 tabular-nums">{entries.length} recent</span>}
        <span className="flex-1" />
        <Kbd>esc</Kbd>
      </div>
      <div className="h-px bg-line" />

      {entries === null ? (
        <div className="flex items-center gap-3 px-4 py-6 text-[12.5px] text-fg-3">
          <Spinner /> Loading clipboard history…
        </div>
      ) : entries.length === 0 ? (
        <div className="p-4">
          <EmptyGlass icon={<IconClipboard />} title="Clipboard history is empty" description={error ?? 'Copies you make on Veritas OS Linux are collected by cliphist and listed here.'} />
        </div>
      ) : (
        <>
          <label className="mx-3 mt-3 flex h-9 items-center gap-2.5 rounded-lg px-3 glass-input">
            <IconSearch size={15} className="shrink-0 text-fg-3" />
            <input
              ref={inputRef}
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Type to filter"
              aria-label="Filter clipboard history"
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-4"
            />
            <span className="text-[11px] text-fg-4">
              <Kbd>↵</Kbd> paste
            </span>
          </label>
          {error && <InlineMessage text={error} tone="danger" className="mx-3 mt-2" />}
          <div ref={listRef} className="flex max-h-[400px] flex-col gap-0.5 overflow-y-auto p-2" role="listbox" aria-label="Clipboard entries">
            {visible.length === 0 && <div className="px-3 py-6 text-center text-[12.5px] text-fg-4">Nothing matches "{query.trim()}"</div>}
            {visible.map((entry, index) => {
              const binary = isBinaryEntry(entry)
              const isActive = index === active

              return (
                <button
                  key={entry.id}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  data-active={isActive}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => paste(entry)}
                  disabled={pasting !== null}
                  className={cn('flex min-h-10 items-center gap-3 rounded-lg px-3 py-1.5 text-[13px] text-fg-2', isActive && 'bg-white/10 text-fg', binary && 'opacity-55')}
                >
                  <span className="flex size-6 shrink-0 items-center justify-center text-fg-3">{pasting === entry.id ? <Spinner /> : binary ? <IconFileUnknown size={16} /> : <IconClipboard size={16} />}</span>
                  <span className={cn('min-w-0 flex-1 truncate text-left', binary && 'font-mono text-[12px] text-fg-3')}>{entry.preview.replace(/\s+/g, ' ').trim() || '(whitespace)'}</span>
                  <span className="shrink-0 text-[11px] text-fg-4 tabular-nums">{entry.id}</span>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
