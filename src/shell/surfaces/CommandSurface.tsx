import { IconAppWindow, IconPaperclip } from '@tabler/icons-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ShellCommand, WmWindow } from '../../../shared/ipc.ts'
import { HermesAvatar } from '../../components/app-icon.tsx'
import { GlassButton, Pill } from '../../components/ui/glass.tsx'
import { Kbd } from '../../components/ui/primitives.tsx'
import { closeThisSurface, openSurface, relayToMain } from '../../store/shell.ts'
import { ApplicationsPanel } from '../../features/applications/ApplicationsOverlay.tsx'
import { EmojiPicker } from '../../features/emoji/EmojiPicker.tsx'
import { insertEmoji } from '../../store/emoji.ts'
import { CommandPalette } from '../CommandBar.tsx'
import { ClipboardPanel } from './ClipboardPanel.tsx'
import { ControlMenu, PowerCard } from './ControlMenu.tsx'
import { useShellCommands, windowLabel } from './shell-utils.ts'

type Mode = 'ask' | 'command' | 'applications' | 'menu' | 'power' | 'clipboard' | 'emoji'

const MODES = new Set<Mode>(['ask', 'command', 'applications', 'menu', 'power', 'clipboard', 'emoji'])
const WINDOW_WIDTH = 680
const MAX_HEIGHT = 560

export interface AskState {
  text: string
  context: WmWindow | null
  attachments: string[]
}

/**
 * Panels mode: one transparent overlay window (680 wide) niri centres over everything. The inbound
 * command picks what it shows: ask (about the focused window), the command palette, the launcher,
 * the Veritas OS menu, power actions, clipboard history or emoji. Escape (or losing focus) closes it.
 */
export function CommandSurface() {
  const [mode, setMode] = useState<Mode | null>(null)
  const [ask, setAsk] = useState<AskState>({ text: '', context: null, attachments: [] })
  // `herald-os menu <item>` (and the menu bar's update dot) open the control menu on one item.
  const [menuItem, setMenuItem] = useState<string | undefined>(undefined)
  const panelRef = useRef<HTMLDivElement>(null)

  useShellCommands((command: ShellCommand) => {
    if (command.type === 'payload') {
      return
    }

    if (command.type === 'ask' || (!MODES.has(command.type as Mode) && (command.text || command.context))) {
      setAsk({ text: command.text ?? '', context: command.context ?? null, attachments: command.attachments ?? [] })
      setMode('ask')

      return
    }

    if (MODES.has(command.type as Mode)) {
      setMenuItem(command.type === 'menu' ? command.args?.[0] : undefined)
      setMode(command.type as Mode)
    }
  })

  // Opened without a command (or the command was lost): behave like the command bar.
  useEffect(() => {
    const timer = window.setTimeout(() => setMode(current => current ?? 'command'), 250)

    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Panels that step back on Escape (nested menu levels) claim it with preventDefault.
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        closeThisSurface()
      }
    }
    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Hug the content: the transparent window shrinks to the panel so clicks outside reach other windows.
  useLayoutEffect(() => {
    const node = panelRef.current

    if (!node || typeof ResizeObserver === 'undefined') {
      return
    }

    let lastHeight = 0
    const fit = () => {
      const height = Math.min(MAX_HEIGHT, Math.ceil(node.getBoundingClientRect().height) + 4)

      if (height > 0 && height !== lastHeight) {
        lastHeight = height
        window.heraldOS.shell.resize(WINDOW_WIDTH, height).catch(() => undefined)
      }
    }
    const observer = new ResizeObserver(fit)
    observer.observe(node)
    fit()

    return () => observer.disconnect()
  }, [mode])

  const close = closeThisSurface

  if (!mode) {
    return null
  }

  return (
    <div className="flex h-full w-full items-start justify-center overflow-hidden text-fg">
      <div ref={panelRef} className="w-full">
        {mode === 'ask' && <AskPanel state={ask} onClose={close} />}
        {mode === 'command' && <CommandPalette standalone onClose={close} onApplications={() => setMode('applications')} className="w-full animate-pop" />}
        {mode === 'applications' && <ApplicationsPanel standalone onClose={close} className="h-[556px] w-full animate-pop" />}
        {mode === 'menu' && <ControlMenu onClose={close} onApplications={() => setMode('applications')} initialItem={menuItem} />}
        {mode === 'power' && <PowerCard onClose={close} />}
        {mode === 'clipboard' && <ClipboardPanel onClose={close} />}
        {mode === 'emoji' && <EmojiPicker onPick={char => void insertEmoji(char)} onClose={close} />}
      </div>
    </div>
  )
}

/** "Ask Hermes about this window": a prompt with the focused window as context, relayed to the Hermes window. */
export function AskPanel({ state, onClose }: { state: AskState; onClose: () => void }) {
  const [text, setText] = useState(state.text)
  const textarea = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    setText(state.text)
  }, [state.text])

  useEffect(() => {
    const node = textarea.current

    if (node) {
      node.focus()
      node.setSelectionRange(node.value.length, node.value.length)
    }
  }, [])

  const canSend = text.trim().length > 0 || state.attachments.length > 0

  const submit = () => {
    if (!canSend) {
      return
    }

    relayToMain({ type: 'send-prompt', text: text.trim(), context: state.context, attachments: state.attachments })
    openSurface('main')
    onClose()
  }

  return (
    <div className="float flex flex-col overflow-hidden rounded-2xl animate-pop">
      <div className="flex items-center gap-3 px-4 pt-4 pb-2">
        <HermesAvatar size={22} rounded={6} />
        <span className="text-[14px] font-semibold">Ask Hermes</span>
        <span className="flex-1" />
        <Kbd>esc</Kbd>
      </div>

      {(state.context || state.attachments.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-2">
          {state.context && (
            <Pill tone="accent" className="max-w-full">
              <IconAppWindow size={13} />
              <span className="truncate">{windowLabel(state.context)}</span>
              <span className="truncate text-fg-3">{state.context.appId}</span>
            </Pill>
          )}
          {state.attachments.map(path => (
            <Pill key={path} tone="muted" className="max-w-full">
              <IconPaperclip size={13} />
              <span className="truncate">{path.split('/').pop() || path}</span>
            </Pill>
          ))}
        </div>
      )}

      <div className="px-4 pb-3">
        <textarea
          ref={textarea}
          value={text}
          rows={3}
          onChange={event => setText(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
          placeholder={state.context ? `Ask about ${windowLabel(state.context)}` : state.attachments.length > 0 ? 'What would you like to know about it?' : 'Ask Hermes anything'}
          aria-label="Ask Hermes"
          className="glass-input w-full resize-none rounded-lg px-3 py-2.5 text-[14px] leading-relaxed outline-none placeholder:text-fg-4"
        />
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
        <span className="text-[11.5px] text-fg-4">
          <Kbd>↵</Kbd> send · <Kbd>⇧↵</Kbd> new line
        </span>
        <GlassButton variant="primary" size="sm" onClick={submit} disabled={!canSend}>
          Send to Hermes
        </GlassButton>
      </div>
    </div>
  )
}
