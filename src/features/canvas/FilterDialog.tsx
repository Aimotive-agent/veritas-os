import { IconArrowsShuffle } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { GlassButton } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import { Modal } from './dialogs.tsx'
import { checkFilter, FILTER_DEFAULTS, FILTER_FIELDS, FILTER_NAMES, type FilterField, type FilterKind, type FilterSpec } from './engine/filters.ts'
import { applyFilterToDocument, type FilterTask, type PreviewBase, previewBase, previewState } from './filter-run.ts'
import type { CanvasDocument } from './engine/document.ts'
import { $dialog } from './menus.ts'
import { notify } from './store.ts'

/*
 * A filter's dialog: its settings, previewed on the canvas as they change (on a reduced copy of a
 * large layer, which the dialog says), and OK applies it at full size as one undoable step.
 */

/** The settings each filter was last used with, so the dialog opens where the person left it. */
const remembered = new Map<FilterKind, Record<string, number | boolean>>()

const PREVIEW_DELAY = 120

function FieldRow({ name, field, value, onChange }: { name: string; field: FilterField; value: number; onChange: (value: number) => void }) {
  const toSlider = (v: number) => {
    const t = (v - field.min) / (field.max - field.min)

    return Math.round((field.curve === 'square' ? Math.sqrt(t) : t) * 1000)
  }
  const fromSlider = (p: number) => {
    const t = p / 1000
    const raw = field.min + (field.max - field.min) * (field.curve === 'square' ? t * t : t)

    return Math.round(raw / field.step) * field.step
  }

  return (
    <label className="grid grid-cols-[7rem_1fr_5rem] items-center gap-3 text-[12px] text-fg-2">
      {field.label}
      <input type="range" aria-label={`${field.label} slider`} min={0} max={1000} value={toSlider(value)} onChange={(event) => onChange(fromSlider(Number(event.target.value)))} className="accent-(--color-accent)" />
      <span className="flex items-center gap-1">
        <input
          aria-label={name}
          type="number"
          min={field.min}
          max={field.max}
          step={field.step}
          value={Number(value.toFixed(field.step < 1 ? 1 : 0))}
          onChange={(event) => {
            const number = Number(event.target.value)

            if (event.target.value !== '' && Number.isFinite(number) && number >= field.min && number <= field.max) {
              onChange(number)
            }
          }}
          className="glass-input h-6 w-14 rounded-md px-1.5 text-right text-[12px] text-fg tabular-nums outline-none"
        />
        <span className="text-[11px] text-fg-3">{field.unit}</span>
      </span>
    </label>
  )
}

