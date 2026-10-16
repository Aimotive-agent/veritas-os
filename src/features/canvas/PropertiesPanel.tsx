import { IconArrowsShuffle, IconBackground, IconChevronDown, IconChevronRight, IconContrast, IconCube3dSphere, IconEye, IconEyeOff, IconLink, IconLinkOff, IconMask, IconStack2, IconTrash } from '@tabler/icons-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  type Adjustment,
  CHANNELS,
  type Channel,
  type CurvePoint,
  defaultAdjustment,
  defaultEffect,
  type EffectKind,
  HERALD_RANGES,
  type HeraldAdjustment,
  type Inks,
  type LayerEffects,
  type LevelRange,
  type MixerRow,
  RANGES,
  type RGB,
  SELECTIVE_RANGES,
  type SelectiveRange,
  type ShapeKind,
  type ShapeStyle
} from '../../../shared/canvas/comp-format.ts'
import { cn } from '../../lib/cn.ts'
import { maskAction } from './actions.ts'
import { MAX_LINE_WIDTH, shapeWith } from './agent-model.ts'
import { cannotSegment } from './ai/subject.ts'
import { ADJUSTMENT_ICONS, adjustmentKindOf, EFFECT_ICONS } from './adjustment-icons.tsx'
import { cssOf, type RGB as Bytes } from './color.ts'
import { ColorPicker } from './ColorPicker.tsx'
import { curveTable, resolved } from './engine/adjust-math.ts'
import { parseCube } from './engine/color-table.ts'
import { type CanvasDocument, type CanvasLayer, type DocState, findLayer, withLayer } from './engine/document.ts'
import { heraldOf, withVeritas } from './engine/herald-adjust.ts'
import { EFFECT_NAMES, EFFECT_ORDER, takesEffects, withEffect } from './engine/layer-effects.ts'
import { useRevision } from './hooks.ts'
import { $dialog } from './menus.ts'
import { restyleShape } from './text-layers.ts'

/*
 * The Properties panel: the active layer's settings. An adjustment layer shows its own controls; a
 * layer with pixels shows its effects; a layer with a mask, the mask's. Dragging a slider, a curve
 * point or a colour previews each change on the canvas and records one step when it is let go.
 */

// Changing the layer.

interface Edit {
  /** Hold changes until `end` (or the pointer coming up, with `untilPointerUp`): each one is previewed from where the hold began. */
  begin(untilPointerUp?: boolean): void
  /** A change to the layer as it was when the hold began (or as it is, recorded at once, when nothing is held). */
  change(label: string, patch: (layer: CanvasLayer) => Partial<CanvasLayer>): void
  end(): void
}

function useEdit(doc: CanvasDocument, id: string): Edit {
  const held = useRef<{ before: DocState; label: string | null } | null>(null)
  const edit = useRef<Edit | null>(null)

  if (!edit.current) {
    const end = () => {
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      const hold = held.current
      held.current = null

      if (hold) {
        doc.interacting = false

        if (hold.label) {
          doc.commitFrom(hold.label, hold.before)
        }
      }
    }

    edit.current = {
      begin: (untilPointerUp = true) => {
        if (held.current) {
          return
        }

        held.current = { before: doc.state, label: null }
        // Saving waits while the canvas shows a change not yet recorded.
        doc.interacting = true

        if (untilPointerUp) {
          window.addEventListener('pointerup', end)
          window.addEventListener('pointercancel', end)
        }
      },
      change: (label, patch) => {
        const hold = held.current
        const base = hold?.before ?? doc.state
        const layer = findLayer(base, id)

        if (!layer) {
          return
        }

        const next = withLayer(base, id, patch(layer))

        if (hold) {
          hold.label = label
          doc.preview(next)
        } else {
          doc.commit(label, next)
        }
      },
      end
    }
  }

  // A layer swapped out mid-drag still has its change recorded.
  useEffect(() => () => edit.current?.end(), [])

  return edit.current
}

// Controls.

const decimalsOf = (step: number): number => (Number.isInteger(step) ? 0 : Math.max(0, -Math.floor(Math.log10(step))))

const tidy = (value: number, step: number): number => Number((Math.round(value / step) * step).toFixed(decimalsOf(step)))

/** A number typed in: taken on Enter or when the field is left, when it is a number; held within the range. */
function NumberInput({ label, value, min, max, step, unit, onCommit }: { label: string; value: number; min: number; max: number; step: number; unit?: string; onCommit: (value: number) => void }) {
  const shown = (number: number) => String(tidy(number, step))
  const [draft, setDraft] = useState(shown(value))

  useEffect(() => setDraft(shown(value)), [value])

  const commit = () => {
    const number = Number(draft)

    if (draft.trim() !== '' && Number.isFinite(number)) {
      const next = tidy(Math.min(max, Math.max(min, number)), step)
      setDraft(shown(next))

      if (next !== value) {
        onCommit(next)
      }
    } else {
      setDraft(shown(value))
    }
  }

  return (
    <label className="flex items-center gap-1 text-fg-3">
      <input
        aria-label={label}
        value={draft}
        inputMode="decimal"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          event.stopPropagation()

          if (event.key === 'Enter') {
            event.currentTarget.blur()
          } else if (event.key === 'Escape') {
            setDraft(shown(value))
          } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault()
            const next = tidy(Math.min(max, Math.max(min, value + (event.key === 'ArrowUp' ? step : -step) * (event.shiftKey ? 10 : 1))), step)
            onCommit(next)
          }
        }}
        className="glass-input h-6 w-14 rounded-md px-1.5 text-right text-[12px] text-fg tabular-nums outline-none"
      />
      {unit && <span className="w-3 text-[11px]">{unit}</span>}
    </label>
  )
}

type Curve = 'linear' | 'square' | 'log'

const SLIDER_STEPS = 1000

