import { IconChevronDown, IconChevronRight, IconFile, IconFolder } from '@tabler/icons-react'
import { useEffect, useMemo, useState } from 'react'
import type { TreeEntry } from '../../../shared/ipc.ts'
import { cn } from '../../lib/cn.ts'
import type { StudioFile } from '../../lib/studio-model.ts'

interface Node {
  name: string
  path: string
  kind: 'file' | 'directory'
  children: Node[]
}

function buildTree(root: string, entries: TreeEntry[]): Node[] {
  const top: Node = { name: '', path: root, kind: 'directory', children: [] }
  const byPath = new Map<string, Node>([[root, top]])
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path))

  for (const entry of sorted) {
    const parentPath = entry.path.slice(0, entry.path.lastIndexOf('/'))
    const parent = byPath.get(parentPath)

    if (!parent) {
      continue
    }

    const node: Node = { name: entry.path.slice(parentPath.length + 1), path: entry.path, kind: entry.kind, children: [] }
    parent.children.push(node)

    if (entry.kind === 'directory') {
      byPath.set(entry.path, node)
    }
  }

  const order = (nodes: Node[]) => {
    nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.kind === 'directory' ? -1 : 1))
    nodes.forEach(n => order(n.children))
  }
  order(top.children)

  return top.children
}

const MARK: Partial<Record<StudioFile['status'], { label: string; className: string }>> = {
  writing: { label: '●', className: 'text-accent-strong animate-pulse-soft' },
  editing: { label: '●', className: 'text-accent-strong animate-pulse-soft' },
  written: { label: 'A', className: 'text-ok' },
  edited: { label: 'M', className: 'text-warn' },
  failed: { label: '!', className: 'text-danger' }
}

/** The project folder, with what Hermes just created or changed marked beside each file. */
export function FileTree({ root, files, activeFile, revision, onOpen }: { root: string; files: Record<string, StudioFile>; activeFile: string | null; revision: number; onOpen: (path: string) => void }) {
  const [entries, setEntries] = useState<TreeEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      window.heraldOS.fs
        .listTree(root)
        .then(result => {
          if (!cancelled) {
            setEntries(result.entries)
            setError(null)
          }
        })
        .catch(err => !cancelled && setError(err instanceof Error ? err.message : String(err)))
    }, 250)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [root, revision])

  const tree = useMemo(() => buildTree(root, entries), [root, entries])

  if (error) {
    return <div className="p-3 text-[12px] text-fg-3">{error}</div>
  }

  if (tree.length === 0) {
    return <div className="p-3 text-[12px] text-fg-3">The folder is empty. Files appear here as Hermes creates them.</div>
  }

  const toggle = (path: string) => {
    const next = new Set(collapsed)

    if (next.has(path)) {
      next.delete(path)
    } else {
      next.add(path)
    }

    setCollapsed(next)
  }

  const render = (nodes: Node[], depth: number): React.ReactNode =>
    nodes.map(node => {
      const mark = MARK[files[node.path]?.status ?? 'changed']
      const open = !collapsed.has(node.path)

      return (
        <div key={node.path}>
          <button
            type="button"
            onClick={() => (node.kind === 'directory' ? toggle(node.path) : onOpen(node.path))}
            className={cn('flex w-full items-center gap-1.5 rounded-md py-[3px] pr-2 text-left text-[12.5px] text-fg-2 hover:bg-white/6 hover:text-fg', activeFile === node.path && 'bg-accent-soft text-fg')}
            style={{ paddingLeft: 8 + depth * 12 }}
            title={node.path}
          >
            {node.kind === 'directory' ? (
              <>
                {open ? <IconChevronDown size={12} className="shrink-0 text-fg-4" /> : <IconChevronRight size={12} className="shrink-0 text-fg-4" />}
                <IconFolder size={14} className="shrink-0 text-fg-3" />
              </>
            ) : (
              <IconFile size={14} className="ml-[18px] shrink-0 text-fg-3" />
            )}
            <span className="min-w-0 flex-1 truncate">{node.name}</span>
            {node.kind === 'file' && mark && <span className={cn('shrink-0 text-[10.5px] font-semibold', mark.className)}>{mark.label}</span>}
          </button>
          {node.kind === 'directory' && open && render(node.children, depth + 1)}
        </div>
      )
    })

  return <div className="py-1.5">{render(tree, 0)}</div>
}
