import { useStore } from '@nanostores/react'
import { IconBrain, IconPlus, IconSearchOff } from '@tabler/icons-react'
import { useEffect, useMemo, useState } from 'react'
import { Chips, EmptyGlass, GlassButton, PageHeader, SearchField } from '../../components/ui/glass.tsx'
import { $env } from '../../store/backend.ts'
import { notify } from '../../store/notifications.ts'
import { $sessions } from '../../store/sessions.ts'
import { AddMemoryForm } from './AddMemoryForm.tsx'
import { MemoryDetail } from './MemoryDetail.tsx'
import { MemoryMenu } from './MemoryMenu.tsx'
import { MemoryRow } from './MemoryRow.tsx'
import { $memory, $memoryFocus, addEntry, countRelatedSessions, forgetEntry, loadMemory, type MemoryEntry, type MemoryFile, type MemoryKind, memoryPath, updateEntry } from './memory-store.ts'
import { useMemoryToolset } from './use-memory-toolset.ts'

type Filter = 'all' | MemoryKind

const FILTERS: readonly { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'preference', label: 'Preferences' },
  { id: 'project', label: 'Projects' },
  { id: 'person', label: 'People' },
  { id: 'knowledge', label: 'Knowledge' }
]

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function MemoryPage() {
  const env = useStore($env)
  const memory = useStore($memory)
  const sessions = useStore($sessions)
  const toolset = useMemoryToolset()
  const hermesHome = env?.hermesHome ?? null

  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (hermesHome) {
      void loadMemory(hermesHome)
    }
  }, [hermesHome])

  // A command (voice, agent) asked the page to filter or select: follow it.
  const focus = useStore($memoryFocus)

  useEffect(() => {
    if (!focus) {
      return
    }

    if (focus.query !== undefined) {
      setQuery(focus.query)
      setFilter('all')
    }

    if (focus.entryId) {
      setSelectedId(focus.entryId)
    }
  }, [focus])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()

    return memory.entries.filter(entry => (filter === 'all' || entry.kind === filter) && (!needle || entry.text.toLowerCase().includes(needle)))
  }, [memory.entries, filter, query])

  const selected = filtered.find(entry => entry.id === selectedId) ?? filtered[0] ?? null
  const related = useMemo(() => (selected ? countRelatedSessions(selected, sessions) : 0), [selected, sessions])
  const editable = selected ? !(memory.files?.[selected.file]?.truncated ?? false) : false
  const loading = !hermesHome || (memory.loading && !memory.loaded)

  /** Run one write: optimistic in the store, honest re-read after, toast either way. */
  const mutate = async (done: string, failed: string, action: (home: string) => Promise<void>): Promise<boolean> => {
    if (!hermesHome || busy) {
      return false
    }

    setBusy(true)

    try {
      await action(hermesHome)
      notify({ title: done, level: 'success' })

      return true
    } catch (err) {
      notify({ title: failed, body: errorMessage(err), level: 'error' })

      return false
    } finally {
      setBusy(false)
    }
  }

  const save = (entry: MemoryEntry, text: string) => mutate('Memory updated', 'Could not update memory', home => updateEntry(home, entry, text))

  const forget = async (entry: MemoryEntry) => {
    const ok = await mutate('Memory forgotten', 'Could not forget memory', home => forgetEntry(home, entry))

    if (ok && selectedId === entry.id) {
      setSelectedId(null)
    }

    return ok
  }

  const add = async (file: MemoryFile, text: string) => {
    const result: { id: string | null } = { id: null }
    const ok = await mutate('Memory added', 'Could not add memory', async home => {
      result.id = await addEntry(home, file, text)
    })

    if (ok) {
      setAdding(false)
      setFilter('all')
      setQuery('')
      setSelectedId(result.id)
    }
  }

  const reload = () => {
    if (hermesHome) {
      void loadMemory(hermesHome).then(() => notify({ title: 'Memory reloaded', level: 'info', toast: false }))
    }
  }

  const openFile = (file: MemoryFile) => {
    if (!hermesHome) {
      return
    }

    void window.heraldOS.fs.openPath(memoryPath(hermesHome, file)).catch(err => notify({ title: `Could not open ${file}`, body: errorMessage(err), level: 'error' }))
  }

  const count = filtered.length

  return (
    <div className="flex h-full flex-col page-enter">
      <PageHeader
        icon="memory"
        title="Memory"
        subtitle="What Hermes knows, and why."
        actions={
          <>
            <GlassButton variant="primary" onClick={() => setAdding(true)} disabled={!hermesHome || adding}>
              <IconPlus />
              Add memory
            </GlassButton>
            <MemoryMenu onReload={reload} onOpenFile={openFile} disabled={!hermesHome} />
          </>
        }
      />

      <div className="flex flex-col gap-3 px-6 pb-4">
        <SearchField value={query} onChange={setQuery} placeholder="Search your memory…" />
        <div className="flex items-center justify-between gap-3">
          <Chips items={FILTERS} value={filter} onChange={setFilter} />
          <span className="shrink-0 text-[12px] text-fg-3 tabular-nums" aria-live="polite">
            {loading ? '' : `${count} ${count === 1 ? 'memory' : 'memories'}`}
          </span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-4 px-6 pb-6">
        <div className="min-w-0 flex-1 overflow-y-auto">
          {loading ? (
            <ListSkeleton />
          ) : memory.error ? (
            <EmptyGlass
              icon={<IconBrain />}
              title="Could not read memory"
              description={memory.error}
              action={
                <GlassButton size="sm" onClick={reload}>
                  Try again
                </GlassButton>
              }
            />
          ) : (
            <div className="flex flex-col gap-3 stagger">
              {adding && <AddMemoryForm onSave={(file, text) => void add(file, text)} onCancel={() => setAdding(false)} busy={busy} />}
              {filtered.map(entry => (
                <MemoryRow key={entry.id} entry={entry} selected={entry.id === selected?.id} onSelect={() => setSelectedId(entry.id)} />
              ))}
              {filtered.length === 0 && !adding && (
                memory.entries.length === 0 ? (
                  <EmptyGlass
                    icon={<IconBrain />}
                    title="Nothing remembered yet"
                    description="Hermes saves what matters as you work together. Add the first memory yourself, or just start a conversation."
                    action={
                      <GlassButton size="sm" variant="primary" onClick={() => setAdding(true)}>
                        <IconPlus />
                        Add memory
                      </GlassButton>
                    }
                  />
                ) : (
                  <EmptyGlass
                    icon={<IconSearchOff />}
                    title="No memories match"
                    description={query ? `Nothing mentions “${query.trim()}”${filter === 'all' ? '' : ' in this category'}.` : 'Nothing in this category yet.'}
                    action={
                      <GlassButton
                        size="sm"
                        onClick={() => {
                          setQuery('')
                          setFilter('all')
                        }}
                      >
                        Clear filters
                      </GlassButton>
                    }
                  />
                )
              )}
            </div>
          )}
        </div>

        {loading ? (
          <div className="w-[380px] shrink-0 rounded-xl shimmer" aria-hidden="true" />
        ) : (
          <MemoryDetail entry={selected} related={related} editable={editable} busy={busy} onSave={save} onForget={forget} onAdd={() => setAdding(true)} toolset={toolset} hasAny={memory.entries.length > 0} />
        )}
      </div>
    </div>
  )
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading memories">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="h-[66px] rounded-xl shimmer" />
      ))}
    </div>
  )
}
