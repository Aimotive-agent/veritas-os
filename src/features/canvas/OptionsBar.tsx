import { useStore } from '@nanostores/react'
import {
  IconAlignCenter,
  IconAlignLeft,
  IconAlignRight,
  IconArrowsExchange,
  IconCheck,
  IconCircle,
  IconItalic,
  IconBackground,
  IconLayersIntersect,
  IconLayersSubtract,
  IconLayersUnion,
  IconLayoutAlignBottom,
  IconLayoutAlignCenter,
  IconLayoutAlignLeft,
  IconLayoutAlignMiddle,
  IconLayoutAlignRight,
  IconLayoutAlignTop,
  IconLayoutDistributeHorizontal,
  IconLayoutDistributeVertical,
  IconLine,
  IconRulerMeasure,
  IconSquare,
  IconSquareRounded,
  IconSquareToggle,
  IconX
} from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { RANGES, type TextAlignment } from '../../../shared/canvas/comp-format.ts'
import { GlassButton } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import { cssOf, type RGB } from './color.ts'
import { ColorPicker } from './ColorPicker.tsx'
import type { CanvasDocument } from './engine/document.ts'
import { $fontFamilies, loadFonts } from './fonts.ts'
import type { SelectionMode } from './engine/selection.ts'
import { useRevision } from './hooks.ts'
import { alignPicked, distributePicked } from './actions.ts'
import { cannotSegment } from './ai/subject.ts'
import { ALIGN_LABELS, type AlignEdge, type AlignTo, DISTRIBUTE_LABELS, type DistributeMode } from './engine/align.ts'
import { $dialog } from './menus.ts'
import { CROP_RATIO_LABELS, CROP_RATIOS, type CropRatio } from './engine/crop.ts'
import { GRADIENT_STYLE_LABELS, GRADIENT_STYLES } from './engine/gradient.ts'
import { GradientField, stylePreview } from './GradientEditor.tsx'
import { $crop, $cropOptions, $straighten, applyCrop, cancelCrop, cropAngle, cropRect, setCropOptions } from './tools/crop.ts'
import { warmObjectSelect } from './tools/object-select.ts'
import {
  $alignTo,
  $autoSelect,
  $brush,
  $bucket,
  $clone,
  $eraser,
  $eyedropper,
  $foreground,
  $gradient,
  $heal,
  $healing,
  $marquee,
  $objectSelect,
  $refineBrush,
  $selectionMode,
  $shape,
  $showTransform,
  $tool,
  $type,
  $wand,
  type BrushOptions,
  type CloneOptions,
  type ShapeTool,
  toolDef,
  type TypeOptions
} from './tools/state.ts'
import { paintsMask } from './tools/target.ts'
import { $transform, cancelTransform, commitTransform, sessionFor } from './tools/transform.ts'
import { $typing, applyTypeOptions, cancelTyping, commitTyping, optionsFrom } from './tools/type.ts'
import { actualPixels, fitToScreen } from './view-state.ts'

const stop = (event: React.KeyboardEvent) => {
  if (event.key === 'Enter') {
    ;(event.target as HTMLInputElement).blur()
  }

  event.stopPropagation()
}

/** A small labelled number field; it takes a value only when it is a number in range. */
function NumberField({ label, value, onChange, min = 0, max = 10_000, step = 1, unit, width = 'w-14', title }: { label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number; unit?: string; width?: string; title?: string }) {
  const [draft, setDraft] = useState(String(value))

  useEffect(() => setDraft(String(Math.round(value * 100) / 100)), [value])

  return (
    <label className="flex items-center gap-1.5 text-fg-3" title={title}>
      {label}
      <input
        type="number"
        value={draft}
        min={min}
        max={max}
        step={step}
        onChange={(event) => {
          setDraft(event.target.value)
          const number = Number(event.target.value)

          if (event.target.value !== '' && Number.isFinite(number) && number >= min && number <= max) {
            onChange(number)
          }
        }}
        onBlur={() => setDraft(String(Math.round(value * 100) / 100))}
        onKeyDown={stop}
        className={cn('glass-input h-6 rounded-md px-1.5 text-[12px] text-fg tabular-nums outline-none', width)}
      />
      {unit && <span>{unit}</span>}
    </label>
  )
}

