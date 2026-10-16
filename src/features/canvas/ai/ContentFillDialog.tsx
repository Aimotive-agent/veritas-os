import { useRef, useState } from 'react'
import { GlassButton } from '../../../components/ui/glass.tsx'
import { cn } from '../../../lib/cn.ts'
import { Modal } from '../dialogs.tsx'
import type { CanvasDocument } from '../engine/document.ts'
import { PixelEdit } from '../engine/history.ts'
import { $dialog } from '../menus.ts'
import { notify } from '../store.ts'
import { compositeOf } from '../tools/screen.ts'
import { commitPixels, paintTarget } from '../tools/target.ts'
import { type FillSampling, type FillTask, fillRaster, holeFromMask, placementOf, withFillLayer, writeFill } from './content-fill.ts'

function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (value: T) => void }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] items-center gap-3 text-[12px] text-fg-2">
      {label}
      <div className="flex rounded-md bg-white/5 p-0.5 ring-1 ring-line" role="radiogroup" aria-label={label}>
        {options.map(([id, text]) => (
          <button key={id} type="button" role="radio" aria-checked={value === id} onClick={() => onChange(id)} className={cn('h-7 flex-1 rounded text-[12px]', value === id ? 'bg-white/14 text-fg' : 'text-fg-3 hover:text-fg')}>
            {text}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Edit > Content-Aware Fill: the selection filled from what is around it, into the layer or a new one. */
export function ContentFillDialog({ doc }: { doc: CanvasDocument }) {
  const [output, setOutput] = useState<'layer' | 'new'>('layer')
  const [sampling, setSampling] = useState<FillSampling>('around')
  const [allLayers, setAllLayers] = useState(!doc.active?.pixels)
  const [progress, setProgress] = useState<number | null>(null)
  const task = useRef<FillTask | null>(null)
  const close = () => {
    task.current?.cancel()
    $dialog.set(null)
  }

  const run = async () => {
    const selection = doc.state.selection
    const layer = doc.active

    if (!selection) {
      notify('Select what to fill first', 'error')
      close()

      return
    }

    const fromAll = allLayers || !layer?.pixels
    const into = fromAll ? 'new' : output
    const target = into === 'layer' ? paintTarget(doc) : null

    if (into === 'layer' && (!target || target.mask)) {
      notify(target?.mask ? 'Content-Aware Fill works on pixels: pick the layer, not its mask' : 'Pick a layer with pixels', 'error')

      return
    }

    const pixels = fromAll ? compositeOf(doc) : target?.raster ?? layer!.pixels!
    const placed = fromAll ? placementOf(null) : target?.toDocument ?? placementOf(layer!)
    const hole = holeFromMask(selection, placed, pixels.width, pixels.height)

    if (!hole) {
      notify('The selection does not reach this layer', 'error')

      return
    }

    const before = doc.state
    setProgress(0)
    task.current = fillRaster(pixels, hole, { sampling, onProgress: setProgress })

    try {
      const filled = await task.current.done

      if (target && into === 'layer') {
        const edit = new PixelEdit(target.raster)
        writeFill(target.raster, filled, edit)
        commitPixels(doc, before, target, edit, 'Content-Aware Fill')
      } else {
        const source = fromAll ? null : { transform: layer!.transform, width: pixels.width, height: pixels.height }
        doc.commit('Content-Aware Fill', withFillLayer(doc.state, filled, source, layer?.id))
      }

      task.current = null
      $dialog.set(null)
    } catch (error) {
      task.current = null
      setProgress(null)
      const message = error instanceof Error ? error.message : String(error)

      if (!message.includes('cancelled')) {
        notify(`Could not fill: ${message}`, 'error')
      }
    }
  }

  return (
    <Modal title="Content-Aware Fill" onClose={close}>
      <div className="flex flex-col gap-3.5" onKeyDown={(event) => event.stopPropagation()}>
        <p className="text-[12px] text-fg-3">Fills the selection with pixels from around it. It all happens on this computer.</p>
        <Choice
          label="Put the fill"
          value={allLayers ? 'new' : output}
          onChange={(value) => !allLayers && setOutput(value)}
          options={[
            ['layer', 'In the layer'],
            ['new', 'On a new layer']
          ]}
        />
        <Choice
          label="Copy from"
          value={sampling}
          onChange={setSampling}
          options={[
            ['around', 'Around the selection'],
            ['all', 'The whole picture']
          ]}
        />
        <label className="flex items-center gap-2 text-[12px] text-fg-2">
          <input type="checkbox" checked={allLayers} disabled={!doc.active?.pixels} onChange={(event) => setAllLayers(event.target.checked)} className="accent-(--color-accent)" />
          Sample all layers (the fill goes on a new layer)
        </label>
        {progress !== null && (
          <div className="h-1.5 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
        <div className="mt-1 flex justify-end gap-2">
          <GlassButton variant="ghost" onClick={close}>
            Cancel
          </GlassButton>
          <GlassButton variant="primary" disabled={progress !== null} onClick={() => void run()}>
            Fill
          </GlassButton>
        </div>
      </div>
    </Modal>
  )
}