/** A setting's slider and its number. Wide ranges move on a curve, so the small values get the room. */
function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  curve = 'linear',
  track,
  edit,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  curve?: Curve
  /** A strip under the slider showing what the ends mean (a CSS background). */
  track?: string
  edit: Edit
  onChange: (value: number) => void
}) {
  const t = (v: number) => Math.min(1, Math.max(0, curve === 'log' ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min)))
  const position = curve === 'square' ? Math.sqrt(t(value)) : t(value)
  const valueAt = (p: number) => tidy(curve === 'log' ? min * (max / min) ** p : min + (max - min) * (curve === 'square' ? p * p : p), step)

  return (
    <div className="px-3 py-1">
      <div className="flex h-6 items-center justify-between gap-2 text-[11.5px]">
        <span className="truncate text-fg-2">{label}</span>
        <NumberInput label={label} value={value} min={min} max={max} step={step} unit={unit} onCommit={onChange} />
      </div>
      <input
        type="range"
        aria-label={`${label} slider`}
        min={0}
        max={SLIDER_STEPS}
        value={Math.round(position * SLIDER_STEPS)}
        onPointerDown={() => edit.begin()}
        onChange={(event) => onChange(Math.min(max, Math.max(min, valueAt(Number(event.target.value) / SLIDER_STEPS))))}
        onKeyDown={(event) => event.stopPropagation()}
        className="h-1.5 w-full cursor-pointer accent-(--color-accent)"
      />
      {track && <div className="mt-0.5 h-1 rounded-full opacity-80" style={{ background: track }} />}
    </div>
  )
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex h-7 items-center gap-2 px-3 text-[12px] text-fg-2">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="accent-(--color-accent)" />
      {label}
    </label>
  )
}

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string }[]; onChange: (value: T) => void; label: string }) {
  return (
    <div className="mx-3 my-1.5 flex rounded-md bg-white/5 p-0.5 ring-1 ring-line" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          onClick={() => onChange(option.id)}
          className={cn('h-6 flex-1 rounded px-1 text-[11.5px]', value === option.id ? 'bg-white/14 text-fg' : 'text-fg-3 hover:text-fg')}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

const toBytes = (colour: RGB): Bytes => [Math.round(colour.red * 255), Math.round(colour.green * 255), Math.round(colour.blue * 255)]
const toUnit = ([red, green, blue]: Bytes): RGB => ({ red: red / 255, green: green / 255, blue: blue / 255 })

const PICKER_WIDTH = 224

/** A colour well; its picker opens beside the panel, and one session in it is one step. */
function Swatch({ label, colour, edit, onChange, className }: { label: string; colour: RGB; edit: Edit; onChange: (colour: RGB) => void; className?: string }) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  const button = useRef<HTMLButtonElement>(null)

  // Beside the panels, over the canvas, so the picker never hides the settings it changes.
  const open = () => {
    const rect = button.current!.getBoundingClientRect()
    const panels = button.current!.closest('aside')?.getBoundingClientRect() ?? rect
    edit.begin(false)
    setAt({ left: Math.max(8, panels.left - PICKER_WIDTH - 8), top: Math.max(8, Math.min(window.innerHeight - 330, rect.top - 60)) })
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        title={label}
        aria-label={label}
        onClick={() => (at ? null : open())}
        className={cn('block size-6 shrink-0 rounded-md ring-1 ring-white/40', className)}
        style={{ background: cssOf(toBytes(colour)) }}
      />
      {at &&
        createPortal(
          <div className="fixed z-50" style={{ left: at.left, top: at.top, width: PICKER_WIDTH }}>
            <ColorPicker
              title={label}
              colour={toBytes(colour)}
              onChange={(next) => onChange(toUnit(next))}
              onClose={() => {
                setAt(null)
                edit.end()
              }}
              className="relative"
            />
          </div>,
          document.body
        )}
    </>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex h-8 items-center justify-between gap-2 px-3 text-[11.5px] text-fg-2">
      <span>{label}</span>
      <div className="flex items-center gap-1.5">{children}</div>
    </div>
  )
}

const HUES = 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)'

// Adjustments.

interface AdjustmentProps {
  adjustment: Adjustment
  edit: Edit
  /** Change the adjustment as it was when the hold began. */
  set: (change: (adjustment: Adjustment) => Partial<Adjustment>) => void
}

function HueSaturationControls({ adjustment: a, edit, set }: AdjustmentProps) {
  const wrap = (hue: number) => ((hue % 360) + 360) % 360

  return (
    <>
      <Slider label="Hue" value={a.colorize ? wrap(a.hue) : a.hue} min={a.colorize ? 0 : -180} max={a.colorize ? 360 : 180} unit="°" track={HUES} edit={edit} onChange={(hue) => set(() => ({ hue }))} />
      <Slider label="Saturation" value={a.saturation} min={a.colorize ? 0 : -100} max={100} edit={edit} onChange={(saturation) => set(() => ({ saturation }))} />
      <Slider label="Lightness" value={a.lightness} min={-100} max={100} track="linear-gradient(to right, #000, #888, #fff)" edit={edit} onChange={(lightness) => set(() => ({ lightness }))} />
      <Check
        label="Colorize"
        checked={a.colorize}
        onChange={(colorize) =>
          // Colorizing starts at a quarter saturation, as photo editors do; back again, the hue returns to ±180.
          set((current) => (colorize ? { colorize, hue: wrap(current.hue), saturation: current.saturation > 0 ? current.saturation : 25 } : { colorize, hue: wrap(current.hue) > 180 ? wrap(current.hue) - 360 : wrap(current.hue) }))
        }
      />
    </>
  )
}

const CHANNEL_OPTIONS = CHANNELS.map((channel) => ({ id: channel, label: channel }))

function LevelsControls({ adjustment: a, edit, set }: AdjustmentProps) {
  const [channel, setChannel] = useState<Channel>(a.levels.channel)
  const index = CHANNELS.indexOf(channel)
  const range = a.levels.ranges[index]
  const setRange = (change: (range: LevelRange) => Partial<LevelRange>) =>
    set((current) => ({ levels: { ...current.levels, ranges: current.levels.ranges.map((entry, i) => (i === index ? { ...entry, ...change(entry) } : entry)) as typeof current.levels.ranges } }))

  return (
    <>
      <Segmented label="Channel" value={channel} options={CHANNEL_OPTIONS} onChange={setChannel} />
      <Slider label="Shadows" value={range.black} min={0} max={253} edit={edit} onChange={(black) => setRange((r) => ({ black: Math.min(black, r.white - 2) }))} />
      <Slider label="Midtones" value={range.gamma} min={0.1} max={9.99} step={0.01} curve="log" edit={edit} onChange={(gamma) => setRange(() => ({ gamma }))} />
      <Slider label="Highlights" value={range.white} min={2} max={255} edit={edit} onChange={(white) => setRange((r) => ({ white: Math.max(white, r.black + 2) }))} />
      <Slider label="Output black" value={range.outputBlack} min={0} max={255} track="linear-gradient(to right, #000, #fff)" edit={edit} onChange={(outputBlack) => setRange(() => ({ outputBlack }))} />
      <Slider label="Output white" value={range.outputWhite} min={0} max={255} track="linear-gradient(to right, #000, #fff)" edit={edit} onChange={(outputWhite) => setRange(() => ({ outputWhite }))} />
    </>
  )
}

