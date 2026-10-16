import { useEffect, useRef, useState } from 'react'
import { GlassButton } from '../../../components/ui/glass.tsx'
import { cn } from '../../../lib/cn.ts'
import { Modal } from '../dialogs.tsx'
import type { CanvasDocument, DocState } from '../engine/document.ts'
import { $dialog } from '../menus.ts'
import { notify } from '../store.ts'
import { ensureModel } from './models.ts'
import { analyse, type BackgroundOutput, cannotSegment, subjectMask, withSubject } from './remove-background.ts'
import { fitSide, type MaskOptions } from './segment-math.ts'

/** Previews are worked out at about this many pixels on the long side, so the sliders keep up. */
const PREVIEW_SIDE = 1600

function SliderRow({ label, value, min, max, unit, onChange }: { label: string; value: number; min: number; max: number; unit: string; onChange: (value: number) => void }) {
  return (
    <label className="grid grid-cols-[6.5rem_1fr_3.5rem] items-center gap-3 text-[12px] text-fg-2">
      {label}
      <input type="range" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} className="accent-(--color-accent)" />
      <span className="text-right text-fg-3 tabular-nums">
        {value}
        {unit}
      </span>
    </label>
  )
}

/** Layer > Remove Background: the model finds the subject, the canvas shows the result as the settings change, Apply keeps it. */
export function RemoveBackgroundDialog({ doc }: { doc: CanvasDocument }) {
  const layer = useRef(doc.active).current
  const before = useRef<DocState>(doc.state).current
  const [phase, setPhase] = useState<'loading' | 'ready' | 'applying'>('loading')
  const [status, setStatus] = useState('Checking for the model…')
  const [output, setOutput] = useState<BackgroundOutput>('mask')
  const [settings, setSettings] = useState<MaskOptions>({ threshold: 0.5, feather: 0, refine: true })
  const finished = useRef(false)

  const close = (keep: DocState | null) => {
    finished.current = true
    doc.interacting = false

    if (keep) {
      doc.commitFrom('Remove Background', before, [], keep)
    } else if (doc.state !== before) {
      doc.preview(before)
    }

    $dialog.set(null)
  }

  // The model first: asked for, downloaded and run once.
  useEffect(() => {
    const reason = cannotSegment(layer ?? undefined)

    if (reason || !layer?.pixels) {
      notify(reason ?? 'Pick a layer with a picture', 'error')
      close(null)

      return
    }

    const pixels = layer.pixels
    // Set when this run of the effect is over (React runs it twice in development).
    let gone = false
    doc.interacting = true
    void (async () => {
      if (!(await ensureModel('isnet', 'Remove Background'))) {
        if (!gone) {
          close(null)
        }

        return
      }

      setStatus('Finding the subject…')
      const backend = await analyse(pixels)

      if (!gone && !finished.current) {
        setStatus(backend === 'wasm' ? 'Found it (on the CPU; a GPU would be quicker).' : 'Found it.')
        setPhase('ready')
      }
    })().catch((error: unknown) => {
      if (!gone) {
        notify(`Could not remove the background: ${error instanceof Error ? error.message : String(error)}`, 'error')
        close(null)
      }
    })

    return () => {
      gone = true

      if (!finished.current) {
        doc.interacting = false

        if (doc.state !== before) {
          doc.preview(before)
        }
      }
    }
  }, [])

  // The preview follows the settings.
  useEffect(() => {
    if (phase !== 'ready' || !layer?.pixels) {
      return
    }

    const pixels = layer.pixels
    const size = fitSide(pixels.width, pixels.height, PREVIEW_SIDE)
    let current = true
    const timer = setTimeout(() => {
      void subjectMask(pixels, settings, size.width, size.height)
        .then((mask) => {
          if (current && !finished.current) {
            doc.preview(withSubject(before, layer, mask, 'mask'))
          }
        })
        .catch(() => {})
    }, 60)

    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [phase, settings])

  const apply = () => {
    if (!layer?.pixels) {
      return
    }

    setPhase('applying')
    setStatus('Refining the edge at full size…')
    void subjectMask(layer.pixels, settings)
      .then((mask) => close(withSubject(before, layer, mask, output)))
      .catch((error: unknown) => {
        notify(`Could not remove the background: ${error instanceof Error ? error.message : String(error)}`, 'error')
        close(null)
      })
  }

  const set = (change: Partial<MaskOptions>) => setSettings({ ...settings, ...change })

  return (
    <Modal aside title={`Remove Background${layer ? `: ${layer.name}` : ''}`} onClose={() => close(null)}>
      <div className="flex flex-col gap-3.5" onKeyDown={(event) => event.stopPropagation()}>
        <div className={cn('text-[12px]', phase === 'loading' ? 'text-fg-2' : 'text-fg-3')}>{status}</div>
        <div className="flex rounded-md bg-white/5 p-0.5 ring-1 ring-line" role="radiogroup" aria-label="Result">
          {(
            [
              ['mask', 'Layer mask'],
              ['cutout', 'Cut-out layer']
            ] as const
          ).map(([id, label]) => (
            <button key={id} type="button" role="radio" aria-checked={output === id} onClick={() => setOutput(id)} className={cn('h-7 flex-1 rounded text-[12px]', output === id ? 'bg-white/14 text-fg' : 'text-fg-3 hover:text-fg')}>
              {label}
            </button>
          ))}
        </div>
        <p className="-mt-1.5 text-[11.5px] text-fg-3">{output === 'mask' ? 'Nothing is erased: paint on the mask to bring parts back.' : 'A new layer with just the subject; the original is hidden below it.'}</p>
        <SliderRow label="Threshold" value={Math.round(settings.threshold * 100)} min={5} max={95} unit="%" onChange={(value) => set({ threshold: value / 100 })} />
        <SliderRow label="Feather" value={settings.feather} min={0} max={40} unit=" px" onChange={(feather) => set({ feather })} />
        <label className="flex items-center gap-2 text-[12px] text-fg-2">
          <input type="checkbox" checked={settings.refine} onChange={(event) => set({ refine: event.target.checked })} className="accent-(--color-accent)" />
          Refine the edge (follows hair and fine detail)
        </label>
        <div className="mt-1 flex justify-end gap-2">
          <GlassButton variant="ghost" onClick={() => close(null)}>
            Cancel
          </GlassButton>
          <GlassButton variant="primary" disabled={phase !== 'ready'} onClick={apply}>
            Apply
          </GlassButton>
        </div>
      </div>
    </Modal>
  )
}
