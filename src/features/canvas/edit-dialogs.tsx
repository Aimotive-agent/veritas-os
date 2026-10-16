import { useStore } from '@nanostores/react'
import { IconLink, IconLinkOff } from '@tabler/icons-react'
import { useState } from 'react'
import { LIMITS } from '../../../shared/canvas/comp-format.ts'
import { GlassButton } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import { cssOf, type RGB } from './color.ts'
import { Modal, NumberField } from './dialogs.tsx'
import { canvasSize, fillSelection, imageSize, modifySelection, type SelectionChange, trim } from './editing.ts'
import { type Anchor, ANCHORS } from './engine/canvas-size.ts'
import type { CanvasDocument } from './engine/document.ts'
import type { TrimBy } from './engine/canvas-size.ts'
import { type GuideAxis, onCanvas, positionFrom, withGuides } from './engine/guides.ts'
import { $dialog } from './menus.ts'
import { $background, $foreground } from './tools/state.ts'

const close = () => $dialog.set(null)

const fits = (width: number, height: number) => width >= 1 && height >= 1 && width <= LIMITS.side && height <= LIMITS.side && width * height <= LIMITS.sourcePixels

function Buttons({ disabled, label = 'OK' }: { disabled?: boolean; label?: string }) {
  return (
    <div className="col-span-full mt-1 flex justify-end gap-2">
      <GlassButton type="button" variant="ghost" onClick={close}>
        Cancel
      </GlassButton>
      <GlassButton type="submit" variant="primary" disabled={disabled}>
        {label}
      </GlassButton>
    </div>
  )
}

function Form({ onSubmit, children, className }: { onSubmit: () => void; children: React.ReactNode; className?: string }) {
  return (
    <form
      className={cn('grid gap-3', className)}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {children}
    </form>
  )
}

/** Canvas Size: a new width and height, growing or cutting around an anchor; layers keep their pixels. */
export function CanvasSizeDialog({ doc }: { doc: CanvasDocument }) {
  const [width, setWidth] = useState(doc.state.width)
  const [height, setHeight] = useState(doc.state.height)
  const [anchor, setAnchor] = useState<Anchor>('center')
  const valid = fits(width, height)

  return (
    <Modal title="Canvas Size" onClose={close}>
      <Form
        className="grid-cols-[1fr_1fr_auto]"
        onSubmit={() => {
          if (valid) {
            canvasSize(doc, width, height, anchor)
            close()
          }
        }}
      >
        <NumberField label="Width" value={width} onChange={setWidth} unit="px" autoFocus />
        <NumberField label="Height" value={height} onChange={setHeight} unit="px" />
        <div className="flex flex-col gap-1 text-[11.5px] text-fg-3">
          Anchor
          <div className="grid grid-cols-3 gap-0.5" role="radiogroup" aria-label="Anchor">
            {ANCHORS.map((entry) => (
              <button
                key={entry}
                type="button"
                role="radio"
                aria-checked={anchor === entry}
                aria-label={entry}
                title={entry.replace('-', ' ')}
                onClick={() => setAnchor(entry)}
                className={cn('size-5 rounded-[4px] ring-1 ring-line', anchor === entry ? 'bg-accent' : 'bg-white/6 hover:bg-white/12')}
              />
            ))}
          </div>
        </div>
        <p className="col-span-full text-[11.5px] text-fg-3">
          Now {doc.state.width} × {doc.state.height} px. Growing adds transparent room; shrinking cuts the edges off the canvas, but layers keep their pixels.
        </p>
        <Buttons disabled={!valid} />
      </Form>
    </Modal>
  )
}

/** Image Size: everything scaled to a new size, the proportions kept unless unlinked. */
export function ImageSizeDialog({ doc }: { doc: CanvasDocument }) {
  const { width: w0, height: h0 } = doc.state
  const [width, setWidth] = useState(w0)
  const [height, setHeight] = useState(h0)
  const [linked, setLinked] = useState(true)
  const [resample, setResample] = useState(true)
  const valid = fits(width, height)

  return (
    <Modal title="Image Size" onClose={close}>
      <Form
        className="grid-cols-[1fr_auto_1fr]"
        onSubmit={() => {
          if (valid) {
            imageSize(doc, width, height, resample)
            close()
          }
        }}
      >
        <NumberField
          label="Width"
          value={width}
          unit="px"
          autoFocus
          onChange={(value) => {
            setWidth(value)

            if (linked) {
              setHeight(Math.max(1, Math.round((value * h0) / w0)))
            }
          }}
        />
        <button type="button" title={linked ? 'Proportions kept' : 'Proportions free'} aria-label="Keep proportions" aria-pressed={linked} onClick={() => setLinked(!linked)} className="mt-5 grid size-8 place-items-center rounded-lg text-fg-2 hover:bg-white/8">
          {linked ? <IconLink size={16} /> : <IconLinkOff size={16} />}
        </button>
        <NumberField
          label="Height"
          value={height}
          unit="px"
          onChange={(value) => {
            setHeight(value)

            if (linked) {
              setWidth(Math.max(1, Math.round((value * w0) / h0)))
            }
          }}
        />
        <label className="col-span-full flex items-center gap-2 text-[12px] text-fg-2">
          <input type="checkbox" checked={resample} onChange={(event) => setResample(event.target.checked)} />
          Resample the layers' pixels too
        </label>
        <p className="col-span-full text-[11.5px] text-fg-3">{resample ? 'Pixels are recalculated for the new size.' : 'Pixels stay as they are and are drawn larger or smaller, so nothing is lost.'}</p>
        <Buttons disabled={!valid} />
      </Form>
    </Modal>
  )
}

