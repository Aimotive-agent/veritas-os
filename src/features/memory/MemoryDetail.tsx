import { IconBrain, IconPencil, IconShieldCheck, IconTrash } from '@tabler/icons-react'
import { useState } from 'react'
import { EmptyGlass, GlassButton, GlassCard, KeyValue, Pill, Toggle } from '../../components/ui/glass.tsx'
import { formatRelative } from '../../lib/format.ts'
import { MemoryTile } from './memory-icons.tsx'
import { KIND_LABEL, type MemoryEntry } from './memory-store.ts'
import { formatShortDate } from './MemoryRow.tsx'
import type { MemoryToolsetState } from './use-memory-toolset.ts'

interface DetailProps {
  entry: MemoryEntry | null
  /** Sessions whose title/preview shares a keyword with the entry title. */
  related: number
  /** False when the source file was truncated on read; writing would lose data. */
  editable: boolean
  busy: boolean
  onSave: (entry: MemoryEntry, text: string) => Promise<boolean>
  onForget: (entry: MemoryEntry) => Promise<boolean>
  onAdd: () => void
  toolset: MemoryToolsetState
  hasAny: boolean
}

/** Right-hand detail card: one memory, its provenance, edit/forget, and the "pause memory" footer. */
export function MemoryDetail({ entry, related, editable, busy, onSave, onForget, onAdd, toolset, hasAny }: DetailProps) {
  return (
    <GlassCard className="flex w-[380px] shrink-0 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {entry ? (
          <DetailBody key={entry.id} entry={entry} related={related} editable={editable} busy={busy} onSave={onSave} onForget={onForget} />
        ) : (
          <EmptyGlass
            className="h-full min-h-60"
            icon={<IconBrain />}
            title={hasAny ? 'Select a memory' : 'Nothing remembered yet'}
            description={hasAny ? 'Pick an entry on the left to see where it came from and what it is used for.' : 'Hermes writes memories as you work together. You can also add one yourself.'}
            action={
              hasAny ? undefined : (
                <GlassButton size="sm" variant="primary" onClick={onAdd}>
                  Add memory
                </GlassButton>
              )
            }
          />
        )}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
        <div className="flex min-w-0 items-center gap-2 text-[12px] text-fg-3">
          <IconShieldCheck size={15} className="shrink-0" aria-hidden="true" />
          <span className="truncate">You control what Hermes remembers.</span>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <span className="text-[12px] text-fg-2">Pause memory</span>
          <Toggle checked={toolset.paused} onChange={value => void toolset.setPaused(value)} label="Pause memory" disabled={!toolset.known || toolset.busy} />
        </div>
      </div>
    </GlassCard>
  )
}

type Mode = 'view' | 'edit' | 'confirm'

function DetailBody({ entry, related, editable, busy, onSave, onForget }: Omit<DetailProps, 'entry' | 'onAdd' | 'toolset' | 'hasAny'> & { entry: MemoryEntry }) {
  const [mode, setMode] = useState<Mode>('view')
  const [draft, setDraft] = useState(entry.text)
  const trimmed = draft.trim()
  const changed = trimmed.length > 0 && trimmed !== entry.text

  const cancel = () => {
    setDraft(entry.text)
    setMode('view')
  }

  const save = async () => {
    if (!changed || busy) {
      return
    }

    if (await onSave(entry, trimmed)) {
      setMode('view')
    }
  }

  const forget = async () => {
    if (busy) {
      return
    }

    if (!(await onForget(entry))) {
      setMode('view')
    }
  }

  return (
    <div className="flex flex-col gap-5 animate-rise">
      <div className="flex items-start gap-4">
        <MemoryTile entry={entry} size={56} />
        <div className="min-w-0 flex-1 pt-0.5">
          <h2 className="selectable text-[18px] leading-tight font-semibold text-fg">{entry.title}</h2>
          <Pill tone="accent" className="mt-2">
            {KIND_LABEL[entry.kind]}
          </Pill>
        </div>
      </div>

      <KeyValue
        rows={[
          {
            label: 'Content',
            value:
              mode === 'edit' ? (
                <textarea
                  autoFocus
                  aria-label="Memory content"
                  value={draft}
                  disabled={busy}
                  onChange={event => setDraft(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault()
                      void save()
                    } else if (event.key === 'Escape') {
                      cancel()
                    }
                  }}
                  rows={6}
                  className="glass-input selectable w-full min-h-40 resize-y rounded-lg px-3 py-2.5 text-[12.5px] leading-relaxed text-fg outline-none disabled:opacity-60"
                />
              ) : (
                <div className="whitespace-pre-wrap break-words leading-relaxed">{entry.text}</div>
              )
          }
        ]}
      />

      <div className="h-px bg-line" />

      <KeyValue
        rows={[
          { label: 'Source', value: `${entry.file} · ${formatShortDate(entry.date)}` },
          { label: 'Last updated', value: formatRelative(entry.fileModifiedAt) || '—' },
          { label: 'Used in', value: related > 0 ? `${related} recent conversation${related === 1 ? '' : 's'}` : '—' }
        ]}
      />

      {mode === 'confirm' ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2.5 animate-rise" role="alertdialog" aria-label="Forget this memory?">
          <span className="text-[12.5px] text-fg">Forget this memory?</span>
          <div className="flex items-center gap-2">
            <GlassButton size="sm" onClick={() => setMode('view')} disabled={busy}>
              Cancel
            </GlassButton>
            <GlassButton size="sm" variant="danger" onClick={() => void forget()} disabled={busy}>
              Forget
            </GlassButton>
          </div>
        </div>
      ) : mode === 'edit' ? (
        <div className="flex items-center gap-2">
          <GlassButton variant="primary" className="flex-1" disabled={!changed || busy} onClick={() => void save()}>
            Save
          </GlassButton>
          <GlassButton onClick={cancel} disabled={busy}>
            Cancel
          </GlassButton>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <GlassButton variant="primary" className="flex-1" disabled={!editable || busy} onClick={() => setMode('edit')}>
            <IconPencil />
            Edit memory
          </GlassButton>
          <GlassButton variant="danger" disabled={!editable || busy} onClick={() => setMode('confirm')}>
            <IconTrash />
            Forget
          </GlassButton>
        </div>
      )}

      {!editable && <div className="text-[12px] text-fg-3">This file is too large to edit safely from here. Open it in an editor from the header menu instead.</div>}
    </div>
  )
}
