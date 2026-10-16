import { useStore } from '@nanostores/react'
import { IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand, IconPlus } from '@tabler/icons-react'
import { useRef, useState } from 'react'
import { AppGlyph, HermesAvatar } from '../components/app-icon.tsx'
import { cn } from '../lib/cn.ts'
import { shortcutLabel } from '../lib/platform-labels.ts'
import { $sidebar, SIDEBAR_COLLAPSED, SIDEBAR_MAX, SIDEBAR_MIN, SIDEBAR_SNAP, setSidebarCollapsed, setSidebarWidth, toggleSidebar } from '../store/sidebar.ts'
import { $activeSpace, $spaces, addSpace, setActiveSpace } from '../store/spaces.ts'
import { $page, showPage } from '../store/windows.ts'
import { $agentPages, agentPageId, bindAgentPages } from '../store/agent-pages.ts'
import { PAGES } from './apps.ts'

/** The persistent left rail of the main Hermes window: identity, pages, spaces. Resizable; collapses to icons. */
export function Sidebar() {
  bindAgentPages()
  const page = useStore($page)
  const agentPages = useStore($agentPages)
  const spaces = useStore($spaces)
  const active = useStore($activeSpace)
  const { width, collapsed } = useStore($sidebar)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ startX: number; startWidth: number; wasCollapsed: boolean } | null>(null)

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return
    }

    event.preventDefault()
    drag.current = { startX: event.clientX, startWidth: collapsed ? SIDEBAR_COLLAPSED : width, wasCollapsed: collapsed }
    setDragging(true)

    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Synthetic pointers (tests) cannot be captured; moves still arrive while over the handle.
    }
  }

  const moveResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current

    if (!state) {
      return
    }

    const next = state.startWidth + (event.clientX - state.startX)

    if (next < SIDEBAR_SNAP) {
      setSidebarCollapsed(true)
    } else {
      // Leaving the collapsed rail: start from the minimum so the label column does not jump in at 92px.
      setSidebarWidth(Math.max(SIDEBAR_MIN, next))
    }
  }

  const endResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) {
      return
    }

    drag.current = null
    setDragging(false)

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const renderPageButton = (def: (typeof PAGES)[number]) => {
    const activePage = def.id === page

    return (
      <button
        key={def.id}
        type="button"
        onClick={() => showPage(def.id)}
        aria-current={activePage ? 'page' : undefined}
        aria-label={collapsed ? def.name : undefined}
        className={cn(
          'side-item group relative flex h-8 items-center rounded-lg text-[12.5px] transition-colors duration-150',
          collapsed ? 'w-9 justify-center' : 'gap-2.5 px-2.5',
          activePage ? 'bg-accent text-accent-fg shadow-[0_4px_16px_rgba(47,125,255,.45)]' : 'text-fg-2 hover:bg-white/8 hover:text-fg'
        )}
      >
        <AppGlyph id={def.icon} size={16} stroke={1.9} className={activePage ? 'text-accent-fg' : 'text-fg-2 group-hover:text-fg'} />
        {collapsed ? <span className="side-tip">{def.name}</span> : <span className="truncate">{def.name}</span>}
      </button>
    )
  }

  return (
    <aside
      className={cn('relative flex shrink-0 flex-col pt-4 pb-3 select-none', collapsed ? 'items-center px-2' : 'px-3', !dragging && 'transition-[width] duration-200 ease-(--ease-out)')}
      style={{ width: collapsed ? SIDEBAR_COLLAPSED : width }}
      data-collapsed={collapsed || undefined}
    >
      <div className={cn(collapsed ? 'flex justify-center' : 'px-1')}>
        <HermesAvatar size={collapsed ? 36 : 44} rounded={collapsed ? 9 : 11} />
        {!collapsed && (
          <>
            <div className="mt-2.5 text-[15px] font-semibold leading-tight text-fg">Hermes</div>
            <div className="mt-0.5 text-[11px] leading-snug text-fg-3 italic">A more capable you. Always.</div>
          </>
        )}
      </div>

      <nav className={cn('relative mt-5 flex flex-col gap-0.5', collapsed && 'w-full items-center')} aria-label="Pages">
        {PAGES.filter(def => def.id === 'overview' || def.id === 'hermes').map(renderPageButton)}

        {/* Connected agents sit with Hermes, not at the bottom of the list. */}
        {agentPages.map(agent => {
          const id = agentPageId(agent.id)
          const activePage = id === page

          return (
            <button
              key={id}
              type="button"
              onClick={() => showPage(id)}
              aria-current={activePage ? 'page' : undefined}
              aria-label={collapsed ? agent.name : undefined}
              title={collapsed ? undefined : `${agent.name} — ${agent.phase}`}
              className={cn(
                'side-item group relative flex h-8 items-center rounded-lg text-[12.5px] transition-colors duration-150',
                collapsed ? 'w-9 justify-center' : 'gap-2.5 px-2.5',
                activePage ? 'bg-accent text-accent-fg shadow-[0_4px_16px_rgba(47,125,255,.45)]' : 'text-fg-2 hover:bg-white/8 hover:text-fg'
              )}
            >
              <AppGlyph id="agents" size={16} stroke={1.9} className={activePage ? 'text-accent-fg' : 'text-fg-2 group-hover:text-fg'} />
              {collapsed ? <span className="side-tip">{agent.name}</span> : <span className="truncate">{agent.name}</span>}
              {!collapsed && agent.phase !== 'ready' ? <span className="ml-auto text-[10.5px] text-fg-3">{agent.phase}</span> : null}
            </button>
          )
        })}

        {PAGES.filter(def => def.id !== 'overview' && def.id !== 'hermes').map(renderPageButton)}
      </nav>

      <div className={cn('my-4 h-px bg-line', collapsed ? 'w-6' : 'mx-1')} />

      {collapsed ? (
        <div className="flex w-full flex-col items-center gap-1">
          {spaces.map(space => {
            const on = space.id === active.id

            return (
              <button
                key={space.id}
                type="button"
                onClick={() => setActiveSpace(space.id)}
                aria-label={`${space.name} space`}
                aria-pressed={on}
                className={cn('side-item group relative flex size-7 items-center justify-center rounded-lg transition-colors duration-150', on ? 'bg-white/14' : 'hover:bg-white/8')}
              >
                <span className={cn('rounded-full shadow-[0_0_8px_currentColor] transition-[width,height]', on ? 'size-2.5' : 'size-2')} style={{ background: space.color, color: space.color }} />
                <span className="side-tip">{space.name}</span>
              </button>
            )
          })}
          <button
            type="button"
            aria-label="Add space"
            onClick={() => {
              setSidebarCollapsed(false)
              setAdding(true)
            }}
            className="side-item group relative flex size-7 items-center justify-center rounded-lg text-fg-3 hover:bg-white/10 hover:text-fg"
          >
            <IconPlus size={13} />
            <span className="side-tip">Add space</span>
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between px-2">
            <span className="text-[10px] font-semibold tracking-[0.14em] text-fg-3 uppercase">Spaces</span>
            <button type="button" aria-label="Add space" onClick={() => setAdding(true)} className="flex size-5 items-center justify-center rounded text-fg-3 hover:bg-white/10 hover:text-fg">
              <IconPlus size={13} />
            </button>
          </div>
          <div className="mt-1.5 flex flex-col gap-0.5">
            {spaces.map(space => {
              const on = space.id === active.id

              return (
                <button
                  key={space.id}
                  type="button"
                  onClick={() => setActiveSpace(space.id)}
                  className={cn('flex h-7 items-center gap-2.5 rounded-lg px-2.5 text-[12.5px] transition-colors duration-150', on ? 'bg-white/14 text-fg' : 'text-fg-2 hover:bg-white/8 hover:text-fg')}
                >
                  <span className="size-2 shrink-0 rounded-full shadow-[0_0_8px_currentColor]" style={{ background: space.color, color: space.color }} />
                  <span className="truncate">{space.name}</span>
                </button>
              )
            })}
            {adding && (
              <input
                autoFocus
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onBlur={() => {
                  setAdding(false)
                  setDraft('')
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && draft.trim()) {
                    addSpace(draft.trim())
                    setAdding(false)
                    setDraft('')
                  }

                  if (e.key === 'Escape') {
                    setAdding(false)
                    setDraft('')
                  }
                }}
                placeholder="New space"
                className="glass-input mt-1 h-7 rounded-lg px-2.5 text-[12.5px] outline-none"
              />
            )}
          </div>
        </>
      )}

      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        title={`${collapsed ? 'Expand' : 'Collapse'} sidebar (${shortcutLabel('\\')})`}
        className={cn('side-item group relative mt-auto flex h-8 items-center rounded-lg text-fg-3 transition-colors duration-150 hover:bg-white/8 hover:text-fg', collapsed ? 'w-9 justify-center' : 'gap-2.5 px-2.5 text-[12px]')}
      >
        {collapsed ? <IconLayoutSidebarLeftExpand size={16} stroke={1.9} /> : <IconLayoutSidebarLeftCollapse size={16} stroke={1.9} />}
        {collapsed ? <span className="side-tip">Expand sidebar</span> : <span>Collapse</span>}
      </button>

      {/* Resize handle: drag to resize, drag past the snap point to collapse, double-click to toggle. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={SIDEBAR_MAX}
        aria-valuenow={collapsed ? SIDEBAR_COLLAPSED : width}
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onDoubleClick={toggleSidebar}
        className={cn('side-handle absolute top-3 -right-1 bottom-3 w-2 cursor-col-resize', dragging && 'is-dragging')}
      />
    </aside>
  )
}