/** A 0 to 1 setting shown as a percentage. */
const Percent = ({ label, value, onChange, title }: { label: string; value: number; onChange: (value: number) => void; title?: string }) => (
  <NumberField label={label} title={title} value={Math.round(value * 100)} min={0} max={100} unit="%" width="w-12" onChange={(percent) => onChange(percent / 100)} />
)

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-center gap-1.5">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  )
}

function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (value: T) => void; options: { id: T; label: string; icon?: React.ReactNode }[]; label: string }) {
  return (
    <div className="flex items-center rounded-md bg-white/5 p-0.5 ring-1 ring-line" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          title={option.label}
          aria-label={option.label}
          onClick={() => onChange(option.id)}
          className={cn('grid h-5 min-w-6 place-items-center rounded px-1 text-[11.5px]', value === option.id ? 'bg-white/14 text-fg' : 'text-fg-3 hover:text-fg')}
        >
          {option.icon ?? option.label}
        </button>
      ))}
    </div>
  )
}

const MODES: { id: SelectionMode; label: string; icon: React.ReactNode }[] = [
  { id: 'new', label: 'New selection', icon: <IconSquare size={13} /> },
  { id: 'add', label: 'Add to the selection (Shift)', icon: <IconLayersUnion size={13} /> },
  { id: 'subtract', label: 'Take away from the selection (Alt)', icon: <IconLayersSubtract size={13} /> },
  { id: 'intersect', label: 'Intersect with the selection (Shift+Alt)', icon: <IconLayersIntersect size={13} /> }
]

function SelectionModes() {
  const mode = useStore($selectionMode)

  return <Segmented label="Selection mode" value={mode} onChange={(next) => $selectionMode.set(next)} options={MODES} />
}

const patch = <T extends object>(store: { get(): T; set(value: T): void }, change: Partial<T>) => store.set({ ...store.get(), ...change })

function CloneFields({ store, doc, healing }: { store: typeof $clone; doc: CanvasDocument; healing: boolean }) {
  const options = useStore(store)
  const set = (change: Partial<CloneOptions>) => patch(store, change)

  return (
    <>
      <BrushFields store={store} doc={doc} />
      <Check label="Aligned" checked={options.aligned} onChange={(aligned) => set({ aligned })} />
      <select aria-label="Sample" title="What the copy comes from" value={options.allLayers ? 'all' : 'current'} onChange={(event) => set({ allLayers: event.target.value === 'all' })} className="glass-input h-6 rounded-md px-1 text-[12px] text-fg outline-none">
        <option value="current">Sample: this layer</option>
        <option value="all">Sample: all layers</option>
      </select>
      <span className="text-fg-3">{healing ? 'Alt-click a source, then paint: the copy takes on the colour around each stroke.' : 'Alt-click where to copy from, then paint.'}</span>
    </>
  )
}

function BrushFields({ store, doc }: { store: typeof $brush; doc: CanvasDocument }) {
  const options = useStore(store) as BrushOptions
  const set = (change: Partial<BrushOptions>) => patch(store, change)

  return (
    <>
      <NumberField label="Size" title="Size ([ and ])" value={options.size} min={1} max={5000} unit="px" onChange={(size) => set({ size })} />
      <Percent label="Hardness" title="Hardness (Shift+[ and Shift+])" value={options.hardness} onChange={(hardness) => set({ hardness })} />
      <Percent label="Opacity" title="Opacity (number keys)" value={options.opacity} onChange={(opacity) => set({ opacity })} />
      <Percent label="Flow" value={options.flow} onChange={(flow) => set({ flow })} />
      <NumberField label="Spacing" value={Math.round(options.spacing * 100)} min={1} max={200} unit="%" width="w-12" onChange={(spacing) => set({ spacing: spacing / 100 })} />
      {paintsMask(doc) && <span className="rounded-full bg-white/8 px-2 py-0.5 text-[11px] text-fg-2">On the mask</span>}
    </>
  )
}

