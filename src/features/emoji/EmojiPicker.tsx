import { useStore } from '@nanostores/react'
import { IconMoodSmile, IconSearch } from '@tabler/icons-react'
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { Kbd } from '../../components/ui/primitives.tsx'
import { cn } from '../../lib/cn.ts'
import { EMOJI, type Emoji, searchEmoji } from '../../lib/emoji.ts'
import { $emojiPicker, insertEmoji, recentEmoji } from '../../store/emoji.ts'

const COLUMNS = 12

/** Desktop mode: the picker over the Veritas window (panels mode uses the command overlay window). */
export function EmojiOverlay() {
  const open = useStore($emojiPicker)
  const close = () => $emojiPicker.set(false)

  if (!open) {
    return null
  }

  return (
    <div className="absolute inset-0 z-(--z-command) flex items-start justify-center bg-black/20 pt-[16vh] animate-fade-in" onMouseDown={event => event.target === event.currentTarget && close()}>
      <EmojiPicker className="w-[min(620px,92vw)]" onPick={char => void insertEmoji(char)} onClose={close} />
    </div>
  )
}

/**
 * Emoji picker (Mod+Ctrl+E): type to search by name or keyword, arrows to move, Enter or a click to
 * insert into the field you were typing in. Recent picks come first.
 */
export function EmojiPicker({ onPick, onClose, className }: { onPick: (char: string) => void; onClose: () => void; className?: string }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const recents = useMemo(() => {
    const byChar = new Map(EMOJI.map(emoji => [emoji.char, emoji]))

    return recentEmoji()
      .map(char => byChar.get(char))
      .filter((emoji): emoji is Emoji => Boolean(emoji))
  }, [])
  const results = useMemo(() => (query.trim() ? searchEmoji(query, 240) : null), [query])
  const visible = results ?? [...recents, ...EMOJI.filter(emoji => !recents.includes(emoji))]
  const current = visible[active]

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    setActive(0)
  }, [query])

  useEffect(() => {
    gridRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const onKeyDown = (event: ReactKeyboardEvent) => {
    const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS }
    const step = moves[event.key]

    if (step !== undefined && visible.length > 0) {
      event.preventDefault()
      setActive(index => Math.max(0, Math.min(visible.length - 1, index + step)))
    } else if (event.key === 'Enter' && current) {
      event.preventDefault()
      onPick(current.char)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  const cell = (emoji: Emoji, index: number) => (
    <button
      key={emoji.char}
      type="button"
      role="option"
      aria-selected={index === active}
      aria-label={emoji.name}
      title={emoji.name}
      data-active={index === active}
      onMouseEnter={() => setActive(index)}
      onClick={() => onPick(emoji.char)}
      className={cn('flex size-11 items-center justify-center rounded-lg', index === active && 'bg-white/12')}
    >
      {/* The global `button { font: inherit }` rule outranks text utilities on the button itself. */}
      <span className="text-[24px] leading-none">{emoji.char}</span>
    </button>
  )

  return (
    <div data-edit-ignore className={cn('float flex flex-col overflow-hidden rounded-2xl animate-pop', className)} onKeyDown={onKeyDown}>
      <label className="mx-3 mt-3 flex h-10 items-center gap-2.5 rounded-lg px-3 glass-input">
        <IconSearch size={15} className="shrink-0 text-fg-3" />
        <input ref={inputRef} value={query} onChange={event => setQuery(event.target.value)} placeholder="Search emoji: party, rocket, thumbs up…" aria-label="Search emoji" className="min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-fg-4" />
        <Kbd>esc</Kbd>
      </label>
      <div ref={gridRef} role="listbox" aria-label="Emoji" className="grid max-h-[372px] grid-cols-12 gap-0.5 overflow-y-auto p-3">
        {!results && recents.length > 0 && <div className="col-span-12 px-1 pb-1 text-[11px] font-medium text-fg-4">Recent</div>}
        {visible.map(cell)}
        {visible.length === 0 && (
          <div className="col-span-12 flex flex-col items-center gap-2 py-8 text-[12.5px] text-fg-4">
            <IconMoodSmile size={22} /> Nothing matches "{query.trim()}"
          </div>
        )}
      </div>
      <div className="flex h-9 items-center gap-2 border-t border-line px-4 text-[12px] text-fg-3">
        {current ? (
          <>
            <span className="text-[16px]">{current.char}</span>
            <span className="truncate">{current.name}</span>
          </>
        ) : (
          <span>Pick an emoji</span>
        )}
        <span className="flex-1" />
        <Kbd>↵</Kbd> insert
      </div>
    </div>
  )
}