const CURVE_COLOURS: Record<Channel, string> = { RGB: 'var(--color-fg)', Red: '#ff6b6b', Green: '#5fd38d', Blue: '#5aa2ff' }

/** Points past this far outside the box (in screen pixels) are dragged off the curve. */
const REMOVE_REACH = 24
const MAX_POINTS = 32

/**
 * The curve of one channel: drag a point, click to add one, drag a point out of the box to take it
 * away. The two ends stay at the left and right edges.
 */
function CurvesEditor({ points, colour, edit, onChange }: { points: CurvePoint[]; colour: string; edit: Edit; onChange: (points: CurvePoint[]) => void }) {
  const box = useRef<SVGSVGElement>(null)
  const drag = useRef<{ index: number; points: CurvePoint[] } | null>(null)
  const table = useMemo(() => curveTable(points), [points])
  const path = useMemo(() => Array.from(table, (value, x) => `${x === 0 ? 'M' : 'L'}${x} ${(1 - value) * 255}`).join(' '), [table])

  const read = (event: React.PointerEvent) => {
    const rect = box.current!.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width) * 255
    const y = (1 - (event.clientY - rect.top) / rect.height) * 255
    const outside = Math.max(rect.left - event.clientX, event.clientX - rect.right, rect.top - event.clientY, event.clientY - rect.bottom)

    return { x, y, outside, perUnit: rect.width / 255 }
  }

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    const { x, y, perUnit } = read(event)
    let index = points.findIndex((point) => Math.hypot(point.x - x, point.y - y) * perUnit <= 9)
    let next = points

    if (index < 0) {
      const at = Math.round(x)
      const after = points.findIndex((point) => point.x > at)

      if (points.length >= MAX_POINTS || after <= 0 || points.some((point) => Math.abs(point.x - at) < 2)) {
        return
      }

      next = [...points.slice(0, after), { x: at, y: Math.round(Math.min(255, Math.max(0, y))) }, ...points.slice(after)]
      index = after
    }

    event.currentTarget.setPointerCapture(event.pointerId)
    edit.begin()
    drag.current = { index, points: next }

    if (next !== points) {
      onChange(next)
    }
  }

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const held = drag.current

    if (!held) {
      return
    }

    const { x, y, outside } = read(event)
    const { index, points: base } = held
    const interior = index > 0 && index < base.length - 1

    if (interior && outside > REMOVE_REACH) {
      onChange(base.filter((_, i) => i !== index))

      return
    }

    const low = interior ? base[index - 1].x + 1 : base[index].x
    const high = interior ? base[index + 1].x - 1 : base[index].x
    const moved = { x: Math.round(Math.min(high, Math.max(low, x))), y: Math.round(Math.min(255, Math.max(0, y))) }
    onChange(base.map((point, i) => (i === index ? moved : point)))
  }

  return (
    <div className="px-3 py-1.5">
      <svg
        ref={box}
        viewBox="0 0 255 255"
        className="aspect-square w-full cursor-crosshair touch-none rounded-md bg-black/25 ring-1 ring-line"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => (drag.current = null)}
      >
        {[64, 128, 191].map((at) => (
          <g key={at} stroke="currentColor" className="text-white/10" strokeWidth={0.8}>
            <line x1={at} y1={0} x2={at} y2={255} />
            <line x1={0} y1={at} x2={255} y2={at} />
          </g>
        ))}
        <line x1={0} y1={255} x2={255} y2={0} stroke="currentColor" className="text-white/15" strokeDasharray="3 4" strokeWidth={0.8} />
        <path d={path} fill="none" stroke={colour} strokeWidth={1.6} />
        {points.map((point, i) => (
          <circle key={i} cx={point.x} cy={255 - point.y} r={4} fill="var(--color-bg, #111)" stroke={colour} strokeWidth={1.6} />
        ))}
      </svg>
      <div className="mt-1 text-[10.5px] text-fg-3">Drag a point, click to add one, drag it out of the box to remove it.</div>
    </div>
  )
}

function CurvesControls({ adjustment: a, edit, set }: AdjustmentProps) {
  const [channel, setChannel] = useState<Channel>(a.curves.channel)
  const index = CHANNELS.indexOf(channel)

  return (
    <>
      <Segmented label="Channel" value={channel} options={CHANNEL_OPTIONS} onChange={setChannel} />
      <CurvesEditor
        points={a.curves.channels[index]}
        colour={CURVE_COLOURS[channel]}
        edit={edit}
        onChange={(points) => set((current) => ({ curves: { ...current.curves, channels: current.curves.channels.map((entry, i) => (i === index ? points : entry)) as typeof current.curves.channels } }))}
      />
      <button
        type="button"
        onClick={() =>
          set((current) => ({
            curves: {
              ...current.curves,
              channels: current.curves.channels.map((entry, i) => (i === index ? defaultAdjustment('Curves').curves.channels[0] : entry)) as typeof current.curves.channels
            }
          }))
        }
        className="mx-3 mb-1 text-[11.5px] text-fg-3 hover:text-fg"
      >
        Reset {channel === 'RGB' ? 'the curve' : `the ${channel.toLowerCase()} curve`}
      </button>
    </>
  )
}

function ExposureControls({ adjustment, edit, set }: AdjustmentProps) {
  const settings = resolved(adjustment).exposure
  const put = (change: Partial<typeof settings>) => set((current) => ({ exposureSettings: { ...resolved(current).exposure, ...change } }))

  return (
    <>
      <Slider label="Exposure" value={settings.exposure} min={RANGES.exposure[0]} max={RANGES.exposure[1]} step={0.01} unit="EV" edit={edit} onChange={(exposure) => put({ exposure })} />
      <Slider label="Offset" value={settings.offset} min={RANGES.exposureOffset[0]} max={RANGES.exposureOffset[1]} step={0.001} edit={edit} onChange={(offset) => put({ offset })} />
      <Slider label="Gamma" value={settings.gamma} min={RANGES.exposureGamma[0]} max={RANGES.exposureGamma[1]} step={0.01} curve="log" edit={edit} onChange={(gamma) => put({ gamma })} />
    </>
  )
}

