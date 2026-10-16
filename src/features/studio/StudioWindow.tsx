import { useStore } from '@nanostores/react'
import { IconExternalLink, IconMessage, IconPlayerStopFilled, IconSend } from '@tabler/icons-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { StatusDot } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import { $chats, interruptChat, openStoredSession, sendPrompt } from '../../store/chat.ts'
import { isPanels } from '../../store/shell.ts'
import { $todos } from '../../store/missions.ts'
import { $studios, focusStudioFile, studioFor, watchStudioFolder } from '../../store/studio.ts'
import { openApp, type OSWindow } from '../../store/windows.ts'
import { CodeView } from './CodeView.tsx'
import { FileTree } from './FileTree.tsx'
import { openInEditor } from './open-in-editor.ts'
import { PreviewPane } from './PreviewPane.tsx'
import { TerminalPane } from './TerminalPane.tsx'

/** A drag handle between two panes; reports the pointer's movement in pixels. */
function Splitter({ axis, onDrag }: { axis: 'x' | 'y'; onDrag: (delta: number) => void }) {
  const start = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    let last = axis === 'x' ? event.clientX : event.clientY
    const move = (e: PointerEvent) => {
      const now = axis === 'x' ? e.clientX : e.clientY
      onDrag(now - last)
      last = now
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return <div role="separator" aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'} onPointerDown={start} className={cn('shrink-0 bg-line/60 hover:bg-accent/60', axis === 'x' ? 'w-px cursor-col-resize px-[2px] bg-clip-content' : 'h-px cursor-row-resize py-[2px] bg-clip-content')} />
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/**
 * Watch Hermes build: the project's files, the file being written with its changes marked, the
 * commands and dev-server output, and the running site, side by side for one session.
 */
export function StudioWindow({ win }: { win: OSWindow }) {
  const requested = typeof win.payload?.sessionId === 'string' ? win.payload.sessionId : null
  const storedSessionId = typeof win.payload?.storedSessionId === 'string' ? win.payload.storedSessionId : null
  const studios = useStore($studios)
  const chats = useStore($chats)
  const [attached, setAttached] = useState<string | null>(null)
  // In panels mode the Studio is its own renderer: resume the session here to receive its events.
  const sessionId = requested && chats[requested] ? requested : attached ?? (storedSessionId ? null : requested)

  useEffect(() => {
    if (!requested || $chats.get()[requested] || !storedSessionId) {
      return
    }

    let cancelled = false
    void openStoredSession(storedSessionId)
      .then(chat => !cancelled && setAttached(chat.sessionId))
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [requested, storedSessionId])
  const todos = useStore($todos)
  const [pinned, setPinned] = useState<string | null>(null)
  const [treeWidth, setTreeWidth] = useState(isPanels ? 170 : 220)
  const [previewWidth, setPreviewWidth] = useState(0.42)
  const [terminalHeight, setTerminalHeight] = useState(0.34)
  const [draft, setDraft] = useState('')
  const body = useRef<HTMLDivElement>(null)
  const center = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (sessionId) {
      studioFor(sessionId)
    }
  }, [sessionId])

  const studio = sessionId ? studios[sessionId] : undefined
  const chat = sessionId ? chats[sessionId] : undefined
  const root = studio?.cwd ?? chat?.info.cwd ?? null

  useEffect(() => (sessionId && root ? watchStudioFolder(sessionId, root) : undefined), [sessionId, root])

  const shownFile = pinned ?? studio?.activeFile ?? null
  const files = studio?.files ?? {}

  // Static sites preview their own index.html until Hermes starts (or names) a server.
  const staticIndex = root ? `${root}/index.html` : null
  const [indexOnDisk, setIndexOnDisk] = useState(false)

  // A Studio opened on an existing project (or after a reload) has no write events for index.html.
  useEffect(() => {
    if (!root) {
      return
    }

    let cancelled = false
    window.heraldOS.fs
      .readDir(root)
      .then(entries => !cancelled && setIndexOnDisk(entries.some(entry => entry.name === 'index.html' && entry.kind === 'file')))
      .catch(() => !cancelled && setIndexOnDisk(false))

    return () => {
      cancelled = true
    }
  }, [root, studio?.revision])

  const hasIndex = Boolean(staticIndex && ((files[staticIndex] && files[staticIndex].status !== 'writing' && files[staticIndex].status !== 'failed') || (!files[staticIndex] && indexOnDisk)))
  const previewTarget = studio?.previewUrl ?? (hasIndex ? staticIndex : null)
  const contentKey = useMemo(() => Object.values(files).reduce((latest, file) => (file.status === 'written' || file.status === 'edited' || file.status === 'changed' ? Math.max(latest, file.updatedAt) : latest), 0), [files])

  const plan = sessionId ? todos[sessionId]?.todos ?? [] : []
  const done = plan.filter(t => t.status === 'completed').length
  const running = Boolean(chat?.streaming || studio?.running)
  const status = studio?.status || (running ? 'Working…' : plan.length && done === plan.length ? 'Done' : 'Idle')

  if (!sessionId) {
    return <div className="flex h-full items-center justify-center text-[13px] text-fg-3">{storedSessionId ? 'Opening the session…' : 'This Studio is not attached to a Hermes session.'}</div>
  }

  const send = () => {
    const text = draft.trim()

    if (text) {
      setDraft('')
      void sendPrompt(text, { sessionId })
    }
  }

  const dragTree = (delta: number) => setTreeWidth(width => clamp(width + delta, 140, 420))
  const dragPreview = (delta: number) => {
    const total = body.current?.clientWidth ?? 1
    setPreviewWidth(fraction => clamp(fraction - delta / total, 0.2, 0.7))
  }
  const dragTerminal = (delta: number) => {
    const total = center.current?.clientHeight ?? 1
    setTerminalHeight(fraction => clamp(fraction - delta / total, 0.12, 0.75))
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-line px-3">
        <StatusDot tone={running ? 'accent' : 'ok'} pulse={running} />
        <div className="min-w-0 max-w-[40%]">
          <div className="truncate text-[12.5px] text-fg">{chat?.title || root?.split('/').pop() || 'Studio'}</div>
          <div className="truncate text-[11px] text-fg-3">{status}</div>
        </div>
        {plan.length > 0 && (
          <div className="flex shrink-0 items-center gap-2 text-[11px] text-fg-3" title={plan.map(t => `${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '→' : '·'} ${t.content}`).join('\n')}>
            <div className="h-1 w-20 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.round((done / plan.length) * 100)}%` }} />
            </div>
            {done}/{plan.length}
          </div>
        )}
        <form
          className="glass-input ml-auto flex h-7 min-w-0 max-w-md flex-1 items-center gap-1.5 rounded-lg pl-2.5 pr-1"
          onSubmit={event => {
            event.preventDefault()
            send()
          }}
        >
          <input value={draft} onChange={event => setDraft(event.target.value)} placeholder="Ask for a change, or just say it" className="min-w-0 flex-1 bg-transparent text-[12px] text-fg outline-none placeholder:text-fg-4" aria-label="Ask Hermes for a change" />
          <button type="submit" disabled={!draft.trim()} className="flex size-5 items-center justify-center rounded-md text-fg-3 hover:text-fg disabled:opacity-40" aria-label="Send">
            <IconSend size={13} />
          </button>
        </form>
        {running && (
          <button type="button" onClick={() => void interruptChat(sessionId)} className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-danger/15 px-2.5 text-[12px] text-danger hover:bg-danger/25">
            <IconPlayerStopFilled size={12} /> Stop
          </button>
        )}
        <button type="button" onClick={() => openApp('chat-popout', { payload: { sessionId: chat?.storedSessionId ?? sessionId }, title: chat?.title || 'Hermes' })} className="flex size-7 shrink-0 items-center justify-center rounded-lg text-fg-3 hover:bg-white/8 hover:text-fg" title="Open the conversation" aria-label="Open the conversation">
          <IconMessage size={15} />
        </button>
        {root && (
          <button type="button" onClick={() => openInEditor(root)} className="flex size-7 shrink-0 items-center justify-center rounded-lg text-fg-3 hover:bg-white/8 hover:text-fg" title="Open the project in an editor" aria-label="Open the project in an editor">
            <IconExternalLink size={15} />
          </button>
        )}
      </div>

      <div ref={body} className="flex min-h-0 flex-1">
        <div className="min-h-0 shrink-0 overflow-auto" style={{ width: treeWidth }}>
          {root ? <FileTree root={root} files={files} activeFile={shownFile} revision={studio?.revision ?? 0} onOpen={path => (setPinned(path), focusStudioFile(sessionId, path))} /> : <div className="p-3 text-[12px] text-fg-3">No project folder yet.</div>}
        </div>
        <Splitter axis="x" onDrag={dragTree} />
        <div ref={center} className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <CodeView path={shownFile} file={shownFile ? files[shownFile] : undefined} root={root} pinned={Boolean(pinned)} onTogglePin={() => setPinned(pinned ? null : shownFile)} running={running} generating={studio?.generating ?? null} />
          </div>
          {/* Panels mode: the compositor shows the preview as its own window; keep just its controls here. */}
          {isPanels && (
            <div className="shrink-0 border-t border-line">
              <PreviewPane win={win} target={previewTarget} root={root} contentKey={contentKey} compact />
            </div>
          )}
          <Splitter axis="y" onDrag={dragTerminal} />
          <div className="min-h-0 shrink-0" style={{ height: `${terminalHeight * 100}%` }}>
            <TerminalPane commands={studio?.commands ?? []} processes={studio?.processes ?? {}} />
          </div>
        </div>
        {!isPanels && (
          <>
            <Splitter axis="x" onDrag={dragPreview} />
            <div className="min-h-0 shrink-0" style={{ width: `${previewWidth * 100}%` }}>
              <PreviewPane win={win} target={previewTarget} root={root} contentKey={contentKey} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
