import { useStore } from '@nanostores/react'
import {
  IconAdjustmentsHorizontal,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconEye,
  IconEyeOff,
  IconFileText,
  IconFolderOpen,
  IconFolderPlus,
  IconLayoutGrid,
  IconList,
  IconMessage,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTerminal2
} from '@tabler/icons-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Chips, EmptyGlass, GlassButton, MoreButton, PageHeader, SearchField, Toggle } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import { revealLabel } from '../../lib/platform-labels.ts'
import { notify } from '../../store/notifications.ts'
import { $activeSpace } from '../../store/spaces.ts'
import { $page, showPage } from '../../store/windows.ts'
import { openInCanvas } from '../canvas/open.ts'
import { type CardAction, FileCard, FileRow, RenameField } from './FileCard.tsx'
import { FileDetail, PreviewOverlay } from './FileDetail.tsx'
import { FilesSidebar } from './FilesSidebar.tsx'
import {
  $canGoBack,
  $canGoForward,
  $home,
  $kindFilter,
  $location,
  $query,
  $root,
  $selectedPath,
  $showHidden,
  $viewMode,
  askHermesAbout,
  askHermesToFind,
  copyPath,
  createFolder,
  createTextFile,
  currentDir,
  ensureHome,
  type FileItem,
  filterItems,
  goBack,
  goForward,
  goUp,
  type KindFilter,
  type Location,
  looksLikeNaturalLanguage,
  messageOf,
  navigate,
  openItem,
  parentOf,
  refresh,
  renameItem,
  revealItem,
  trashItems,
  useListing
} from './files-store.ts'
import { Menu } from './Menu.tsx'

const KIND_FILTERS: readonly { id: KindFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'folders', label: 'Folders' },
  { id: 'images', label: 'Images' },
  { id: 'documents', label: 'Documents' }
]

interface Crumb {
  label: string
  location: Location
}

function buildCrumbs(location: Location | null, root: string | null, rootLabel: string, home: string | null): Crumb[] {
  if (!location || !root) {
    return []
  }

  const rootCrumb: Crumb = { label: rootLabel, location: { kind: 'dir', path: root } }

  if (location.kind === 'recent') {
    return [rootCrumb, { label: 'Recent', location }]
  }

  if (location.kind === 'favorites') {
    return [rootCrumb, { label: 'Favorites', location }]
  }

  let base: Crumb

  if (location.path === root || location.path.startsWith(`${root}/`)) {
    base = rootCrumb
  } else if (home && (location.path === home || location.path.startsWith(`${home}/`))) {
    base = { label: 'Home', location: { kind: 'dir', path: home } }
  } else {
    base = { label: 'Macintosh HD', location: { kind: 'dir', path: '/' } }
  }

  const basePath = base.location.kind === 'dir' ? base.location.path : '/'
  const rest = location.path.slice(basePath === '/' ? 1 : basePath.length + 1).split('/').filter(Boolean)
  const crumbs = [base]
  let current = basePath

  for (const segment of rest) {
    current = current === '/' ? `/${segment}` : `${current}/${segment}`
    crumbs.push({ label: segment === '.Trash' ? 'Trash' : segment, location: { kind: 'dir', path: current } })
  }

  return crumbs
}

function isTypingTarget(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null

  return Boolean(node && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.isContentEditable))
}

/** Dropped Finder files: Electron no longer exposes File.path, so this only works when the bridge adds it. */
function pathOfDroppedFile(file: File): string | null {
  const candidate = window.heraldOS.fs.pathForFile?.(file) || (file as File & { path?: string }).path

  return typeof candidate === 'string' && candidate.startsWith('/') ? candidate : null
}