function GradientMapControls({ adjustment, edit, set }: AdjustmentProps) {
  const settings = resolved(adjustment).gradientMap
  const put = (change: Partial<typeof settings>) => set((current) => ({ gradientMapSettings: { ...resolved(current).gradientMap, ...change } }))
  // Each well sits at the end of the bar it colours, so reversing swaps which record field it edits.
  const [dark, light] = settings.reversed ? (['highlights', 'shadows'] as const) : (['shadows', 'highlights'] as const)

  return (
    <>
      <div className="flex items-center gap-2 px-3 py-2">
        <Swatch label="Colour for dark tones" colour={settings[dark]} edit={edit} onChange={(colour) => put({ [dark]: colour })} />
        <div className="h-4 flex-1 rounded ring-1 ring-line" style={{ background: `linear-gradient(to right, ${cssOf(toBytes(settings[dark]))}, ${cssOf(toBytes(settings[light]))})` }} />
        <Swatch label="Colour for light tones" colour={settings[light]} edit={edit} onChange={(colour) => put({ [light]: colour })} />
      </div>
      <Check label="Reverse" checked={settings.reversed} onChange={(reversed) => put({ reversed })} />
    </>
  )
}

const freshSeed = (): number => crypto.getRandomValues(new Uint32Array(1))[0]

function SeedRow({ seed, onChange }: { seed: number; onChange: (seed: number) => void }) {
  return (
    <Row label="Pattern">
      <NumberInput label="Seed" value={seed} min={0} max={4_294_967_295} step={1} onCommit={onChange} />
      <button type="button" title="A new pattern" aria-label="A new pattern" onClick={() => onChange(freshSeed())} className="grid size-6 place-items-center rounded-md text-fg-3 ring-1 ring-line hover:text-fg">
        <IconArrowsShuffle size={13} />
      </button>
    </Row>
  )
}

function GrainControls({ adjustment, edit, set }: AdjustmentProps) {
  const settings = resolved(adjustment).grain
  const put = (change: Partial<typeof settings>) => set((current) => ({ grainSettings: { ...resolved(current).grain, ...change } }))

  return (
    <>
      <Slider label="Amount" value={settings.amount} min={RANGES.grainAmount[0]} max={RANGES.grainAmount[1]} edit={edit} onChange={(amount) => put({ amount })} />
      <Slider label="Size" value={settings.size} min={RANGES.grainSize[0]} max={RANGES.grainSize[1]} step={0.1} curve="square" unit="px" edit={edit} onChange={(size) => put({ size })} />
      <Slider label="Roughness" value={settings.roughness} min={RANGES.grainRoughness[0]} max={RANGES.grainRoughness[1]} edit={edit} onChange={(roughness) => put({ roughness })} />
      <SeedRow seed={settings.seed} onChange={(seed) => put({ seed })} />
    </>
  )
}

const FAMILIES: { key: 'reds' | 'yellows' | 'greens' | 'cyans' | 'blues' | 'magentas'; label: string; colour: string }[] = [
  { key: 'reds', label: 'Reds', colour: '#f33' },
  { key: 'yellows', label: 'Yellows', colour: '#fd2' },
  { key: 'greens', label: 'Greens', colour: '#3c3' },
  { key: 'cyans', label: 'Cyans', colour: '#2dd' },
  { key: 'blues', label: 'Blues', colour: '#36f' },
  { key: 'magentas', label: 'Magentas', colour: '#e3e' }
]

function BlackWhiteControls({ adjustment, edit, set }: AdjustmentProps) {
  const settings = resolved(adjustment).blackWhite
  const put = (change: Partial<typeof settings>) => set((current) => ({ blackWhiteSettings: { ...resolved(current).blackWhite, ...change } }))

  return (
    <>
      {FAMILIES.map((family) => (
        <Slider
          key={family.key}
          label={family.label}
          value={settings[family.key]}
          min={RANGES.blackWhite[0]}
          max={RANGES.blackWhite[1]}
          unit="%"
          track={`linear-gradient(to right, #000, ${family.colour})`}
          edit={edit}
          onChange={(value) => put({ [family.key]: value } as Partial<typeof settings>)}
        />
      ))}
      <Check label="Tint" checked={settings.tint} onChange={(tint) => put({ tint })} />
      {settings.tint && (
        <>
          <Slider label="Tint hue" value={settings.tintHue} min={RANGES.tintHue[0]} max={RANGES.tintHue[1]} unit="°" track={HUES} edit={edit} onChange={(tintHue) => put({ tintHue })} />
          <Slider label="Tint saturation" value={settings.tintSaturation} min={RANGES.tintSaturation[0]} max={RANGES.tintSaturation[1]} unit="%" edit={edit} onChange={(tintSaturation) => put({ tintSaturation })} />
        </>
      )}
    </>
  )
}

type Tone = 'shadow' | 'mid' | 'highlight'

function ColorBalanceControls({ adjustment, edit, set }: AdjustmentProps) {
  const [tone, setTone] = useState<Tone>('mid')
  const settings = resolved(adjustment).colorBalance
  const put = (change: Partial<typeof settings>) => set((current) => ({ colorBalanceSettings: { ...resolved(current).colorBalance, ...change } }))
  const pairs = [
    { key: `${tone}CyanRed`, label: 'Cyan · Red', track: 'linear-gradient(to right, #0ff, #888, #f00)' },
    { key: `${tone}MagentaGreen`, label: 'Magenta · Green', track: 'linear-gradient(to right, #f0f, #888, #0f0)' },
    { key: `${tone}YellowBlue`, label: 'Yellow · Blue', track: 'linear-gradient(to right, #ff0, #888, #00f)' }
  ] as const

  return (
    <>
      <Segmented<Tone>
        label="Tone"
        value={tone}
        onChange={setTone}
        options={[
          { id: 'shadow', label: 'Shadows' },
          { id: 'mid', label: 'Midtones' },
          { id: 'highlight', label: 'Highlights' }
        ]}
      />
      {pairs.map((pair) => (
        <Slider key={pair.key} label={pair.label} value={settings[pair.key]} min={RANGES.colorBalance[0]} max={RANGES.colorBalance[1]} track={pair.track} edit={edit} onChange={(value) => put({ [pair.key]: value } as Partial<typeof settings>)} />
      ))}
      <Check label="Preserve luminosity" checked={settings.preserveLuminosity} onChange={(preserveLuminosity) => put({ preserveLuminosity })} />
    </>
  )
}

function BlurControls({ adjustment, edit, set }: AdjustmentProps) {
  const settings = resolved(adjustment)

  if (adjustment.kind === 'Gaussian Blur') {
    return <Slider label="Radius" value={settings.blurRadius} min={RANGES.blurRadius[0]} max={RANGES.blurRadius[1]} step={0.1} curve="square" unit="px" edit={edit} onChange={(blurRadius) => set(() => ({ blurRadius }))} />
  }

  return (
    <>
      <Slider label="Angle" value={settings.motionAngle} min={RANGES.motionAngle[0]} max={RANGES.motionAngle[1]} unit="°" edit={edit} onChange={(motionAngle) => set(() => ({ motionAngle }))} />
      <Slider label="Distance" value={settings.motionDistance} min={RANGES.motionDistance[0]} max={RANGES.motionDistance[1]} curve="square" unit="px" edit={edit} onChange={(motionDistance) => set(() => ({ motionDistance }))} />
    </>
  )
}