export function FilterDialog({ doc, kind }: { doc: CanvasDocument; kind: FilterKind }) {
  const [settings, setSettings] = useState<Record<string, number | boolean>>(() => ({ ...(FILTER_DEFAULTS[kind] as unknown as Record<string, number | boolean>), ...remembered.get(kind) }))
  const [preview, setPreview] = useState(true)
  const [phase, setPhase] = useState<'idle' | 'previewing' | 'applying'>('idle')
  const base = useRef<PreviewBase | null | undefined>(undefined)
  const task = useRef<FilterTask | null>(null)
  const finished = useRef(false)

  if (base.current === undefined) {
    base.current = previewBase(doc)
  }

  const close = (apply: boolean) => {
    finished.current = true
    task.current?.cancel()
    const current = base.current

    if (current && doc.state !== current.before) {
      doc.preview(current.before)
    }

    doc.interacting = false

    if (!apply) {
      $dialog.set(null)

      return
    }

    let spec: FilterSpec

    try {
      spec = checkFilter(kind, settings)
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')

      return
    }

    remembered.set(kind, settings)
    setPhase('applying')
    notify(`Applying ${FILTER_NAMES[kind]}…`)
    applyFilterToDocument(doc, spec, (running) => (task.current = running))
      .then((changed) => notify(changed ? `Applied ${FILTER_NAMES[kind]}` : `${FILTER_NAMES[kind]} changed nothing`))
      .catch((error: unknown) => notify(`Could not apply ${FILTER_NAMES[kind]}: ${error instanceof Error ? error.message : String(error)}`, 'error'))
      .finally(() => $dialog.set(null))
  }

  // No layer to filter: the reason was shown, and the dialog goes.
  useEffect(() => {
    if (!base.current) {
      $dialog.set(null)

      return
    }

    doc.interacting = true

    return () => {
      if (!finished.current) {
        task.current?.cancel()
        doc.interacting = false

        if (base.current && doc.state !== base.current.before) {
          doc.preview(base.current.before)
        }
      }
    }
  }, [])

  // The preview follows the settings, a moment after they stop changing.
  useEffect(() => {
    const current = base.current

    if (!current || finished.current) {
      return
    }

    if (!preview) {
      task.current?.cancel()
      doc.preview(current.before)
      setPhase('idle')

      return
    }

    let live = true
    const timer = setTimeout(() => {
      task.current?.cancel()
      setPhase('previewing')
      previewState(current, checkFilter(kind, settings), (running) => (task.current = running))
        .then((state) => {
          if (live && !finished.current) {
            doc.preview(state ?? current.before)
            setPhase('idle')
          }
        })
        .catch((error: unknown) => {
          if (live && !(error instanceof Error && error.message === 'cancelled')) {
            notify(`Could not preview ${FILTER_NAMES[kind]}: ${error instanceof Error ? error.message : String(error)}`, 'error')
          }
        })
    }, PREVIEW_DELAY)

    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [settings, preview])

  if (!base.current) {
    return null
  }

  const fields = FILTER_FIELDS[kind] as Record<string, FilterField | undefined>
  const put = (key: string, value: number | boolean) => setSettings((current) => ({ ...current, [key]: value }))
  const reduced = base.current.scale < 1

  return (
    <Modal aside title={FILTER_NAMES[kind]} onClose={() => close(false)}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          close(true)
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {Object.entries(fields).map(([key, field]) =>
          key === 'seed' || !field ? null : <FieldRow key={key} name={key} field={field} value={settings[key] as number} onChange={(value) => put(key, value)} />
        )}
        {kind === 'addNoise' && (
          <>
            <div className="flex rounded-md bg-white/5 p-0.5 ring-1 ring-line" role="radiogroup" aria-label="Distribution">
              {(['uniform', 'gaussian'] as const).map((id) => (
                <button key={id} type="button" role="radio" aria-checked={(settings.gaussian === true) === (id === 'gaussian')} onClick={() => put('gaussian', id === 'gaussian')} className={cn('h-7 flex-1 rounded text-[12px] capitalize', (settings.gaussian === true) === (id === 'gaussian') ? 'bg-white/14 text-fg' : 'text-fg-3 hover:text-fg')}>
                  {id}
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between text-[12px] text-fg-2">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={settings.monochromatic === true} onChange={(event) => put('monochromatic', event.target.checked)} className="accent-(--color-accent)" />
                Monochromatic
              </label>
              <button type="button" onClick={() => put('seed', crypto.getRandomValues(new Uint32Array(1))[0])} className="flex items-center gap-1 text-fg-3 hover:text-fg">
                <IconArrowsShuffle size={13} /> New pattern
              </button>
            </div>
          </>
        )}
        <div className="flex items-center justify-between text-[11.5px] text-fg-3">
          <label className="flex items-center gap-2 text-[12px] text-fg-2">
            <input type="checkbox" checked={preview} onChange={(event) => setPreview(event.target.checked)} className="accent-(--color-accent)" />
            Preview
          </label>
          <span>{phase === 'applying' ? 'Applying at full size…' : phase === 'previewing' ? 'Working…' : reduced ? 'Previewed on a reduced copy' : doc.state.selection ? 'Inside the selection' : ''}</span>
        </div>
        <div className="flex justify-end gap-2">
          <GlassButton type="button" variant="ghost" onClick={() => close(false)}>
            Cancel
          </GlassButton>
          <GlassButton type="submit" variant="primary" disabled={phase === 'applying'}>
            OK
          </GlassButton>
        </div>
      </form>
    </Modal>
  )
}
