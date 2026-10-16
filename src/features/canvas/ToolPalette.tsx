import { useStore } from '@nanostores/react'
import {
  IconArrowsExchange,
  IconArrowsMove,
  IconBandage,
  IconBrush,
  IconBucketDroplet,
  IconCircleDashed,
  IconColorPicker,
  IconContrast2,
  IconCrop,
  IconEraser,
  IconFirstAidKit,
  IconHandStop,
  IconLasso,
  IconLassoPolygon,
  IconMarquee2,
  IconRubberStamp,
  IconScan,
  IconShape,
  IconTypography,
  IconWand,
  IconZoomIn
} from '@tabler/icons-react'
import { useRef, useState } from 'react'
import { cn } from '../../lib/cn.ts'
import { cssOf } from './color.ts'
import { ColorPicker } from './ColorPicker.tsx'
import { Menu } from '../files/Menu.tsx'
import { $background, $foreground, $groupTools, $tool, GROUPS, resetColours, setTool, swapColours, type ToolId, TOOLS, toolDef } from './tools/state.ts'

export const TOOL_ICONS: Record<ToolId, React.ReactNode> = {
  move: <IconArrowsMove size={17} />,
  marquee: <IconMarquee2 size={17} />,
  'ellipse-marquee': <IconCircleDashed size={17} />,
  lasso: <IconLasso size={17} />,
  'polygon-lasso': <IconLassoPolygon size={17} />,
  wand: <IconWand size={17} />,
  'object-select': <IconScan size={17} />,
  crop: <IconCrop size={17} />,
  eyedropper: <IconColorPicker size={17} />,
  heal: <IconBandage size={17} />,
  healing: <IconFirstAidKit size={17} />,
  brush: <IconBrush size={17} />,
  clone: <IconRubberStamp size={17} />,
  eraser: <IconEraser size={17} />,
  bucket: <IconBucketDroplet size={17} />,
  gradient: <IconContrast2 size={17} />,
  type: <IconTypography size={17} />,
  shape: <IconShape size={17} />,
  hand: <IconHandStop size={17} />,
  zoom: <IconZoomIn size={17} />,
  refine: <IconBrush size={17} />
}

/** A tool's name with its key, for tooltips: "Brush (B)", "Gradient (G, again for the next)". */
export function toolTitle(id: ToolId): string {
  const def = toolDef(id)
  const shared = TOOLS.filter((entry) => entry.key === def.key).length > 1

  return `${def.label} (${def.key.toUpperCase()}${shared ? `; ${def.key.toUpperCase()} again or Shift+${def.key.toUpperCase()} for the next` : ''})`
}

/** One palette button: the group's current tool; a right-click or a long press offers the others. */
function GroupButton({ group }: { group: string }) {
  const tool = useStore($tool)
  const chosen = useStore($groupTools)[group]
  const members = TOOLS.filter((def) => def.group === group)
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const active = members.some((def) => def.id === tool)

  return (
    <div className="relative">
      <button
        type="button"
        title={toolTitle(chosen)}
        aria-label={toolDef(chosen).label}
        aria-pressed={active}
        onClick={() => setTool(chosen)}
        onContextMenu={(event) => {
          if (members.length > 1) {
            event.preventDefault()
            setOpen(true)
          }
        }}
        onPointerDown={() => {
          if (members.length > 1) {
            timer.current = setTimeout(() => setOpen(true), 450)
          }
        }}
        onPointerUp={() => timer.current && clearTimeout(timer.current)}
        onPointerLeave={() => timer.current && clearTimeout(timer.current)}
        className={cn('relative grid size-8 place-items-center rounded-lg', active ? 'bg-accent/20 text-fg ring-1 ring-accent/50' : 'text-fg-3 hover:bg-white/8 hover:text-fg')}
      >
        {TOOL_ICONS[chosen]}
        {members.length > 1 && (
          <svg className="absolute right-0.5 bottom-0.5 size-1.5 opacity-60" viewBox="0 0 4 4" aria-hidden>
            <path d="M4 0V4H0Z" fill="currentColor" />
          </svg>
        )}
      </button>
      {open && (
        <Menu
          align="left"
          className="top-0 left-full ml-1.5 min-w-52"
          onClose={() => setOpen(false)}
          items={members.map((def) => ({ id: def.id, label: def.label, icon: TOOL_ICONS[def.id], hint: def.key.toUpperCase(), checked: def.id === chosen, onSelect: () => setTool(def.id) }))}
        />
      )}
    </div>
  )
}

/** The foreground and background colours: click one to change it; the arrows swap them (X), the small squares reset them (D). */
function Swatches() {
  const foreground = useStore($foreground)
  const background = useStore($background)
  const [editing, setEditing] = useState<'foreground' | 'background' | null>(null)

  return (
    <div className="relative mt-1 h-12 w-9">
      <button
        type="button"
        title="Background colour"
        aria-label="Background colour"
        onClick={() => setEditing('background')}
        className="absolute right-0 bottom-0 size-6 rounded-[5px] ring-1 ring-white/40"
        style={{ background: cssOf(background) }}
      />
      <button
        type="button"
        title="Foreground colour"
        aria-label="Foreground colour"
        onClick={() => setEditing('foreground')}
        className="absolute top-1.5 left-0 size-6 rounded-[5px] ring-1 ring-white/40 shadow-[0_0_0_2px_rgba(0,0,0,0.35)]"
        style={{ background: cssOf(foreground) }}
      />
      <button type="button" title="Swap colours (X)" aria-label="Swap colours" onClick={swapColours} className="absolute -top-1 right-0 grid size-3.5 place-items-center text-fg-3 hover:text-fg">
        <IconArrowsExchange size={11} />
      </button>
      <button type="button" title="Default colours (D)" aria-label="Default colours" onClick={resetColours} className="absolute bottom-0 left-0 size-3.5">
        <span className="absolute top-0 left-0 size-2 border border-white/60 bg-black" />
        <span className="absolute right-0 bottom-0 size-2 border border-black/40 bg-white" />
      </button>
      {editing && (
        <ColorPicker
          title={editing === 'foreground' ? 'Foreground colour' : 'Background colour'}
          colour={editing === 'foreground' ? foreground : background}
          onChange={(colour) => (editing === 'foreground' ? $foreground : $background).set(colour)}
          onClose={() => setEditing(null)}
          className="bottom-0 left-full ml-3"
        />
      )}
    </div>
  )
}

export function ToolPalette() {
  return (
    <div className="flex w-11 shrink-0 flex-col items-center gap-1 overflow-visible border-r border-line py-2" role="toolbar" aria-orientation="vertical" aria-label="Tools">
      {GROUPS.map((group, i) => (
        <div key={group} className={cn(['crop', 'heal', 'type', 'hand'].includes(group) && i > 0 && 'mt-1.5')}>
          <GroupButton group={group} />
        </div>
      ))}
      <Swatches />
    </div>
  )
}