function NoiseControls({ adjustment, edit, set }: AdjustmentProps) {
  const settings = resolved(adjustment).noise

  return (
    <>
      <Slider label="Amount" value={settings.amount} min={RANGES.noiseAmount[0]} max={RANGES.noiseAmount[1]} step={0.1} curve="square" unit="%" edit={edit} onChange={(noiseAmount) => set(() => ({ noiseAmount }))} />
      <Segmented
        label="Distribution"
        value={settings.gaussian ? 'gaussian' : 'uniform'}
        onChange={(value) => set(() => ({ noiseGaussian: value === 'gaussian' }))}
        options={[
          { id: 'uniform', label: 'Uniform' },
          { id: 'gaussian', label: 'Gaussian' }
        ]}
      />
      <Check label="Monochromatic" checked={settings.monochromatic} onChange={(noiseMonochromatic) => set(() => ({ noiseMonochromatic }))} />
      <SeedRow seed={settings.seed} onChange={(noiseSeed) => set(() => ({ noiseSeed }))} />
    </>
  )
}

// Veritas's own adjustments: each change sets the settings and their stand-in together.

interface HeraldProps<K extends HeraldAdjustment['kind']> {
  settings: Extract<HeraldAdjustment, { kind: K }>
  edit: Edit
  /** Change the settings as they were when the hold began. */
  set: (change: (settings: Extract<HeraldAdjustment, { kind: K }>) => Partial<Extract<HeraldAdjustment, { kind: K }>>) => void
}

const GRAYS = 'linear-gradient(to right, #000, #fff)'

function BrightnessContrastControls({ settings, edit, set }: HeraldProps<'Brightness/Contrast'>) {
  return (
    <>
      <Slider label="Brightness" value={settings.brightness} min={HERALD_RANGES.brightness[0]} max={HERALD_RANGES.brightness[1]} track={GRAYS} edit={edit} onChange={(brightness) => set(() => ({ brightness }))} />
      <Slider label="Contrast" value={settings.contrast} min={HERALD_RANGES.contrast[0]} max={HERALD_RANGES.contrast[1]} edit={edit} onChange={(contrast) => set(() => ({ contrast }))} />
    </>
  )
}

function VibranceControls({ settings, edit, set }: HeraldProps<'Vibrance'>) {
  return (
    <>
      <Slider label="Vibrance" value={settings.vibrance} min={HERALD_RANGES.vibrance[0]} max={HERALD_RANGES.vibrance[1]} track="linear-gradient(to right, #8a8a8a, #c96, #36f)" edit={edit} onChange={(vibrance) => set(() => ({ vibrance }))} />
      <Slider label="Saturation" value={settings.saturation} min={HERALD_RANGES.saturation[0]} max={HERALD_RANGES.saturation[1]} track="linear-gradient(to right, #888, #f33)" edit={edit} onChange={(saturation) => set(() => ({ saturation }))} />
    </>
  )
}

/** Photo Filter colours to start from; any other colour is the person's own. */
const FILTERS: { label: string; colour: Bytes }[] = [
  { label: 'Warm', colour: [236, 138, 0] },
  { label: 'Cool', colour: [0, 109, 255] },
  { label: 'Sepia', colour: [172, 122, 51] },
  { label: 'Underwater', colour: [0, 193, 177] },
  { label: 'Red', colour: [234, 26, 26] },
  { label: 'Orange', colour: [243, 132, 23] },
  { label: 'Yellow', colour: [249, 227, 28] },
  { label: 'Green', colour: [25, 201, 25] },
  { label: 'Cyan', colour: [29, 203, 234] },
  { label: 'Blue', colour: [29, 53, 234] },
  { label: 'Violet', colour: [155, 29, 234] },
  { label: 'Magenta', colour: [227, 24, 227] }
]

function PhotoFilterControls({ settings, edit, set }: HeraldProps<'Photo Filter'>) {
  const bytes = toBytes(settings.color)
  const preset = FILTERS.findIndex((filter) => filter.colour.every((value, i) => value === bytes[i]))

  return (
    <>
      <Row label="Filter">
        <select
          aria-label="Filter colour"
          value={preset}
          onChange={(event) => {
            const chosen = FILTERS[Number(event.target.value)]

            if (chosen) {
              set(() => ({ color: toUnit(chosen.colour) }))
            }
          }}
          onKeyDown={(event) => event.stopPropagation()}
          className="glass-input h-6 rounded-md px-1 text-[12px] text-fg outline-none"
        >
          {preset < 0 && <option value={-1}>Own colour</option>}
          {FILTERS.map((filter, i) => (
            <option key={filter.label} value={i}>
              {filter.label}
            </option>
          ))}
        </select>
        <Swatch label="Filter colour" colour={settings.color} edit={edit} onChange={(color) => set(() => ({ color }))} />
      </Row>
      <Slider label="Density" value={settings.density} min={HERALD_RANGES.density[0]} max={HERALD_RANGES.density[1]} unit="%" edit={edit} onChange={(density) => set(() => ({ density }))} />
      <Check label="Preserve luminosity" checked={settings.preserveLuminosity} onChange={(preserveLuminosity) => set(() => ({ preserveLuminosity }))} />
    </>
  )
}

type MixerOutput = 'red' | 'green' | 'blue'

