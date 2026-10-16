import { useStore } from '@nanostores/react'
import { memo, useCallback, useEffect, useRef } from 'react'
import { SurfaceErrorBoundary } from '../../components/error-boundary.tsx'
import { cn } from '../../lib/cn.ts'
import { $focusedWindowId, closeWindow, focusWindow, MAIN_WINDOW_ID, minimizeWindow, type OSWindow, setBounds, toggleMaximize } from '../../store/windows.ts'

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
const EDGES: Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
const EDGE_CLASS: Record<Edge, string> = {
  n: 'top-0 left-3 right-3 h-1.5 cursor-ns-resize',
  s: 'bottom-0 left-3 right-3 h-1.5 cursor-ns-resize',
  e: 'right-0 top-3 bottom-3 w-1.5 cursor-ew-resize',
  w: 'left-0 top-3 bottom-3 w-1.5 cursor-ew-resize',
  ne: 'top-0 right-0 size-3 cursor-nesw-resize',
  nw: 'top-0 left-0 size-3 cursor-nwse-resize',
  se: 'bottom-0 right-0 size-3 cursor-nwse-resize',
  sw: 'bottom-0 left-0 size-3 cursor-nesw-resize'
}

/**
 * A floating glass window. Drag on the titlebar, resize on the edges, focus on pointer-down.
 * Content stays mounted while minimized (visibility is not lifecycle).
 */
export const Window = memo(function Window({ win, children, chrome = true }: { win: OSWindow; children: React.ReactNode; chrome?: boolean }) {
  const focusedId = useStore($focusedWindowId)
  const focused = focusedId === win.id
  const frame = useRef<HTMLDivElement>(null)
  const gesture = useRef<{ kind: 'move' | 'resize'; edge?: Edge; startX: number; startY: number; start: OSWindow['bounds']; raf: number; pending: OSWindow['bounds'] | null } | null>(null)

  const onPointerMove = useCallback((event: PointerEvent) => {
    const g = gesture.current

    if (!g) {
      return
    }

    const dx = event.clientX - g.startX
    const dy = event.clientY - g.startY
    let next = { ...g.start }

    if (g.kind === 'move') {
      next = { ...g.start, x: g.start.x + dx, y: g.start.y + dy }
    } else if (g.edge) {
      if (g.edge.includes('e')) next.width = g.start.width + dx
      if (g.edge.includes('s')) next.height = g.start.height + dy
      if (g.edge.includes('w')) {
        next.x = g.start.x + dx
        next.width = g.start.width - dx
      }
      if (g.edge.includes('n')) {
        next.y = g.start.y + dy
        next.height = g.start.height - dy
      }
    }

    g.pending = next

    if (!g.raf) {
      g.raf = requestAnimationFrame(() => {
        if (gesture.current?.pending) {
          setBounds(win.id, gesture.current.pending)
        }

        if (gesture.current) {
          gesture.current.raf = 0
        }
      })
    }
  }, [win.id])

  const endGesture = useCallback(() => {
    const g = gesture.current
    gesture.current = null
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', endGesture)
    document.body.style.cursor = ''

    if (g?.pending) {
      setBounds(win.id, g.pending, true)
    }
  }, [onPointerMove, win.id])

  const startGesture = (event: React.PointerEvent, kind: 'move' | 'resize', edge?: Edge) => {
    if (event.button !== 0 || win.maximized && kind === 'resize') {
      return
    }

    focusWindow(win.id)
    gesture.current = { kind, edge, startX: event.clientX, startY: event.clientY, start: win.bounds, raf: 0, pending: null }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', endGesture)
    event.preventDefault()
  }

  useEffect(() => () => endGesture(), [endGesture])

  const hidden = win.phase === 'minimized'
  const main = win.id === MAIN_WINDOW_ID

  return (
    <div
      ref={frame}
      role="dialog"
      aria-label={win.title}
      data-window-id={win.id}
      onPointerDownCapture={() => {
        if (!focused) {
          focusWindow(win.id)
        }
      }}
      className={cn(
        'glass absolute flex flex-col overflow-hidden rounded-2xl',
        win.phase === 'opening' && 'window-enter',
        win.phase === 'closing' && 'window-leave',
        win.phase === 'minimizing' && 'window-minimize',
        hidden && 'invisible pointer-events-none',
        !focused && !hidden && 'opacity-95',
        focused ? 'border-line-strong' : 'border-line'
      )}
      style={{ left: win.bounds.x, top: win.bounds.y, width: win.bounds.width, height: win.bounds.height, zIndex: win.z, willChange: gesture.current ? 'left, top, width, height' : undefined }}
    >
      {chrome && (
        <div
          className="flex h-10 shrink-0 items-center gap-3 px-3 select-none"
          onPointerDown={event => {
            if ((event.target as HTMLElement).closest('button')) {
              return
            }

            if (!win.maximized || main) {
              startGesture(event, 'move')
            }
          }}
          onDoubleClick={() => toggleMaximize(win.id)}
        >
          <div className="group flex items-center gap-2">
            <TrafficLight color="#ff5f57" label={main ? 'Hide' : 'Close'} onClick={() => closeWindow(win.id)} glyph="×" />
            <TrafficLight color="#febc2e" label="Minimize" onClick={() => minimizeWindow(win.id)} glyph="–" />
            <TrafficLight color="#28c840" label="Zoom" onClick={() => toggleMaximize(win.id)} glyph="+" />
          </div>
          <div className={cn('min-w-0 flex-1 truncate text-center text-[12.5px] font-medium', focused ? 'text-fg' : 'text-fg-3')}>{win.title}</div>
          <div className="w-[62px]" />
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <SurfaceErrorBoundary label={win.title}>{children}</SurfaceErrorBoundary>
      </div>
      {!win.maximized &&
        EDGES.map(edge => <div key={edge} className={cn('absolute z-10', EDGE_CLASS[edge])} onPointerDown={event => startGesture(event, 'resize', edge)} />)}
    </div>
  )
})

function TrafficLight({ color, label, onClick, glyph }: { color: string; label: string; onClick: () => void; glyph: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={event => {
        event.stopPropagation()
        onClick()
      }}
      className="flex size-3 items-center justify-center rounded-full text-[9px] leading-none font-bold text-black/0 shadow-[inset_0_0_0_1px_rgba(0,0,0,.15)] transition-colors group-hover:text-black/60"
      style={{ background: color }}
    >
      {glyph}
    </button>
  )
}
