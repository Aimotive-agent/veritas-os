import { useStore } from '@nanostores/react'
import { GlassButton } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import { REFINE_RANGES, REFINE_VIEWS, type RefineSettings, type RefineView } from './engine/refine-edge.ts'
import { $selectMask, applySelectMask, cancelSelectMask, REFINE_OUTPUTS, type RefineOutput, updateSelectMask } from './select-mask.ts'
import { $refineBrush } from './tools/state.ts'

/*
 * Select and Mask's panel, over the canvas so the picture stays in view and the Refine Edge brush
 * can paint on it: view mode, edge detection, global refinements and output.
 */

function Slider({ label, value, min, max, step = 1, unit, onChange }: { label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (value: number) => void }) {
  return (
    <label className="grid grid-cols-[6.5rem_1fr_3.5rem] items-center gap-2 text-[12px] text-fg-2">
      {label}
      <input type="range" aria-label={label} min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} className="accent-(--color-accent)" />
      <span className="text-right text-fg-3 tabular-nums">
        {value}
        {unit}
      </span>
    </label>
  )
}

function Heading({ children }: { children: React.ReactNode }) {
  return <div className="mt-1 text-[10.5px] font-medium tracking-wide text-fg-3 uppercase">{children}</div>
}

export function SelectMaskPanel() {
  const session = useStore($selectMask)
  const brush = useStore($refineBrush)

  if (!session) {
    return null
  }

  const settings = session.settings
  const set = (change: Partial<RefineSettings>) => updateSelectMask({ settings: { ...settings, ...change } })
  const pixelsOut = session.output === 'layer' || session.output === 'layerMask'

  return (
    <div role="dialog" aria-label="Select and Mask" className="float menu-surface absolute top-12 right-2 z-40 flex max-h-[calc(100%-4rem)] w-72 flex-col gap-2.5 overflow-y-auto rounded-2xl p-4 animate-pop" onKeyDown={(event) => event.stopPropagation()}>
      <div className="flex items-center justify-between">
        <div className="text-[14px] font-medium text-fg">Select and Mask</div>
        <span className="text-[11px] text-fg-3">{session.busy ? 'Working…' : session.scale < 1 ? 'Previewed reduced' : ''}</span>
      </div>
      <label className="flex items-center justify-between gap-2 text-[12px] text-fg-2">
        View
        <select aria-label="View" value={session.view} onChange={(event) => updateSelectMask({ view: event.target.value as RefineView })} className="glass-input h-7 w-44 rounded-md px-1.5 text-[12px] text-fg outline-none">
          {REFINE_VIEWS.map((view) => (
            <option key={view.id} value={view.id}>
              {view.label}
            </option>
          ))}
        </select>
      </label>
      <Heading>Edge detection</Heading>
      <Slider label="Radius" value={settings.radius} min={REFINE_RANGES.radius[0]} max={60} unit=" px" onChange={(radius) => set({ radius })} />
      <label className="flex items-center gap-2 text-[12px] text-fg-2">
        <input type="checkbox" checked={settings.smartRadius} onChange={(event) => set({ smartRadius: event.target.checked })} className="accent-(--color-accent)" />
        Smart radius (narrower where the edge is crisp)
      </label>
      <Slider label="Refine brush" value={brush.size} min={4} max={400} unit=" px" onChange={(size) => $refineBrush.set({ size })} />
      <p className="-mt-1 text-[11px] text-fg-3">Paint over hair and fur to work them out again; Alt-paint takes a stroke back.</p>
      <Heading>Global refinements</Heading>
      <Slider label="Smooth" value={settings.smooth} min={REFINE_RANGES.smooth[0]} max={REFINE_RANGES.smooth[1]} onChange={(smooth) => set({ smooth })} />
      <Slider label="Feather" value={settings.feather} min={REFINE_RANGES.feather[0]} max={100} step={0.5} unit=" px" onChange={(feather) => set({ feather })} />
      <Slider label="Contrast" value={settings.contrast} min={REFINE_RANGES.contrast[0]} max={REFINE_RANGES.contrast[1]} unit="%" onChange={(contrast) => set({ contrast })} />
      <Slider label="Shift edge" value={settings.shiftEdge} min={REFINE_RANGES.shiftEdge[0]} max={REFINE_RANGES.shiftEdge[1]} unit="%" onChange={(shiftEdge) => set({ shiftEdge })} />
      <Heading>Output</Heading>
      <label className={cn('flex items-center gap-2 text-[12px] text-fg-2', !pixelsOut && 'opacity-50')}>
        <input type="checkbox" disabled={!pixelsOut} checked={session.decontaminate} onChange={(event) => updateSelectMask({ decontaminate: event.target.checked })} className="accent-(--color-accent)" />
        Decontaminate colours
      </label>
      {pixelsOut && session.decontaminate && <Slider label="Amount" value={session.amount} min={0} max={100} unit="%" onChange={(amount) => updateSelectMask({ amount })} />}
      <label className="flex items-center justify-between gap-2 text-[12px] text-fg-2">
        Output to
        <select aria-label="Output to" value={session.output} onChange={(event) => updateSelectMask({ output: event.target.value as RefineOutput })} className="glass-input h-7 w-44 rounded-md px-1.5 text-[12px] text-fg outline-none">
          {REFINE_OUTPUTS.map((output) => (
            <option key={output.id} value={output.id}>
              {output.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-[12px] text-fg-2">
        <input type="checkbox" checked={session.sampleAll} onChange={(event) => updateSelectMask({ sampleAll: event.target.checked })} className="accent-(--color-accent)" />
        Sample all layers
      </label>
      <div className="mt-1 flex justify-end gap-2">
        <GlassButton variant="ghost" onClick={cancelSelectMask}>
          Cancel
        </GlassButton>
        <GlassButton variant="primary" onClick={() => void applySelectMask()}>
          OK
        </GlassButton>
      </div>
    </div>
  )
}
