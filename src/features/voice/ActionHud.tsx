import { useStore } from '@nanostores/react'
import { IconBolt, IconRobot, IconX } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '../../lib/cn.ts'
import { $commandLog, type CommandEvent } from '../../store/os-commands.ts'
import { useViewAvoid } from '../../store/view-avoid.ts'

/*
 * The action HUD: when voice or the agent drives the OS, a short caption shows what just happened
 * ("Opened Missions", "Remembered: prefers short answers") so the user can watch the computer act.
 * Clicks and keyboard shortcuts do not show here; the user already knows what they did.
 */

const SHOWN_SOURCES = new Set(['voice', 'agent', 'follow', 'cli'])
const VISIBLE_MS = 3200

export function ActionHud({ offsetClass = 'top-12' }: { offsetClass?: string }) {
  const log = useStore($commandLog)
  const [visible, setVisible] = useState<CommandEvent[]>([])
  // One timer per card, owned outside the effect so a newer card never cancels an older card's timer.
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  useEffect(() => {
    const latest = log[0]

    if (!latest || !SHOWN_SOURCES.has(latest.source) || timers.current.has(latest.id)) {
      return
    }

    setVisible(current => [latest, ...current.filter(e => e.id !== latest.id)].slice(0, 3))
    timers.current.set(
      latest.id,
      setTimeout(() => {
        timers.current.delete(latest.id)
        setVisible(current => current.filter(e => e.id !== latest.id))
      }, VISIBLE_MS)
    )
  }, [log])

  useEffect(() => {
    const owned = timers.current

    return () => {
      owned.forEach(timer => clearTimeout(timer))
      owned.clear()
    }
  }, [])

  if (visible.length === 0) {
    return null
  }

  return (
    <div className={cn('pointer-events-none absolute inset-x-0 z-(--z-overlay) flex flex-col items-center gap-1.5 px-4', offsetClass)} aria-live="polite">
      {visible.map(event => (
        <AvoidedByViews key={event.id} className={cn('float pointer-events-auto flex max-w-xl items-center gap-2.5 rounded-full px-3.5 py-1.5 animate-rise', !event.result.ok && 'border-warn/40')}>
          <span className={cn('flex size-5 items-center justify-center', event.result.ok ? 'text-accent-strong' : 'text-warn')}>{event.source === 'agent' ? <IconRobot size={14} /> : event.result.ok ? <IconBolt size={14} /> : <IconX size={14} />}</span>
          <span className="truncate text-[12.5px] text-fg">{event.result.ok ? event.result.summary : event.result.error ?? event.result.summary}</span>
          <span className="text-[11px] text-fg-4">{event.source === 'agent' ? 'Hermes' : event.source === 'voice' ? 'voice' : event.source === 'follow' ? 'following Hermes' : event.source}</span>
        </AvoidedByViews>
      ))}
    </div>
  )
}

/** A box that open web pages and the file viewer make room for instead of drawing over it. */
export function AvoidedByViews({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null)
  useViewAvoid(ref)

  return (
    <div ref={ref} className={className} {...props}>
      {children}
    </div>
  )
}

/**
 * Scroll to and pulse the element a command pointed at (`data-os-target="kind:id"`). Pages render
 * asynchronously after navigation, so the lookup retries briefly before giving up quietly.
 */
export function OsHighlighter() {
  const log = useStore($commandLog)

  useEffect(() => {
    const latest = log[0]
    const target = latest?.result.highlight

    if (!latest || !target || target.kind === 'page' || target.kind === 'window' || target.kind === 'setting') {
      return
    }

    const selector = `[data-os-target="${target.kind}:${cssEscape(target.id)}"]`
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | null = null

    const tryHighlight = () => {
      const element = document.querySelector<HTMLElement>(selector)

      if (element) {
        element.scrollIntoView({ block: 'center', behavior: document.documentElement.dataset.reduceMotion === 'true' ? 'auto' : 'smooth' })
        element.classList.remove('os-highlight')
        // Restart the animation even when the same element is highlighted twice in a row.
        void element.offsetWidth
        element.classList.add('os-highlight')
        setTimeout(() => element.classList.remove('os-highlight'), 1700)

        return
      }

      if (attempts++ < 12) {
        timer = setTimeout(tryHighlight, 150)
      }
    }

    tryHighlight()

    return () => {
      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [log])

  return null
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&')
}