function ChannelMixerControls({ settings, edit, set }: HeraldProps<'Channel Mixer'>) {
  const [output, setOutput] = useState<MixerOutput>('red')
  const key = settings.monochrome ? 'gray' : output
  const row = settings[key]
  const put = (change: Partial<MixerRow>) => set((current) => ({ [key]: { ...current[key], ...change } }))
  const total = Math.round(row.red + row.green + row.blue)

  return (
    <>
      {!settings.monochrome && (
        <Segmented<MixerOutput>
          label="Output channel"
          value={output}
          onChange={setOutput}
          options={[
            { id: 'red', label: 'Red' },
            { id: 'green', label: 'Green' },
            { id: 'blue', label: 'Blue' }
          ]}
        />
      )}
      {(['red', 'green', 'blue'] as const).map((source) => (
        <Slider
          key={source}
          label={source[0].toUpperCase() + source.slice(1)}
          value={row[source]}
          min={HERALD_RANGES.mixer[0]}
          max={HERALD_RANGES.mixer[1]}
          unit="%"
          track={`linear-gradient(to right, #000, ${source === 'red' ? '#f33' : source === 'green' ? '#3c3' : '#36f'})`}
          edit={edit}
          onChange={(value) => put({ [source]: value })}
        />
      ))}
      <Slider label="Constant" value={row.constant} min={HERALD_RANGES.mixer[0]} max={HERALD_RANGES.mixer[1]} unit="%" track={GRAYS} edit={edit} onChange={(constant) => put({ constant })} />
      <div className={cn('px-3 pb-1 text-[11px]', total > 100 ? 'text-amber-300/90' : 'text-fg-3')}>Total {total}%{total > 100 ? ': brighter than the original, and may clip' : ''}</div>
      <Check label="Monochrome" checked={settings.monochrome} onChange={(monochrome) => set(() => ({ monochrome }))} />
    </>
  )
}

const RANGE_LABELS: Record<SelectiveRange, string> = {
  reds: 'Reds',
  yellows: 'Yellows',
  greens: 'Greens',
  cyans: 'Cyans',
  blues: 'Blues',
  magentas: 'Magentas',
  whites: 'Whites',
  neutrals: 'Neutrals',
  blacks: 'Blacks'
}

const INKS: { key: keyof Inks; label: string; track: string }[] = [
  { key: 'cyan', label: 'Cyan', track: 'linear-gradient(to right, #f33, #888, #0ff)' },
  { key: 'magenta', label: 'Magenta', track: 'linear-gradient(to right, #3c3, #888, #f0f)' },
  { key: 'yellow', label: 'Yellow', track: 'linear-gradient(to right, #36f, #888, #ff0)' },
  { key: 'black', label: 'Black', track: 'linear-gradient(to right, #fff, #888, #000)' }
]

function SelectiveColorControls({ settings, edit, set }: HeraldProps<'Selective Color'>) {
  const [range, setRange] = useState<SelectiveRange>('reds')
  const inks = settings[range]

  return (
    <>
      <Row label="Colours">
        <select aria-label="Colour range" value={range} onChange={(event) => setRange(event.target.value as SelectiveRange)} onKeyDown={(event) => event.stopPropagation()} className="glass-input h-6 rounded-md px-1 text-[12px] text-fg outline-none">
          {SELECTIVE_RANGES.map((entry) => (
            <option key={entry} value={entry}>
              {RANGE_LABELS[entry]}
            </option>
          ))}
        </select>
      </Row>
      {INKS.map((ink) => (
        <Slider
          key={ink.key}
          label={ink.label}
          value={inks[ink.key]}
          min={HERALD_RANGES.inks[0]}
          max={HERALD_RANGES.inks[1]}
          unit="%"
          track={ink.track}
          edit={edit}
          onChange={(value) => set((current) => ({ [range]: { ...current[range], [ink.key]: value } }))}
        />
      ))}
      <Segmented
        label="Method"
        value={settings.absolute ? 'absolute' : 'relative'}
        onChange={(value) => set(() => ({ absolute: value === 'absolute' }))}
        options={[
          { id: 'relative', label: 'Relative' },
          { id: 'absolute', label: 'Absolute' }
        ]}
      />
    </>
  )
}

function PosterizeControls({ settings, edit, set }: HeraldProps<'Posterize'>) {
  return <Slider label="Levels" value={settings.levels} min={HERALD_RANGES.posterize[0]} max={HERALD_RANGES.posterize[1]} curve="log" edit={edit} onChange={(levels) => set(() => ({ levels: Math.round(levels) }))} />
}

function ThresholdControls({ settings, edit, set }: HeraldProps<'Threshold'>) {
  return <Slider label="Threshold level" value={settings.level} min={HERALD_RANGES.threshold[0]} max={HERALD_RANGES.threshold[1]} track={GRAYS} edit={edit} onChange={(level) => set(() => ({ level: Math.round(level) }))} />
}

function ColorLookupControls({ layer, settings, edit }: { layer: CanvasLayer; settings: Extract<HeraldAdjustment, { kind: 'Color Lookup' }>; edit: Edit }) {
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    const [file] = await window.heraldOS.fs.pickFiles({})

    if (!file) {
      return
    }

    try {
      const table = parseCube(await window.heraldOS.canvas.readTable(file))
      const name = file.split('/').pop() ?? file
      setError(null)
      edit.change('Color Lookup', () => ({ table, ...withVeritas({ ...settings, name, size: table.size }) }))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(failure))
    }
  }

  return (
    <div className="px-3 py-2 text-[12px] text-fg-2">
      {settings.size > 0 ? (
        <div className="flex items-center gap-1.5">
          <IconCube3dSphere size={14} className="shrink-0 text-fg-3" />
          <span className="min-w-0 flex-1 truncate" title={layer.table?.title || settings.name}>
            {settings.name || layer.table?.title || 'Colour table'}
          </span>
          <span className="text-fg-3 tabular-nums">
            {settings.size}
            <sup>3</sup>
          </span>
        </div>
      ) : (
        <div className="text-fg-3">No table yet: load a .cube file (a 3D colour lookup table, as grading tools save them).</div>
      )}
      <button type="button" onClick={() => void load()} className="mt-2 h-7 rounded-md px-2.5 text-[12px] text-fg ring-1 ring-line hover:bg-white/8">
        {settings.size > 0 ? 'Load another table…' : 'Load a table…'}
      </button>
      {error && <div className="mt-2 text-[11.5px] text-red-300">{error}</div>}
    </div>
  )
}

/** The controls of a Veritas-only adjustment; a kind from a newer Veritas Canvas only says what it is. */
function HeraldControls({ layer, edit }: { layer: CanvasLayer; edit: Edit }) {
  const settings = heraldOf(layer)

  if (!settings) {
    return <div className="px-3 py-2 text-[12px] text-fg-3">{String(layer.heraldAdjustment?.kind)} comes from a newer Veritas Canvas: it shows as its stand-in here, and keeps its settings for that version.</div>
  }

  const set = (change: (settings: HeraldAdjustment) => Partial<HeraldAdjustment>) =>
    edit.change(settings.kind, (current) => {
      const now = heraldOf(current) ?? settings

      return withVeritas({ ...now, ...change(now) } as HeraldAdjustment)
    })
  const props = { edit, set: set as never }

  switch (settings.kind) {
    case 'Brightness/Contrast':
      return <BrightnessContrastControls settings={settings} {...props} />
    case 'Vibrance':
      return <VibranceControls settings={settings} {...props} />
    case 'Photo Filter':
      return <PhotoFilterControls settings={settings} {...props} />
    case 'Channel Mixer':
      return <ChannelMixerControls settings={settings} {...props} />
    case 'Selective Color':
      return <SelectiveColorControls settings={settings} {...props} />
    case 'Posterize':
      return <PosterizeControls settings={settings} {...props} />
    case 'Threshold':
      return <ThresholdControls settings={settings} {...props} />
    case 'Color Lookup':
      return <ColorLookupControls layer={layer} settings={settings} edit={edit} />
  }
}