const WEIGHTS: { value: number; label: string }[] = [
  { value: 100, label: 'Thin' },
  { value: 200, label: 'Extra Light' },
  { value: 300, label: 'Light' },
  { value: 400, label: 'Regular' },
  { value: 500, label: 'Medium' },
  { value: 600, label: 'Semibold' },
  { value: 700, label: 'Bold' },
  { value: 800, label: 'Extra Bold' },
  { value: 900, label: 'Black' }
]

function TypeFields({ doc }: { doc: CanvasDocument }) {
  const options = useStore($type)
  const typing = useStore($typing)
  const foreground = useStore($foreground)
  const fonts = useStore($fontFamilies)
  const [picking, setPicking] = useState(false)
  const [family, setFamily] = useState(options.family)
  const session = typing?.docKey === doc.key ? typing : null
  const layer = !session && doc.active?.text ? doc.active : null
  const style = session?.style ?? layer?.text
  const colour: RGB = style ? [Math.round(style.red * 255), Math.round(style.green * 255), Math.round(style.blue * 255)] : foreground

  useEffect(() => void loadFonts(), [])
  useEffect(() => setFamily(options.family), [options.family])

  // A text layer picked with the Type tool in hand shows its own style here.
  const picked = layer?.text

  useEffect(() => {
    if (picked) {
      $type.set(optionsFrom(picked))
    }
  }, [picked])

  const set = (change: Partial<TypeOptions>) => {
    const next = { ...$type.get(), ...change }
    $type.set(next)

    if (session || layer) {
      applyTypeOptions(doc, next)
    }
  }

  // A family takes effect once it is picked from the list, or typed and confirmed.
  const takeFamily = (value: string) => {
    const name = value.trim()

    if (name && name !== $type.get().family) {
      set({ family: name })
    }
  }

  return (
    <>
      <label className="flex items-center gap-1.5 text-fg-3">
        Font
        <input
          list="herald-canvas-fonts"
          value={family}
          onChange={(event) => {
            setFamily(event.target.value)

            if (fonts?.includes(event.target.value)) {
              takeFamily(event.target.value)
            }
          }}
          onBlur={() => takeFamily(family)}
          onKeyDown={stop}
          className="glass-input h-6 w-36 rounded-md px-1.5 text-[12px] text-fg outline-none"
        />
        <datalist id="herald-canvas-fonts">
          {(fonts ?? []).map((family) => (
            <option key={family} value={family} />
          ))}
        </datalist>
      </label>
      <select aria-label="Weight" value={options.weight} onChange={(event) => set({ weight: Number(event.target.value) })} className="glass-input h-6 rounded-md px-1 text-[12px] text-fg outline-none">
        {WEIGHTS.map((weight) => (
          <option key={weight.value} value={weight.value}>
            {weight.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        title="Italic"
        aria-label="Italic"
        aria-pressed={options.italic}
        onClick={() => set({ italic: !options.italic })}
        className={cn('grid size-6 place-items-center rounded-md ring-1 ring-line', options.italic ? 'bg-white/14 text-fg' : 'text-fg-3 hover:text-fg')}
      >
        <IconItalic size={13} />
      </button>
      <NumberField label="Size" value={options.size} min={RANGES.fontSize[0]} max={RANGES.fontSize[1]} unit="px" onChange={(size) => set({ size })} />
      <div className="relative">
        <button type="button" title="Text colour" aria-label="Text colour" onClick={() => setPicking(true)} className="block size-6 rounded-md ring-1 ring-white/40" style={{ background: cssOf(colour) }} />
        {picking && (
          <ColorPicker
            title="Text colour"
            colour={colour}
            onChange={(next) => {
              if (session || layer) {
                applyTypeOptions(doc, $type.get(), next)
              } else {
                $foreground.set(next)
              }
            }}
            onClose={() => setPicking(false)}
            className="top-full left-0 mt-2"
          />
        )}
      </div>
      <Segmented<TextAlignment>
        label="Alignment"
        value={options.alignment}
        onChange={(alignment) => set({ alignment })}
        options={[
          { id: 'Left', label: 'Align left', icon: <IconAlignLeft size={13} /> },
          { id: 'Center', label: 'Centre', icon: <IconAlignCenter size={13} /> },
          { id: 'Right', label: 'Align right', icon: <IconAlignRight size={13} /> }
        ]}
      />
      <NumberField label="Tracking" title="Extra space between letters" value={options.tracking} min={RANGES.tracking[0]} max={RANGES.tracking[1]} step={0.5} unit="px" width="w-12" onChange={(tracking) => set({ tracking })} />
      <NumberField label="Leading" title="Line spacing, baseline to baseline (0 is automatic: 120% of the size)" value={options.leading} min={RANGES.leading[0]} max={RANGES.leading[1]} step={1} unit="px" width="w-12" onChange={(leading) => set({ leading })} />
      {session && <Confirm onApply={() => void commitTyping(doc)} onCancel={cancelTyping} />}
    </>
  )
}

function Confirm({ onApply, onCancel }: { onApply: () => void; onCancel: () => void }) {
  return (
    <div className="ml-auto flex items-center gap-1">
      <button type="button" title="Cancel (Esc)" aria-label="Cancel" onClick={onCancel} className="grid size-6 place-items-center rounded-md text-fg-3 hover:bg-white/8 hover:text-fg">
        <IconX size={15} />
      </button>
      <button type="button" title="Apply (Enter)" aria-label="Apply" onClick={onApply} className="grid size-6 place-items-center rounded-md bg-accent/25 text-fg hover:bg-accent/40">
        <IconCheck size={15} />
      </button>
    </div>
  )
}

const ALIGN_BUTTONS: { edge: AlignEdge; icon: React.ReactNode }[] = [
  { edge: 'left', icon: <IconLayoutAlignLeft size={14} /> },
  { edge: 'center', icon: <IconLayoutAlignCenter size={14} /> },
  { edge: 'right', icon: <IconLayoutAlignRight size={14} /> },
  { edge: 'top', icon: <IconLayoutAlignTop size={14} /> },
  { edge: 'middle', icon: <IconLayoutAlignMiddle size={14} /> },
  { edge: 'bottom', icon: <IconLayoutAlignBottom size={14} /> }
]

const DISTRIBUTE_BUTTONS: { mode: DistributeMode; icon: React.ReactNode }[] = [
  { mode: 'horizontal', icon: <IconLayoutDistributeVertical size={14} /> },
  { mode: 'vertical', icon: <IconLayoutDistributeHorizontal size={14} /> }
]

function IconButton({ title, disabled, onClick, children }: { title: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={title} aria-label={title} disabled={disabled} onClick={onClick} className="grid size-6 place-items-center rounded-md text-fg-3 hover:bg-white/8 hover:text-fg disabled:opacity-35 disabled:hover:bg-transparent">
      {children}
    </button>
  )
}

/** The Move tool's align and distribute buttons, and what the layers line up with. */
function AlignControls({ doc }: { doc: CanvasDocument }) {
  const to = useStore($alignTo)
  const count = doc.picked.length

  return (
    <div className="flex items-center gap-0.5" role="group" aria-label="Align and distribute">
      {ALIGN_BUTTONS.map(({ edge, icon }) => (
        <IconButton key={edge} title={ALIGN_LABELS[edge]} disabled={!count} onClick={() => alignPicked(doc, edge)}>
          {icon}
        </IconButton>
      ))}
      <span className="mx-1 h-4 w-px bg-line" />
      {DISTRIBUTE_BUTTONS.map(({ mode, icon }) => (
        <IconButton key={mode} title={`${DISTRIBUTE_LABELS[mode]} (three or more layers)`} disabled={count < 3} onClick={() => distributePicked(doc, mode)}>
          {icon}
        </IconButton>
      ))}
      <select aria-label="Align to" title="What the layers line up with" value={to} onChange={(event) => $alignTo.set(event.target.value as AlignTo | 'auto')} className="glass-input ml-1 h-6 rounded-md px-1 text-[12px] text-fg outline-none">
        <option value="auto">To: automatic</option>
        <option value="layers">To: each other</option>
        <option value="selection">To: the selection</option>
        <option value="canvas">To: the canvas</option>
      </select>
    </div>
  )
}

function MoveFields({ doc }: { doc: CanvasDocument }) {
  const autoSelect = useStore($autoSelect)
  const showTransform = useStore($showTransform)
  useStore($transform)
  const session = sessionFor(doc)

  if (session && !session.transient) {
    const { frame } = session

    return (
      <>
        <span className="text-fg-2">{session.quad ? 'Distort: drag the corners' : session.distort ? 'Distort: drag a corner, or the frame' : 'Free Transform'}</span>
        {!session.quad && (
          <span className="tabular-nums text-fg-3">
            {Math.round(frame.size[0])} × {Math.round(frame.size[1])} px · {Math.round(frame.rotation * 10) / 10}°
          </span>
        )}
        <span className="text-fg-3">Shift keeps proportions, Alt scales from the centre, ⌘-drag a corner distorts.</span>
        <Confirm onApply={() => commitTransform(doc)} onCancel={() => cancelTransform(doc)} />
      </>
    )
  }

  return (
    <>
      <Check label="Pick the layer under the pointer" checked={autoSelect} onChange={(checked) => $autoSelect.set(checked)} />
      <Check label="Show transform controls" checked={showTransform} onChange={(checked) => $showTransform.set(checked)} />
      <AlignControls doc={doc} />
      <GlassButton size="sm" variant="ghost" disabled={Boolean(cannotSegment(doc.active))} title="Hide the background with a mask (Layer > Remove Background)" onClick={() => $dialog.set({ kind: 'remove-background' })}>
        <IconBackground size={14} /> Remove Background
      </GlassButton>
    </>
  )
}

function ObjectSelectFields({ doc }: { doc: CanvasDocument }) {
  const options = useStore($objectSelect)

  // The picture is looked at once, as soon as the tool is in hand.
  useEffect(() => warmObjectSelect(doc), [doc, options.allLayers, doc.state.activeLayerId])

  return (
    <>
      <SelectionModes />
      <Check label="All layers" checked={options.allLayers} onChange={(allLayers) => $objectSelect.set({ allLayers })} />
      <span className="text-fg-3">Click an object or drag a box around it; Shift-click adds a part, Alt-click takes one away, Esc starts over.</span>
    </>
  )
}

function HealFields() {
  const options = useStore($heal)

  return (
    <>
      <NumberField label="Size" title="Size ([ and ])" value={options.size} min={1} max={2000} unit="px" onChange={(size) => $heal.set({ size })} />
      <span className="text-fg-3">Paint over what should go; it is filled from around it when you let go (Esc stops it).</span>
    </>
  )
}

function CropFields({ doc }: { doc: CanvasDocument }) {
  useStore($crop)
  const options = useStore($cropOptions)
  const straightening = useStore($straighten)
  const rect = cropRect(doc)
  const angle = cropAngle(doc)

  return (
    <>
      <select aria-label="Ratio" title="Hold the box to a ratio" value={options.ratio} onChange={(event) => setCropOptions(doc, { ratio: event.target.value as CropRatio })} className="glass-input h-6 rounded-md px-1 text-[12px] text-fg outline-none">
        {CROP_RATIOS.map((ratio) => (
          <option key={ratio} value={ratio}>
            {CROP_RATIO_LABELS[ratio]}
          </option>
        ))}
      </select>
      {options.ratio === 'custom' && (
        <>
          <NumberField label="W" value={options.custom[0]} min={0.01} max={10_000} step={0.1} width="w-12" onChange={(value) => setCropOptions(doc, { custom: [value, options.custom[1]] })} />
          <NumberField label="H" value={options.custom[1]} min={0.01} max={10_000} step={0.1} width="w-12" onChange={(value) => setCropOptions(doc, { custom: [options.custom[0], value] })} />
        </>
      )}
      <button
        type="button"
        title="Swap width and height (portrait and landscape)"
        aria-label="Swap width and height"
        aria-pressed={options.swapped}
        disabled={options.ratio === 'free'}
        onClick={() => setCropOptions(doc, { swapped: !options.swapped })}
        className={cn('grid size-6 place-items-center rounded-md ring-1 ring-line disabled:opacity-35', options.swapped ? 'bg-white/14 text-fg' : 'text-fg-3 hover:text-fg')}
      >
        <IconArrowsExchange size={13} />
      </button>
      <button
        type="button"
        title="Straighten: draw a line along the horizon or a wall"
        aria-pressed={straightening}
        onClick={() => $straighten.set(!straightening)}
        className={cn('flex h-6 items-center gap-1 rounded-md px-1.5 ring-1 ring-line', straightening ? 'bg-white/14 text-fg' : 'text-fg-3 hover:text-fg')}
      >
        <IconRulerMeasure size={13} /> Straighten
      </button>
      <span className="tabular-nums text-fg-2">
        {rect.width} × {rect.height} px{angle ? ` · turned ${angle}°` : ''}
      </span>
      <span className="text-fg-3">{straightening ? 'Draw a line along something that should be level.' : 'Drag the handles or a new box; layers keep their pixels.'}</span>
      <Confirm onApply={() => applyCrop(doc)} onCancel={cancelCrop} />
    </>
  )
}

const SHAPES: { id: ShapeTool; label: string; icon: React.ReactNode }[] = [
  { id: 'rectangle', label: 'Rectangle', icon: <IconSquare size={13} /> },
  { id: 'rounded', label: 'Rounded rectangle', icon: <IconSquareRounded size={13} /> },
  { id: 'ellipse', label: 'Ellipse', icon: <IconCircle size={13} /> },
  { id: 'line', label: 'Line', icon: <IconLine size={13} /> }
]

export function OptionsBar({ doc }: { doc: CanvasDocument }) {
  useRevision(doc)
  const tool = useStore($tool)
  const marquee = useStore($marquee)
  const wand = useStore($wand)
  const bucket = useStore($bucket)
  const gradient = useStore($gradient)
  const eyedropper = useStore($eyedropper)
  const shape = useStore($shape)
  const refineBrush = useStore($refineBrush)

  return (
    <div className="flex h-9 shrink-0 items-center gap-3 overflow-x-auto border-b border-line px-3 text-[12px] whitespace-nowrap text-fg-2">
      <span className="text-fg-3">{toolDef(tool).label}</span>
      {tool === 'move' && <MoveFields doc={doc} />}
      {(tool === 'marquee' || tool === 'ellipse-marquee') && (
        <>
          <SelectionModes />
          <NumberField label="Feather" value={marquee.feather} min={0} max={1000} unit="px" width="w-12" onChange={(feather) => $marquee.set({ feather })} />
        </>
      )}
      {(tool === 'lasso' || tool === 'polygon-lasso') && (
        <>
          <SelectionModes />
          {tool === 'polygon-lasso' && <span className="text-fg-3">Click the corners; Enter or a double-click closes it, Backspace takes a corner back.</span>}
        </>
      )}
      {tool === 'wand' && (
        <>
          <SelectionModes />
          <NumberField label="Tolerance" value={wand.tolerance} min={0} max={255} width="w-12" onChange={(tolerance) => patch($wand, { tolerance })} />
          <Check label="Contiguous" checked={wand.contiguous} onChange={(contiguous) => patch($wand, { contiguous })} />
          <Check label="All layers" checked={wand.allLayers} onChange={(allLayers) => patch($wand, { allLayers })} />
        </>
      )}
      {tool === 'object-select' && <ObjectSelectFields doc={doc} />}
      {tool === 'heal' && <HealFields />}
      {tool === 'refine' && (
        <>
          <NumberField label="Size" title="Size ([ and ])" value={refineBrush.size} min={1} max={2000} unit="px" onChange={(size) => $refineBrush.set({ size })} />
          <span className="text-fg-3">Paint over hair and fur to work their edge out again; Alt-paint takes a stroke back. Enter applies, Esc cancels.</span>
        </>
      )}
      {tool === 'crop' && <CropFields doc={doc} />}
      {tool === 'eyedropper' && (
        <Segmented
          label="Sample"
          value={eyedropper.allLayers ? 'all' : 'layer'}
          onChange={(value) => $eyedropper.set({ allLayers: value === 'all' })}
          options={[
            { id: 'all', label: 'All layers' },
            { id: 'layer', label: 'Current layer' }
          ]}
        />
      )}
      {tool === 'brush' && <BrushFields store={$brush} doc={doc} />}
      {tool === 'eraser' && <BrushFields store={$eraser} doc={doc} />}
      {tool === 'clone' && <CloneFields store={$clone} doc={doc} healing={false} />}
      {tool === 'healing' && <CloneFields store={$healing} doc={doc} healing />}
      {tool === 'bucket' && (
        <>
          <NumberField label="Tolerance" value={bucket.tolerance} min={0} max={255} width="w-12" onChange={(tolerance) => patch($bucket, { tolerance })} />
          <Check label="Contiguous" checked={bucket.contiguous} onChange={(contiguous) => patch($bucket, { contiguous })} />
          <Check label="All layers" checked={bucket.allLayers} onChange={(allLayers) => patch($bucket, { allLayers })} />
          <Percent label="Opacity" value={bucket.opacity} onChange={(opacity) => patch($bucket, { opacity })} />
        </>
      )}
      {tool === 'gradient' && (
        <>
          <GradientField />
          <Segmented
            label="Gradient style"
            value={gradient.style}
            onChange={(style) => patch($gradient, { style })}
            options={GRADIENT_STYLES.map((style) => ({ id: style, label: GRADIENT_STYLE_LABELS[style], icon: <img src={stylePreview(style)} alt="" className="size-3.5 rounded-[2px]" /> }))}
          />
          <button
            type="button"
            title="Reverse"
            aria-label="Reverse"
            aria-pressed={gradient.reverse}
            onClick={() => patch($gradient, { reverse: !gradient.reverse })}
            className={cn('grid size-6 place-items-center rounded-md ring-1 ring-line', gradient.reverse ? 'bg-white/14 text-fg' : 'text-fg-3 hover:text-fg')}
          >
            <IconSquareToggle size={13} />
          </button>
          <Percent label="Opacity" value={gradient.opacity} onChange={(opacity) => patch($gradient, { opacity })} />
        </>
      )}
      {tool === 'type' && <TypeFields doc={doc} />}
      {tool === 'shape' && (
        <>
          <Segmented label="Shape" value={shape.kind} onChange={(kind) => patch($shape, { kind })} options={SHAPES} />
          {shape.kind === 'rounded' && <NumberField label="Radius" value={shape.radius} min={0} max={5000} unit="px" width="w-12" onChange={(radius) => patch($shape, { radius })} />}
          {shape.kind === 'line' && <NumberField label="Width" value={shape.lineWidth} min={1} max={1000} unit="px" width="w-12" onChange={(lineWidth) => patch($shape, { lineWidth })} />}
          <span className="text-fg-3">In the foreground colour; Shift squares, Alt draws from the centre.</span>
        </>
      )}
      {(tool === 'zoom' || tool === 'hand') && (
        <div className="flex items-center gap-1.5">
          <GlassButton size="sm" variant="ghost" onClick={() => fitToScreen(doc)}>
            Fit on screen
          </GlassButton>
          <GlassButton size="sm" variant="ghost" onClick={() => actualPixels(doc)}>
            100%
          </GlassButton>
        </div>
      )}
    </div>
  )
}
