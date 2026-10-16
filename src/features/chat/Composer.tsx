import { IconArrowUp, IconPlayerStop } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '../../components/ui/button.tsx'
import { Kbd } from '../../components/ui/primitives.tsx'
import { cn } from '../../lib/cn.ts'
import { useSlashCatalog } from './use-slash-catalog.ts'

export interface ComposerProps {
  disabled?: boolean
  streaming?: boolean
  placeholder?: string
  autoFocus?: boolean
  onSubmit: (text: string) => void | Promise<void>
  onInterrupt?: () => void
  className?: string
}

export function Composer({ disabled, streaming, placeholder, autoFocus, onSubmit, onInterrupt, className }: ComposerProps) {
  const [value, setValue] = useState('')
  const [selected, setSelected] = useState(0)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const catalog = useSlashCatalog()
  const slashQuery = value.startsWith('/') && !value.includes(' ') && !value.includes('\n') ? value.slice(1).toLowerCase() : null
  const completions = slashQuery !== null ? catalog.filter(entry => entry.name.toLowerCase().startsWith(slashQuery)).slice(0, 8) : []

  useEffect(() => {
    const el = textarea.current

    if (!el) {
      return
    }

    el.style.height = '0px'
    el.style.height = `${Math.min(220, Math.max(24, el.scrollHeight))}px`
  }, [value])

  useEffect(() => {
    setSelected(0)
  }, [slashQuery])

  const submit = async () => {
    const text = value.trim()

    if (!text || disabled) {
      return
    }

    setValue('')
    await onSubmit(text)
  }

  return (
    <div className={cn('relative', className)}>
      {completions.length > 0 && (
        <div className="float absolute bottom-full left-0 mb-2 w-full max-w-md overflow-hidden rounded-md">
          {completions.map((entry, index) => (
            <button
              key={entry.name}
              type="button"
              onMouseDown={event => {
                event.preventDefault()
                setValue(`/${entry.name} `)
              }}
              className={cn('flex w-full items-baseline gap-3 px-3 py-1.5 text-left text-[12.5px]', index === selected ? 'bg-white/6 text-fg' : 'text-fg-2')}
            >
              <span className="font-mono">/{entry.name}</span>
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg-3">{entry.description}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2 rounded-xl bg-surface px-3 py-2 shadow-panel hairline focus-within:shadow-[0_0_0_1px_var(--color-accent-soft),var(--shadow-panel)]">
        <textarea
          ref={textarea}
          value={value}
          autoFocus={autoFocus}
          disabled={disabled}
          rows={1}
          placeholder={placeholder ?? 'Message Hermes'}
          onChange={event => setValue(event.target.value)}
          onKeyDown={event => {
            if (completions.length > 0) {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setSelected(i => (i + 1) % completions.length)

                return
              }

              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setSelected(i => (i - 1 + completions.length) % completions.length)

                return
              }

              if (event.key === 'Tab') {
                event.preventDefault()
                setValue(`/${completions[selected].name} `)

                return
              }
            }

            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()

              if (completions.length > 0 && slashQuery !== null && completions[selected].name.toLowerCase() !== slashQuery) {
                setValue(`/${completions[selected].name} `)

                return
              }

              void submit()
            }
          }}
          className="max-h-[220px] min-h-6 flex-1 resize-none bg-transparent py-0.5 text-[13.5px] leading-6 outline-none placeholder:text-fg-4 disabled:opacity-50"
        />
        <div className="flex items-center gap-1.5 pb-0.5">
          {streaming && onInterrupt ? (
            <Button variant="danger" size="icon-sm" aria-label="Stop" onClick={onInterrupt}>
              <IconPlayerStop size={14} />
            </Button>
          ) : (
            <Button variant="primary" size="icon-sm" aria-label="Send" disabled={disabled || !value.trim()} onClick={() => void submit()}>
              <IconArrowUp size={15} />
            </Button>
          )}
        </div>
      </div>
      <div className="mt-1.5 flex items-center gap-2 px-1 text-[11px] text-fg-4">
        <Kbd>↵</Kbd> send
        <Kbd>⇧↵</Kbd> newline
        <span className="ml-auto">/ for commands and skills</span>
      </div>
    </div>
  )
}