const CONTROLS: Partial<Record<Adjustment['kind'], (props: AdjustmentProps) => React.ReactNode>> = {
  'Hue/Saturation': HueSaturationControls,
  Levels: LevelsControls,
  Curves: CurvesControls,
  Exposure: ExposureControls,
  'Gradient Map': GradientMapControls,
  Grain: GrainControls,
  'Black & White': BlackWhiteControls,
  'Color Balance': ColorBalanceControls,
  'Gaussian Blur': BlurControls,
  'Motion Blur': BlurControls,
  'Add Noise': NoiseControls
}

function AdjustmentControls({ layer, edit }: { layer: CanvasLayer; edit: Edit }) {
  if (layer.heraldAdjustment) {
    return <HeraldControls layer={layer} edit={edit} />
  }

  const adjustment = layer.adjustment!
  const Controls = CONTROLS[adjustment.kind]
  const set = (change: (adjustment: Adjustment) => Partial<Adjustment>) => edit.change(adjustment.kind, (current) => ({ adjustment: { ...current.adjustment!, ...change(current.adjustment!) } }))

  return Controls ? <Controls adjustment={adjustment} edit={edit} set={set} /> : <div className="px-3 py-2 text-[12px] text-fg-3">Invert has no settings: it turns every colour below into its opposite.</div>
}

// Effects.

type EffectRecord = NonNullable<LayerEffects[EffectKind]>

function EffectFields({ kind, record, edit, put }: { kind: EffectKind; record: EffectRecord; edit: Edit; put: (change: Partial<EffectRecord>) => void }) {
  const fields: React.ReactNode[] = []
  const colour = (
    <Row key="colour" label="Colour">
      <Swatch label={`${EFFECT_NAMES[kind]} colour`} colour={record} edit={edit} onChange={(next) => put(next)} />
    </Row>
  )
  const opacity = <Slider key="opacity" label="Opacity" value={Math.round(record.opacity * 100)} min={0} max={100} unit="%" edit={edit} onChange={(value) => put({ opacity: value / 100 })} />

  if (kind === 'stroke' && 'inside' in record) {
    fields.push(
      <Slider key="size" label="Size" value={record.size} min={RANGES.strokeSize[0]} max={RANGES.strokeSize[1]} curve="square" unit="px" edit={edit} onChange={(size) => put({ size })} />,
      <Segmented
        key="position"
        label="Position"
        value={record.inside ? 'inside' : 'outside'}
        onChange={(value) => put({ inside: value === 'inside' })}
        options={[
          { id: 'outside', label: 'Outside' },
          { id: 'inside', label: 'Inside' }
        ]}
      />
    )
  } else if ((kind === 'shadow' || kind === 'innerShadow') && 'angle' in record) {
    fields.push(
      // A dial's worth of angles; the format takes any turn from −360° to 360°.
      <Slider key="angle" label="Angle" value={record.angle} min={-180} max={180} unit="°" edit={edit} onChange={(angle) => put({ angle })} />,
      <Slider key="distance" label="Distance" value={record.distance} min={RANGES.shadowDistance[0]} max={RANGES.shadowDistance[1]} curve="square" unit="px" edit={edit} onChange={(distance) => put({ distance })} />,
      <Slider key="blur" label="Size" value={record.blur} min={RANGES.shadowBlur[0]} max={RANGES.shadowBlur[1]} curve="square" unit="px" edit={edit} onChange={(blur) => put({ blur })} />
    )
  } else if ((kind === 'outerGlow' || kind === 'innerGlow') && 'size' in record) {
    fields.push(<Slider key="size" label="Size" value={record.size} min={RANGES.glowSize[0]} max={RANGES.glowSize[1]} curve="square" unit="px" edit={edit} onChange={(size) => put({ size })} />)
  }

  return (
    <div className="pb-1.5">
      {fields}
      {colour}
      {opacity}
    </div>
  )
}

function EffectsList({ layer, edit }: { layer: CanvasLayer; edit: Edit }) {
  const [open, setOpen] = useState<EffectKind | null>(() => EFFECT_ORDER.find((kind) => layer.effects?.[kind]) ?? null)
  const put = (kind: EffectKind, record: EffectRecord | undefined, label = EFFECT_NAMES[kind]) =>
    edit.change(label, (current) => ({ effects: withEffect(current.effects, kind, record && ({ ...(current.effects?.[kind] ?? {}), ...record } as EffectRecord)) }))

  return (
    <div className="py-1">
      {EFFECT_ORDER.map((kind) => {
        const record = layer.effects?.[kind] as EffectRecord | undefined
        const Icon = EFFECT_ICONS[kind]
        const shown = Boolean(record) && record!.enabled !== false

        return (
          <div key={kind} className="border-b border-line/40 last:border-b-0">
            <div className="flex h-8 items-center gap-2 pr-2 pl-3">
              <input
                type="checkbox"
                aria-label={record ? `Show ${EFFECT_NAMES[kind]}` : `Add ${EFFECT_NAMES[kind]}`}
                checked={shown}
                onChange={() => {
                  if (record) {
                    put(kind, { ...record, enabled: !shown } as EffectRecord, shown ? `Hide ${EFFECT_NAMES[kind]}` : `Show ${EFFECT_NAMES[kind]}`)
                  } else {
                    put(kind, defaultEffect[kind]())
                    setOpen(kind)
                  }
                }}
                className="accent-(--color-accent)"
              />
              <button
                type="button"
                onClick={() => {
                  if (!record) {
                    put(kind, defaultEffect[kind]())
                  }

                  setOpen(open === kind && record ? null : kind)
                }}
                className={cn('flex min-w-0 flex-1 items-center gap-1.5 text-left text-[12px]', record ? 'text-fg-2' : 'text-fg-3', record && !shown && 'opacity-60')}
              >
                <Icon size={13} className="shrink-0 text-fg-3" />
                <span className="truncate">{EFFECT_NAMES[kind]}</span>
              </button>
              {record && (
                <button type="button" title={`Remove ${EFFECT_NAMES[kind]}`} aria-label={`Remove ${EFFECT_NAMES[kind]}`} onClick={() => put(kind, undefined, `Remove ${EFFECT_NAMES[kind]}`)} className="grid size-6 place-items-center rounded text-fg-3 hover:text-fg">
                  <IconTrash size={13} />
                </button>
              )}
              {record && <span className="text-fg-3">{open === kind ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}</span>}
            </div>
            {open === kind && record && <EffectFields kind={kind} record={record} edit={edit} put={(change) => put(kind, { ...record, ...change } as EffectRecord)} />}
          </div>
        )
      })}
    </div>
  )
}

