import { IconRefresh, IconSparkles } from '@tabler/icons-react'
import { useEffect, useRef } from 'react'
import { cn } from '../../lib/cn.ts'
import type { CanvasDocument } from './engine/document.ts'
import type { HistoryStep } from './engine/history.ts'
import { useRevision } from './hooks.ts'
import { Thumb } from './LayersPanel.tsx'
import { settleTools } from './tools/sessions.ts'

/*
 * The History panel: every step of the document's history by name, the opening state at the top.
 * A click goes back or forward to a step; steps after the current one stay listed, dimmed, until
 * a new edit drops them.
 */

const ORIGIN: Record<NonNullable<HistoryStep['origin']>, { title: string; icon: React.ReactNode }> = {
  command: { title: 'Made by Hermes or a command', icon: <IconSparkles size={12} /> },
  outside: { title: 'Changed outside the window (Hermes writing the project, a script, Compositor)', icon: <IconRefresh size={12} /> }
}

function Row({ label, current, undone, onClick, children }: { label: string; current: boolean; undone: boolean; onClick: () => void; children?: React.ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (current) {
      ref.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [current])

  return (
    <button
      ref={ref}
      type="button"
      role="option"
      aria-selected={current}
      onClick={onClick}
      className={cn('flex h-7 w-full shrink-0 items-center gap-2 px-3 text-left text-[12px]', current ? 'bg-accent/20 text-fg' : 'text-fg-2 hover:bg-white/6', undone && 'opacity-45')}
    >
      {children}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  )
}

export function HistoryPanel({ doc, header }: { doc: CanvasDocument; header?: React.ReactNode }) {
  useRevision(doc)
  const { history } = doc
  const steps = history.steps
  const applied = history.applied
  const goTo = (count: number) => {
    // A Free Transform or text being typed is put in first, as a step of its own.
    settleTools(doc)
    doc.goTo(count)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1.5 px-2 text-[11px] text-fg-3">
        {header}
        <span className="ml-auto pr-1 tabular-nums">{steps.length ? `${applied} of ${steps.length}` : ''}</span>
      </div>
      <div role="listbox" aria-label="History" className="min-h-0 flex-1 overflow-y-auto pb-1">
        <Row label={history.dropped ? 'Earliest state kept' : `${doc.name}: opening state`} current={applied === 0} undone={false} onClick={() => goTo(0)}>
          <Thumb raster={history.dropped ? null : doc.openingThumb} version={doc.openingThumb?.version ?? 0} size={20} />
        </Row>
        {history.dropped > 0 && <div className="px-3 py-1 text-[11px] text-fg-3">The {history.dropped === 1 ? 'oldest step was' : `${history.dropped} oldest steps were`} let go of to save memory.</div>}
        {steps.map((step, i) => (
          <Row key={step.id} label={step.label} current={applied === i + 1} undone={i + 1 > applied} onClick={() => goTo(i + 1)}>
            <span className="grid size-5 shrink-0 place-items-center text-fg-3" title={step.origin ? ORIGIN[step.origin].title : undefined}>
              {step.origin ? ORIGIN[step.origin].icon : <span className="size-1.5 rounded-full bg-current opacity-60" />}
            </span>
          </Row>
        ))}
        {!steps.length && <div className="px-3 py-2 text-[12px] text-fg-3">Each change you or Hermes make is listed here: click one to go back to it.</div>}
      </div>
    </div>
  )
}