export function TrimDialog({ doc }: { doc: CanvasDocument }) {
  const [by, setBy] = useState<TrimBy>('transparent')

  return (
    <Modal title="Trim" onClose={close}>
      <Form
        onSubmit={() => {
          trim(doc, by)
          close()
        }}
      >
        <div className="flex flex-col gap-2 text-[12.5px] text-fg-2">
          {(
            [
              ['transparent', 'Transparent pixels'],
              ['top-left', 'The top-left pixel’s colour']
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-2">
              <input type="radio" name="trim" checked={by === value} onChange={() => setBy(value)} />
              {label}
            </label>
          ))}
        </div>
        <p className="text-[11.5px] text-fg-3">The canvas shrinks to what is left; layers keep their pixels.</p>
        <Buttons label="Trim" />
      </Form>
    </Modal>
  )
}

const CHANGES: Record<SelectionChange, { title: string; label: string }> = {
  feather: { title: 'Feather Selection', label: 'Feather radius' },
  expand: { title: 'Expand Selection', label: 'Expand by' },
  contract: { title: 'Contract Selection', label: 'Contract by' }
}

export function ModifySelectionDialog({ doc, change }: { doc: CanvasDocument; change: SelectionChange }) {
  const [radius, setRadius] = useState(change === 'feather' ? 10 : 4)
  const { title, label } = CHANGES[change]

  return (
    <Modal title={title} onClose={close} className="max-w-xs">
      <Form
        onSubmit={() => {
          if (radius > 0) {
            modifySelection(doc, change, radius)
            close()
          }
        }}
      >
        <NumberField label={label} value={radius} onChange={setRadius} unit="px" min={1} max={2000} autoFocus />
        <Buttons disabled={radius <= 0} />
      </Form>
    </Modal>
  )
}

/** View > New Guide: a guide across or down the canvas, in pixels or as a percentage. */
export function NewGuideDialog({ doc }: { doc: CanvasDocument }) {
  const [axis, setAxis] = useState<GuideAxis>('vertical')
  const [position, setPosition] = useState('50%')
  const length = axis === 'vertical' ? doc.state.width : doc.state.height
  let value: number | undefined

  try {
    value = positionFrom(position, length)
  } catch {
    value = undefined
  }

  const valid = value !== undefined && onCanvas(doc.state, axis, value)

  return (
    <Modal title="New Guide" onClose={close} className="max-w-xs">
      <Form
        onSubmit={() => {
          if (valid) {
            doc.commit('New Guide', withGuides(doc.state, [{ axis, position: value! }]).state)
            close()
          }
        }}
      >
        <div className="flex gap-4 text-[12.5px] text-fg-2">
          {(['vertical', 'horizontal'] as const).map((entry) => (
            <label key={entry} className="flex items-center gap-2 capitalize">
              <input type="radio" name="guide-axis" checked={axis === entry} onChange={() => setAxis(entry)} />
              {entry}
            </label>
          ))}
        </div>
        <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
          Position (pixels from the {axis === 'vertical' ? 'left' : 'top'}, or a percentage)
          <input autoFocus value={position} onChange={(event) => setPosition(event.target.value)} className="glass-input h-8 rounded-lg px-2 text-[13px] text-fg tabular-nums outline-none" />
        </label>
        {value !== undefined && <p className="text-[11.5px] text-fg-3">{valid ? `At ${Math.round(value * 100) / 100} px of ${length}.` : `That is off the ${length}-pixel canvas.`}</p>}
        <Buttons disabled={!valid} />
      </Form>
    </Modal>
  )
}

type FillWith = 'foreground' | 'background' | 'black' | 'white' | 'gray' | 'colour'

/** Edit > Fill: a colour into the selection (or the whole layer). */
export function FillDialog({ doc }: { doc: CanvasDocument }) {
  const foreground = useStore($foreground)
  const background = useStore($background)
  const [using, setUsing] = useState<FillWith>('foreground')
  const [colour, setColour] = useState('#ff8800')
  const [opacity, setOpacity] = useState(100)
  const pick: Record<FillWith, RGB> = {
    foreground,
    background,
    black: [0, 0, 0],
    white: [255, 255, 255],
    gray: [128, 128, 128],
    colour: [parseInt(colour.slice(1, 3), 16), parseInt(colour.slice(3, 5), 16), parseInt(colour.slice(5, 7), 16)]
  }

  return (
    <Modal title="Fill" onClose={close} className="max-w-sm">
      <Form
        onSubmit={() => {
          fillSelection(doc, [...pick[using], 255], opacity / 100)
          close()
        }}
      >
        <label className="flex flex-col gap-1 text-[11.5px] text-fg-3">
          Contents
          <div className="flex items-center gap-2">
            <select value={using} onChange={(event) => setUsing(event.target.value as FillWith)} className="glass-input h-8 flex-1 rounded-lg px-2 text-[13px] text-fg outline-none">
              <option value="foreground">Foreground colour</option>
              <option value="background">Background colour</option>
              <option value="colour">Colour…</option>
              <option value="black">Black</option>
              <option value="gray">50% Gray</option>
              <option value="white">White</option>
            </select>
            {using === 'colour' ? (
              <input type="color" aria-label="Colour" value={colour} onChange={(event) => setColour(event.target.value)} className="h-8 w-10 cursor-pointer rounded-lg bg-transparent" />
            ) : (
              <span className="size-8 rounded-lg ring-1 ring-line" style={{ background: cssOf(pick[using]) }} />
            )}
          </div>
        </label>
        <NumberField label="Opacity" value={opacity} onChange={setOpacity} unit="%" min={1} max={100} />
        <p className="text-[11.5px] text-fg-3">{doc.state.selection ? 'Fills the selection on the active layer.' : 'Nothing is selected: fills the whole active layer.'}</p>
        <Buttons />
      </Form>
    </Modal>
  )
}