export function FilesPage() {
  const page = useStore($page)
  const home = useStore($home)
  const root = useStore($root)
  const space = useStore($activeSpace)
  const location = useStore($location)
  const selectedPath = useStore($selectedPath)
  const viewMode = useStore($viewMode)
  const showHidden = useStore($showHidden)
  const kindFilter = useStore($kindFilter)
  const query = useStore($query)
  const canGoBack = useStore($canGoBack)
  const canGoForward = useStore($canGoForward)
  const listing = useListing()

  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [prompt, setPrompt] = useState<'folder' | 'file' | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [newMenu, setNewMenu] = useState(false)
  const [moreMenu, setMoreMenu] = useState(false)
  const [filterMenu, setFilterMenu] = useState(false)
  const [dropHint, setDropHint] = useState(false)
  const gridRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void ensureHome().catch(() => undefined)
  }, [])

  useEffect(() => {
    if (root && !$location.get()) {
      navigate({ kind: 'dir', path: root })
    }
  }, [root])

  useEffect(() => {
    if (listing.error) {
      notify({ title: 'Could not read this folder', body: listing.error, level: 'error' })
    }
  }, [listing.error])

  useEffect(() => {
    if (!filterMenu) {
      return
    }

    const onDown = (event: MouseEvent) => {
      if (!filterRef.current?.contains(event.target as Node)) {
        setFilterMenu(false)
      }
    }
    window.addEventListener('mousedown', onDown)

    return () => window.removeEventListener('mousedown', onDown)
  }, [filterMenu])

  const natural = looksLikeNaturalLanguage(query)
  const items = useMemo(() => filterItems(listing.data ?? [], { showHidden, kind: kindFilter, query: natural ? '' : query }), [listing.data, showHidden, kindFilter, query, natural])
  const selected = useMemo(() => items.find(item => item.path === selectedPath) ?? null, [items, selectedPath])
  const crumbs = useMemo(() => buildCrumbs(location, root, space.name, home), [location, root, space.name, home])
  const cwd = location?.kind === 'dir' ? location.path : null

  useEffect(() => {
    if (!selected) {
      setPreviewOpen(false)
    }
  }, [selected])

  const submitSearch = () => {
    const trimmed = query.trim()

    if (!trimmed) {
      return
    }

    if (natural) {
      askHermesToFind(trimmed)
      $query.set('')
    } else if (items.length > 0) {
      $selectedPath.set(items[0].path)
    }
  }

  const handleAction = useCallback(
    (item: FileItem, action: CardAction) => {
      switch (action) {
        case 'open':
          openItem(item)
          break
        case 'reveal':
          revealItem(item.path)
          break
        case 'rename':
          $selectedPath.set(item.path)
          setRenamingPath(item.path)
          break
        case 'copy-path':
          copyPath(item.path)
          break
        case 'trash':
          void trashItems([item])
          break
        case 'ask':
          askHermesAbout(item.path)
          break
        case 'edit-canvas':
          openInCanvas(item.path)
          break
      }
    },
    []
  )

  const commitRename = useCallback((item: FileItem, name: string) => {
    setRenamingPath(null)
    void renameItem(item, name)
  }, [])

  const openNewPrompt = (kind: 'folder' | 'file') => {
    if (!currentDir()) {
      notify({ title: 'Open a folder first', body: 'New items are created in the folder you are looking at.', level: 'warn' })

      return
    }

    setPrompt(kind)
  }

  const commitPrompt = (name: string) => {
    const dir = currentDir()
    setPrompt(null)

    if (!dir || !name.trim()) {
      return
    }

    void (prompt === 'folder' ? createFolder(dir, name) : createTextFile(dir, name))
  }

  // Keyboard: arrows move, Enter opens, Backspace goes up, Cmd+Backspace trashes, Space previews.
  useEffect(() => {
    if (page !== 'files') {
      return
    }

    const columns = () => {
      if (viewMode === 'list' || !gridRef.current) {
        return 1
      }

      return Math.max(1, getComputedStyle(gridRef.current).gridTemplateColumns.split(' ').filter(Boolean).length)
    }

    const onKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || renamingPath || prompt) {
        return
      }

      const index = selected ? items.indexOf(selected) : -1
      const move = (delta: number) => {
        if (items.length === 0) {
          return
        }

        const next = index < 0 ? 0 : Math.max(0, Math.min(items.length - 1, index + delta))
        $selectedPath.set(items[next].path)
        event.preventDefault()
        gridRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(items[next].path)}"]`)?.scrollIntoView({ block: 'nearest' })
      }

      switch (event.key) {
        case 'ArrowRight':
          move(1)
          break
        case 'ArrowLeft':
          move(-1)
          break
        case 'ArrowDown':
          move(columns())
          break
        case 'ArrowUp':
          move(-columns())
          break
        case 'Enter':
          if (selected) {
            event.preventDefault()
            setPreviewOpen(false)
            openItem(selected)
          }

          break
        case 'Backspace':
          event.preventDefault()

          if (event.metaKey) {
            if (selected) {
              void trashItems([selected])
            }
          } else {
            goUp()
          }

          break
        case ' ':
          if (selected) {
            event.preventDefault()
            setPreviewOpen(open => !open)
          }

          break
        case 'Escape':
          if (previewOpen) {
            setPreviewOpen(false)
          } else if (selected) {
            $selectedPath.set(null)
          }

          break
        default:
          break
      }
    }

    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [page, items, selected, viewMode, renamingPath, prompt, previewOpen])

  const onPageDrop = (event: React.DragEvent) => {
    setDropHint(false)

    if (event.dataTransfer.files.length === 0) {
      return
    }

    event.preventDefault()
    const paths = Array.from(event.dataTransfer.files)
      .map(pathOfDroppedFile)
      .filter((path): path is string => Boolean(path))

    if (paths.length === 0) {
      notify({ title: 'Cannot locate dropped files', body: 'Drop files from another Hermes window, or open their folder from the sidebar.', level: 'warn' })

      return
    }

    const parent = parentOf(paths[0])

    if (parent) {
      navigate({ kind: 'dir', path: parent })
      $selectedPath.set(paths[0])
    }
  }

  const listItems = items.map(item => {
    const props = {
      item,
      selected: item.path === selectedPath,
      renaming: renamingPath === item.path,
      onSelect: () => $selectedPath.set(item.path),
      onOpen: () => openItem(item),
      onAction: (action: CardAction) => handleAction(item, action),
      onRename: (name: string) => commitRename(item, name),
      onCancelRename: () => setRenamingPath(null)
    }

    return viewMode === 'grid' ? <FileCard key={item.path} {...props} /> : <FileRow key={item.path} {...props} />
  })

  return (
    <div
      className="relative flex h-full flex-col"
      onDragOver={event => {
        if (Array.from(event.dataTransfer.types).includes('Files')) {
          event.preventDefault()
          setDropHint(true)
        }
      }}
      onDragLeave={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDropHint(false)
        }
      }}
      onDrop={onPageDrop}
    >
      <PageHeader
        icon="files"
        title="Files"
        actions={
          <div ref={filterRef} className="relative">
            <SearchField
              value={query}
              onChange={value => $query.set(value)}
              onSubmit={submitSearch}
              placeholder="Find files or describe what you need"
              className="w-[420px]"
              trailing={
                <button type="button" aria-label="Filters" aria-expanded={filterMenu} onClick={() => setFilterMenu(open => !open)} className={cn('flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-white/8', kindFilter !== 'all' || showHidden ? 'text-accent-strong' : 'text-fg-3 hover:text-fg')}>
                  <IconAdjustmentsHorizontal size={15} />
                </button>
              }
            />
            {natural && query.trim() && (
              <div className="pointer-events-none absolute top-10 right-0 left-0 flex items-center gap-2 rounded-lg bg-accent-soft px-3 py-1.5 text-[11.5px] text-fg-2 animate-fade-in">
                <IconMessage size={13} className="shrink-0 text-accent-strong" />
                Press Enter to ask Hermes to find these files
              </div>
            )}
            {filterMenu && (
              <div className="float absolute top-11 right-0 z-30 flex w-72 flex-col gap-3 rounded-xl p-3 animate-pop">
                <div className="text-[11px] tracking-[0.08em] text-fg-3 uppercase">Show</div>
                <Chips items={KIND_FILTERS} value={kindFilter} onChange={value => $kindFilter.set(value)} />
                <div className="flex items-center justify-between gap-3 border-t border-line pt-3 text-[12.5px] text-fg-2">
                  Hidden files
                  <Toggle checked={showHidden} onChange={value => $showHidden.set(value)} label="Show hidden files" />
                </div>
              </div>
            )}
          </div>
        }
      />

      <div className="flex h-10 shrink-0 items-center gap-3 px-6 pb-2">
        <div className="flex h-8 items-center rounded-lg border border-line bg-white/6 p-0.5">
          <button type="button" aria-label="Back" disabled={!canGoBack} onClick={goBack} className="flex h-7 w-8 items-center justify-center rounded-md text-fg-2 hover:bg-white/8 hover:text-fg disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent">
            <IconChevronLeft size={16} />
          </button>
          <button type="button" aria-label="Forward" disabled={!canGoForward} onClick={goForward} className="flex h-7 w-8 items-center justify-center rounded-md text-fg-2 hover:bg-white/8 hover:text-fg disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent">
            <IconChevronRight size={16} />
          </button>
        </div>

        <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-[12.5px]">
          {crumbs.length === 0 && <span className="shimmer h-3.5 w-40 rounded" />}
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1

            return (
              <span key={`${index}-${crumb.label}`} className="flex min-w-0 items-center">
                {index > 0 && <IconChevronRight size={13} className="shrink-0 text-fg-4" />}
                <button type="button" aria-current={last ? 'location' : undefined} onClick={() => navigate(crumb.location)} className={cn('max-w-48 truncate rounded-md px-1.5 py-0.5 hover:bg-white/6 hover:text-fg', last ? 'text-fg' : 'text-fg-3')}>
                  {crumb.label}
                </button>
              </span>
            )
          })}
        </nav>

        <div className="flex h-8 items-center rounded-lg border border-line bg-white/6 p-0.5" role="group" aria-label="View">
          <button type="button" aria-label="Grid view" aria-pressed={viewMode === 'grid'} onClick={() => $viewMode.set('grid')} className={cn('flex h-7 w-8 items-center justify-center rounded-md transition-colors duration-120', viewMode === 'grid' ? 'bg-accent text-accent-fg shadow-[0_2px_10px_rgba(47,125,255,.45)]' : 'text-fg-2 hover:bg-white/8 hover:text-fg')}>
            <IconLayoutGrid size={15} />
          </button>
          <button type="button" aria-label="List view" aria-pressed={viewMode === 'list'} onClick={() => $viewMode.set('list')} className={cn('flex h-7 w-8 items-center justify-center rounded-md transition-colors duration-120', viewMode === 'list' ? 'bg-accent text-accent-fg shadow-[0_2px_10px_rgba(47,125,255,.45)]' : 'text-fg-2 hover:bg-white/8 hover:text-fg')}>
            <IconList size={15} />
          </button>
        </div>

        <div className="relative">
          <GlassButton size="sm" aria-haspopup="menu" aria-expanded={newMenu} onClick={() => setNewMenu(open => !open)}>
            <IconPlus />
            New
            <IconChevronDown className="text-fg-3" />
          </GlassButton>
          {newMenu && (
            <Menu
              onClose={() => setNewMenu(false)}
              className="top-9"
              items={[
                { id: 'folder', label: 'New folder', icon: <IconFolderPlus />, onSelect: () => openNewPrompt('folder') },
                { id: 'file', label: 'New text file', icon: <IconFileText />, onSelect: () => openNewPrompt('file') },
                { id: 'ask', label: 'Ask Hermes to create…', icon: <IconMessage />, onSelect: () => showPage('hermes'), dividerBefore: true }
              ]}
            />
          )}
        </div>

        <div className="relative">
          <MoreButton aria-label="More" aria-expanded={moreMenu} onClick={() => setMoreMenu(open => !open)} />
          {moreMenu && (
            <Menu
              onClose={() => setMoreMenu(false)}
              className="top-9"
              items={[
                { id: 'reveal', label: revealLabel(), icon: <IconFolderOpen />, disabled: !cwd, onSelect: () => cwd && revealItem(cwd) },
                {
                  id: 'terminal',
                  label: 'Open in Terminal',
                  icon: <IconTerminal2 />,
                  disabled: !cwd,
                  onSelect: () => cwd && window.heraldOS.fs.openIn('terminal', cwd).catch(error => notify({ title: 'Could not open Terminal', body: messageOf(error), level: 'error' }))
                },
                { id: 'hidden', label: showHidden ? 'Hide hidden files' : 'Show hidden files', icon: showHidden ? <IconEyeOff /> : <IconEye />, checked: showHidden, onSelect: () => $showHidden.set(!showHidden), dividerBefore: true },
                { id: 'refresh', label: 'Refresh', icon: <IconRefresh />, onSelect: refresh }
              ]}
            />
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-3 px-6 pb-5">
        <FilesSidebar />

        <div className="relative flex min-w-0 flex-1 flex-col">
          {prompt && (
            <div className="glass-card mb-3 flex items-center gap-3 rounded-xl px-3 py-2 animate-rise">
              <span className="shrink-0 text-fg-3">{prompt === 'folder' ? <IconFolderPlus size={16} /> : <IconFileText size={16} />}</span>
              <span className="shrink-0 text-[12.5px] text-fg-2">{prompt === 'folder' ? 'New folder' : 'New text file'}</span>
              <RenameField name={prompt === 'folder' ? 'Untitled folder' : 'Untitled.txt'} onCommit={commitPrompt} onCancel={() => setPrompt(null)} className="max-w-sm" commitOnBlur={false} />
              <GlassButton size="sm" variant="ghost" onClick={() => setPrompt(null)}>
                Cancel
              </GlassButton>
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto pr-1" onClick={event => event.target === event.currentTarget && $selectedPath.set(null)}>
            {listing.loading && !listing.data && (
              <div className={viewMode === 'grid' ? 'grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3' : 'flex flex-col gap-1'}>
                {Array.from({ length: 6 }, (_, index) => <div key={index} className={cn('shimmer rounded-xl', viewMode === 'grid' ? 'h-[196px]' : 'h-9')} />)}
              </div>
            )}

            {listing.data && items.length === 0 && !listing.error && (
              <EmptyGlass
                icon={query.trim() ? <IconSearch /> : <IconFolderOpen />}
                title={query.trim() ? `Nothing here matches “${query.trim()}”` : location?.kind === 'favorites' ? 'No favourites yet' : location?.kind === 'recent' ? 'No recent files' : 'Empty folder'}
                description={query.trim() ? 'Try a sentence like “find my screenshots from yesterday” to ask Hermes.' : location?.kind === 'favorites' ? 'Star a file or folder from its details to keep it here.' : undefined}
                action={query.trim() ? <GlassButton size="sm" onClick={() => askHermesToFind(query.trim())}>Ask Hermes to find it</GlassButton> : undefined}
                className="mt-2"
              />
            )}

            {listing.error && !listing.loading && <EmptyGlass icon={<IconFolderOpen />} title="Could not read this folder" description={listing.error} action={<GlassButton size="sm" onClick={listing.reload}>Try again</GlassButton>} className="mt-2" />}

            {items.length > 0 && (
              <div ref={gridRef} role="listbox" aria-label="Files" aria-multiselectable={false} className={cn(viewMode === 'grid' ? 'grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3 stagger' : 'flex flex-col gap-0.5', listing.loading && 'opacity-80 transition-opacity')}>
                {listItems}
              </div>
            )}
          </div>
        </div>

        {selected && <FileDetail item={selected} />}
      </div>

      {dropHint && (
        <div className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent-strong bg-accent-soft/40 text-[13px] text-fg animate-fade-in">Drop to reveal in Files</div>
      )}

      {previewOpen && selected && <PreviewOverlay item={selected} onClose={() => setPreviewOpen(false)} />}
    </div>
  )
}