// Masks.

function MaskControls({ doc, layer }: { doc: CanvasDocument; layer: CanvasLayer }) {
  const enabled = layer.maskEnabled !== false
  const linked = layer.maskLinked !== false
  const buttons = [
    { label: enabled ? 'Disable the mask (⇧-click its thumbnail)' : 'Enable the mask', icon: enabled ? <IconEye size={14} /> : <IconEyeOff size={14} />, run: () => maskAction(doc, enabled ? 'disable' : 'enable', layer) },
    { label: linked ? 'Unlink: the mask stays where it is when the layer moves' : 'Link the mask to the layer again', icon: linked ? <IconLink size={14} /> : <IconLinkOff size={14} />, run: () => maskAction(doc, linked ? 'unlink' : 'link', layer) },
    { label: 'Invert the mask', icon: <IconContrast size={14} />, run: () => maskAction(doc, 'invert', layer) },
    ...(layer.pixels ? [{ label: 'Apply the mask to the pixels', icon: <IconStack2 size={14} />, run: () => maskAction(doc, 'apply', layer) }] : []),
    { label: 'Delete the mask', icon: <IconTrash size={14} />, run: () => maskAction(doc, 'remove', layer) }
  ]

  return (
    <div className="flex items-center gap-1 border-t border-line px-3 py-1.5">
      <IconMask size={14} className="text-fg-3" />
      <span className="flex-1 text-[11.5px] text-fg-2">Mask{enabled ? '' : ' (off)'}</span>
      {buttons.map((button) => (
        <button key={button.label} type="button" title={button.label} aria-label={button.label} onClick={button.run} className="grid size-6 place-items-center rounded-md text-fg-3 hover:bg-white/8 hover:text-fg">
          {button.icon}
        </button>
      ))}
    </div>
  )
}

// Shapes.

const SHAPE_KINDS: { id: ShapeKind; label: string }[] = [
  { id: 'Rectangle', label: 'Rectangle' },
  { id: 'Ellipse', label: 'Ellipse' },
  { id: 'Line', label: 'Line' }
]

/** A shape layer's kind, colour, corner radius or line width, drawn again in its box on each change. */
function ShapeControls({ layer, edit }: { layer: CanvasLayer; edit: Edit }) {
  const shape = layer.shape!
  const box = { width: Math.abs(layer.transform.size[0]), height: Math.abs(layer.transform.size[1]) }
  const restyle = (label: string, change: (current: ShapeStyle) => ShapeStyle) => edit.change(label, (current) => (current.shape ? restyleShape(current, change(current.shape)) : {}))

  return (
    <div className="border-b border-line/40 pb-1">
      <Segmented
        label="Shape"
        value={shape.kind}
        options={SHAPE_KINDS}
        onChange={(kind) => kind !== shape.kind && restyle('Shape', (current) => shapeWith(current, { kind: kind.toLowerCase() }, box, () => current).style)}
      />
      <Row label="Colour">
        <Swatch label="Shape colour" colour={shape} edit={edit} onChange={(colour) => restyle('Shape Colour', (current) => ({ ...current, ...colour }))} />
      </Row>
      {shape.kind === 'Rectangle' && (
        <Slider
          label="Corner radius"
          value={shape.cornerRadius}
          min={0}
          max={Math.max(1, Math.floor(Math.min(box.width, box.height) / 2))}
          unit="px"
          curve="square"
          edit={edit}
          onChange={(cornerRadius) => restyle('Corner Radius', (current) => ({ ...current, cornerRadius }))}
        />
      )}
      {shape.kind === 'Line' && (
        <Slider label="Line width" value={shape.lineWidth ?? 1} min={1} max={MAX_LINE_WIDTH} unit="px" curve="log" edit={edit} onChange={(lineWidth) => restyle('Line Width', (current) => ({ ...current, lineWidth }))} />
      )}
    </div>
  )
}

// The panel.

function LayerProperties({ doc, layer }: { doc: CanvasDocument; layer: CanvasLayer }) {
  const edit = useEdit(doc, layer.id)

  if (layer.adjustment) {
    return <AdjustmentControls layer={layer} edit={edit} />
  }

  if (takesEffects(layer)) {
    return (
      <>
        {!cannotSegment(layer) && (
          <div className="flex items-center gap-1.5 border-b border-line/40 px-3 py-1.5">
            <button
              type="button"
              title="Hide the background with a mask, found on this computer"
              onClick={() => $dialog.set({ kind: 'remove-background' })}
              className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-fg-2 ring-1 ring-line hover:bg-white/8 hover:text-fg"
            >
              <IconBackground size={14} /> Remove Background
            </button>
          </div>
        )}
        {layer.shape && <ShapeControls layer={layer} edit={edit} />}
        <EffectsList layer={layer} edit={edit} />
      </>
    )
  }

  return <div className="px-3 py-2 text-[12px] text-fg-3">A folder passes through: its opacity and mask apply to everything inside it.</div>
}

export function PropertiesPanel({ doc, header }: { doc: CanvasDocument; header?: React.ReactNode }) {
  useRevision(doc)
  const layer = doc.active
  const kind = layer ? adjustmentKindOf(layer) : null
  const Icon = kind ? ADJUSTMENT_ICONS[kind] : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1.5 px-2 text-[11px] text-fg-3">
        {header}
        {layer && (
          <span className="flex min-w-0 items-center gap-1 truncate">
            {Icon && <Icon size={12} className="shrink-0" />}
            <span className="truncate">{kind ?? (layer.shape ? `${layer.name}: shape and effects` : takesEffects(layer) ? `${layer.name}: effects` : layer.name)}</span>
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {layer ? <LayerProperties key={layer.id} doc={doc} layer={layer} /> : <div className="px-3 py-2 text-[12px] text-fg-3">Pick a layer to see its settings.</div>}
      </div>
      {layer?.mask && <MaskControls doc={doc} layer={layer} />}
    </div>
  )
}
