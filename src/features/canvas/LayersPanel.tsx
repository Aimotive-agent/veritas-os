import {
  IconAdjustmentsPlus,
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconCornerLeftDown,
  IconEye,
  IconEyeOff,
  IconFolder,
  IconFolderOpen,
  IconFolderPlus,
  IconLetterT,
  IconLink,
  IconLinkOff,
  IconMask,
  IconPlus,
  IconShape,
  IconTrash
} from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { BLEND_MODES, type BlendMode } from '../../../shared/canvas/comp-format.ts'
import { cn } from '../../lib/cn.ts'
import { Menu } from '../files/Menu.tsx'
import { addAdjustmentLayer, addFolder, addLayer, addMask, deletePicked, duplicatePicked, maskAction, rename, setBlendMode, toggleClipping, toggleVisible } from './actions.ts'
import { ADJUSTMENT_ICONS, ADJUSTMENT_MENU, adjustmentKindOf } from './adjustment-icons.tsx'
import { selectLayerPixels } from './editing.ts'
import { type CanvasDocument, type CanvasLayer, childrenOf, type DocState, moveLayer, setClipped, withLayer } from './engine/document.ts'
import { effectKinds } from './engine/layer-effects.ts'
import type { Raster } from './engine/raster.ts'
import { useRevision } from './hooks.ts'
import { isMac } from './platform.ts'
import { softwareRendering } from './tools/screen.ts'

const DRAG_TYPE = 'application/x-herald-canvas-layer'

/** How close to the line between two rows (in pixels) an Alt-click clips the upper layer to the lower. */
const CLIP_EDGE = 6

type Edge = 'top' | 'bottom'

/** Blend modes in their usual families, each family after a divider. */
const FAMILIES: BlendMode[][] = [BLEND_MODES.slice(0, 1), BLEND_MODES.slice(1, 5), BLEND_MODES.slice(5, 9), BLEND_MODES.slice(9, 16), BLEND_MODES.slice(16, 20), BLEND_MODES.slice(20)]

const CHECKER = 'repeating-conic-gradient(rgba(255,255,255,0.22) 0% 25%, rgba(255,255,255,0.08) 0% 50%) 50% / 8px 8px'

interface Row {
  layer: CanvasLayer
  depth: number
}

/** The tree top first, as the panel lists it, without the insides of collapsed folders. */
function rowsOf(state: DocState, collapsed: ReadonlySet<string>, parentID?: string, depth = 0, out: Row[] = []): Row[] {
  const children = childrenOf(state, parentID)

  for (let i = children.length - 1; i >= 0; i--) {
    const layer = children[i]
    out.push({ layer, depth })

    if (layer.isGroup && !collapsed.has(layer.id)) {
      rowsOf(state, collapsed, layer.id, depth + 1, out)
    }
  }

  return out
}

/** How often a thumbnail redraws while its raster keeps changing, when the processor draws everything (milliseconds). */
const SOFTWARE_THUMB_MS = 400

/** Draw a raster into a thumbnail canvas, fitted and sampled. */
function drawThumb(canvas: HTMLCanvasElement | null, raster: Raster | null): void {
  const context = canvas?.getContext('2d')

  if (!canvas || !context) {
    return
  }

  context.clearRect(0, 0, canvas.width, canvas.height)

  if (!raster) {
    return
  }

  const side = canvas.width
  const ratio = Math.min(side / raster.width, side / raster.height)
  const width = Math.max(1, Math.round(raster.width * ratio))
  const height = Math.max(1, Math.round(raster.height * ratio))
  const image = context.createImageData(width, height)

  for (let y = 0; y < height; y++) {
    const sy = Math.min(raster.height - 1, Math.floor(((y + 0.5) * raster.height) / height))

    for (let x = 0; x < width; x++) {
      const sx = Math.min(raster.width - 1, Math.floor(((x + 0.5) * raster.width) / width))
      const o = (y * width + x) * 4

      if (raster.channels === 4) {
        const s = (sy * raster.width + sx) * 4
        image.data[o] = raster.data[s]
        image.data[o + 1] = raster.data[s + 1]
        image.data[o + 2] = raster.data[s + 2]
        image.data[o + 3] = raster.data[s + 3]
      } else {
        const v = raster.data[sy * raster.width + sx]
        image.data[o] = image.data[o + 1] = image.data[o + 2] = v
        image.data[o + 3] = 255
      }
    }
  }

  context.putImageData(image, Math.floor((side - width) / 2), Math.floor((side - height) / 2))
}

/**
 * A small preview of a raster. It is cheap enough to redraw on every stroke, except where the
 * processor draws everything: there it redraws at most every so often while the raster changes,
 * and once more when it stops.
 */
export function Thumb({ raster, version, size = 32, targeted = false }: { raster: Raster | null; version: number; size?: number; targeted?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const drawnAt = useRef(0)

  useEffect(() => {
    const draw = () => {
      drawnAt.current = performance.now()
      drawThumb(ref.current, raster)
    }
    const wait = softwareRendering() ? SOFTWARE_THUMB_MS - (performance.now() - drawnAt.current) : 0

    if (wait <= 0) {
      draw()

      return
    }

    const timer = setTimeout(draw, wait)

    return () => clearTimeout(timer)
  }, [raster, version])

  return <canvas ref={ref} width={size * 2} height={size * 2} className={cn('shrink-0 rounded-[4px]', targeted ? 'ring-2 ring-white/85' : 'ring-1 ring-line')} style={{ width: size, height: size, background: CHECKER }} />
}

/** Which line between rows an Alt-press at this point means, if it is close enough to one. */
function edgeAt(event: React.MouseEvent): Edge | null {
  if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) {
    return null
  }

  const rect = event.currentTarget.getBoundingClientRect()
  const y = event.clientY - rect.top

  return y <= CLIP_EDGE ? 'top' : y >= rect.height - CLIP_EDGE ? 'bottom' : null
}

function LayerRow({
  doc,
  row,
  picked,
  renaming,
  onRename,
  collapsed,
  onToggleCollapsed,
  drop,
  onDragOver,
  onDrop,
  clipEdge,
  onClipEdge,
  onClipHint
}: {
  doc: CanvasDocument
  row: Row
  picked: boolean
  renaming: boolean
  onRename: (id: string | null) => void
  collapsed: boolean
  onToggleCollapsed: () => void
  drop: 'above' | 'below' | 'into' | null
  onDragOver: (event: React.DragEvent, layer: CanvasLayer) => void
  onDrop: (event: React.DragEvent) => void
  /** The line of this row an Alt-click would clip across, while the pointer is near it. */
  clipEdge: Edge | null
  onClipEdge: (layer: CanvasLayer, edge: Edge) => void
  onClipHint: (edge: Edge | null) => void
}) {
  const { layer, depth } = row
  const [draft, setDraft] = useState(layer.name)
  const clipped = Boolean(layer.maskSourceID)
  const effects = effectKinds(layer.effects)
  const effectsHidden = effects.length > 0 && effects.every((kind) => (layer.effects?.[kind] as { enabled?: boolean }).enabled === false)
  const adjustmentKind = adjustmentKindOf(layer)
  const AdjustmentIcon = adjustmentKind ? ADJUSTMENT_ICONS[adjustmentKind] : null

  useEffect(() => {
    if (renaming) {
      setDraft(layer.name)
    }
  }, [renaming, layer.name])

  const finish = (keep: boolean) => {
    if (keep) {
      rename(doc, layer, draft)
    }

    onRename(null)
  }

  // A thumbnail picks what painting changes (the pixels or the mask); with ⌘ it loads a selection from it (⇧ adds, ⌥ takes away).
  // ⇧ on the mask's thumbnail switches the mask off and on.
  const onThumb = (event: React.MouseEvent, mask: boolean) => {
    event.stopPropagation()

    if (isMac ? event.metaKey : event.ctrlKey) {
      selectLayerPixels(doc, layer, mask, event.shiftKey ? 'add' : event.altKey ? 'subtract' : 'new')
    } else if (mask && event.shiftKey) {
      maskAction(doc, layer.maskEnabled === false ? 'enable' : 'disable', layer)
    } else {
      doc.select(layer.id, false, mask)
    }
  }

  const editingMask = picked && doc.editingMask && doc.active?.id === layer.id

  return (
    <div
      role="treeitem"
      aria-selected={picked}
      aria-expanded={layer.isGroup ? !collapsed : undefined}
      draggable={!renaming}
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAG_TYPE, layer.id)
        event.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={(event) => onDragOver(event, layer)}
      onDrop={onDrop}
      onClick={(event) => {
        // ⌥-click on the line between two rows clips the upper layer to the lower one (or releases it).
        const edge = edgeAt(event)

        if (edge) {
          onClipEdge(layer, edge)
        } else {
          doc.select(layer.id, event.shiftKey || event.metaKey || event.ctrlKey)
        }
      }}
      onMouseMove={(event) => onClipHint(edgeAt(event))}
      onMouseLeave={() => onClipHint(null)}
      onDoubleClick={(event) => !event.altKey && onRename(layer.id)}
      className={cn(
        'group relative flex h-11 shrink-0 cursor-default items-center gap-1.5 border-b border-line/50 pr-2 text-[12px]',
        picked ? 'bg-accent/18 text-fg' : 'text-fg-2 hover:bg-white/5',
        drop === 'into' && 'bg-accent/25 ring-1 ring-inset ring-accent',
        clipEdge && 'cursor-alias'
      )}
      style={{ paddingLeft: 4 + depth * 14 + (clipped ? 12 : 0) }}
    >
      {drop === 'above' && <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-accent" />}
      {drop === 'below' && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-accent" />}
      {clipEdge && <div className={cn('pointer-events-none absolute inset-x-2 h-0 border-t border-dashed border-accent', clipEdge === 'top' ? 'top-0' : 'bottom-0')} />}
      <button
        type="button"
        aria-label={layer.isVisible ? 'Hide layer' : 'Show layer'}
        onClick={(event) => {
          event.stopPropagation()
          toggleVisible(doc, layer)
        }}
        className="grid size-6 shrink-0 place-items-center rounded text-fg-3 hover:text-fg"
      >
        {layer.isVisible ? <IconEye size={15} /> : <IconEyeOff size={15} className="opacity-60" />}
      </button>
      {layer.isGroup ? (
        <button
          type="button"
          aria-label={collapsed ? 'Expand folder' : 'Collapse folder'}
          onClick={(event) => {
            event.stopPropagation()
            onToggleCollapsed()
          }}
          className="grid size-4 shrink-0 place-items-center text-fg-3 hover:text-fg"
        >
          {collapsed ? <IconChevronRight size={13} /> : <IconChevronDown size={13} />}
        </button>
      ) : clipped ? (
        <IconCornerLeftDown size={13} className="shrink-0 text-fg-3" aria-label="Clipped to the layer below" />
      ) : (
        <span className="w-4 shrink-0" />
      )}
      {layer.isGroup ? (
        <span className="grid size-8 shrink-0 place-items-center text-fg-3">{collapsed ? <IconFolder size={20} /> : <IconFolderOpen size={20} />}</span>
      ) : AdjustmentIcon ? (
        <span className="grid size-8 shrink-0 place-items-center rounded-[4px] bg-white/6 text-fg-2 ring-1 ring-line" title={adjustmentKind ?? undefined}>
          <AdjustmentIcon size={17} />
        </span>
      ) : (
        <span onClick={(event) => onThumb(event, false)} title="Paint on the pixels (⌘-click selects them)">
          <Thumb raster={layer.pixels} version={layer.pixels?.version ?? 0} targeted={Boolean(layer.mask) && picked && !editingMask && doc.active?.id === layer.id} />
        </span>
      )}
      {layer.mask && (
        <>
          <button
            type="button"
            title={layer.maskLinked === false ? 'The mask stays put when the layer moves: click to link it' : 'The mask moves with the layer: click to unlink it'}
            aria-label={layer.maskLinked === false ? 'Link the mask' : 'Unlink the mask'}
            onClick={(event) => {
              event.stopPropagation()
              maskAction(doc, layer.maskLinked === false ? 'link' : 'unlink', layer)
            }}
            className="-mx-1 grid size-4 shrink-0 place-items-center text-fg-3 hover:text-fg"
          >
            {layer.maskLinked === false ? <IconLinkOff size={11} className="opacity-60" /> : <IconLink size={11} />}
          </button>
          <span
            onClick={(event) => onThumb(event, true)}
            className="relative"
            title={layer.maskEnabled === false ? 'Mask turned off (⇧-click turns it on, click paints on it)' : 'Mask: click to paint on it, ⇧-click turns it off, ⌘-click selects from it'}
          >
            <span className={cn(layer.maskEnabled === false && 'opacity-35')}>
              <Thumb raster={layer.mask} version={layer.mask.version} size={24} targeted={editingMask} />
            </span>
            {layer.maskEnabled === false && (
              <svg viewBox="0 0 24 24" className="pointer-events-none absolute inset-0 size-6 text-danger" aria-hidden>
                <path d="M3 3 L21 21 M21 3 L3 21" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
              </svg>
            )}
          </span>
        </>
      )}
      <div className="min-w-0 flex-1 pl-1">
        {renaming ? (
          <input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => finish(true)}
            onKeyDown={(event) => {
              event.stopPropagation()

              if (event.key === 'Enter') {
                finish(true)
              } else if (event.key === 'Escape') {
                finish(false)
              }
            }}
            onClick={(event) => event.stopPropagation()}
            className="glass-input h-6 w-full rounded px-1.5 text-[12px] text-fg outline-none"
          />
        ) : (
          <div className={cn('flex items-center gap-1 truncate', !layer.isVisible && 'opacity-55')}>
            {layer.text && <IconLetterT size={12} className="shrink-0 text-fg-3" aria-label="Text layer" />}
            {layer.shape && <IconShape size={12} className="shrink-0 text-fg-3" aria-label="Shape layer" />}
            <span className="truncate">{layer.name}</span>
            {effects.length > 0 && (
              <span className={cn('ml-auto shrink-0 pl-1 text-[10.5px] font-semibold text-fg-3 italic', effectsHidden && 'line-through opacity-60')} title={effectsHidden ? 'Layer effects (hidden)' : 'Layer effects'}>
                fx
              </span>
            )}
          </div>
        )}
        {!renaming && ((layer.opacity ?? 1) < 1 || (layer.blendMode && layer.blendMode !== 'Normal')) && (
          <div className="truncate text-[10.5px] text-fg-3">
            {[layer.blendMode !== 'Normal' ? layer.blendMode : null, (layer.opacity ?? 1) < 1 ? `${Math.round((layer.opacity ?? 1) * 100)}%` : null].filter(Boolean).join(' · ')}
          </div>
        )}
      </div>
    </div>
  )
}

/** The active layer's blend mode and opacity. */
function LayerControls({ doc, layer }: { doc: CanvasDocument; layer: CanvasLayer | undefined }) {
  const before = useRef<DocState | null>(null)
  const opacity = Math.round((layer?.opacity ?? 1) * 100)

  const setOpacity = (value: number) => {
    if (!layer) {
      return
    }

    const next = Math.max(0, Math.min(100, value)) / 100

    if (before.current) {
      doc.preview(withLayer(before.current, layer.id, { opacity: next }))
    } else {
      doc.commit('Opacity Change', withLayer(doc.state, layer.id, { opacity: next }))
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-line px-2.5 py-2">
      <select
        aria-label="Blend mode"
        disabled={!layer || layer.isGroup}
        value={layer?.isGroup ? 'Pass Through' : (layer?.blendMode ?? 'Normal')}
        onChange={(event) => layer && setBlendMode(doc, layer, event.target.value as BlendMode)}
        className="glass-input h-7 min-w-0 flex-1 rounded-md px-1.5 text-[12px] text-fg outline-none disabled:opacity-50"
      >
        {layer?.isGroup && <option value="Pass Through">Pass Through</option>}
        {FAMILIES.map((family, i) => (
          <optgroup key={i} label={i === 0 ? 'Normal' : ' '}>
            {family.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <input
        type="range"
        aria-label="Opacity"
        min={0}
        max={100}
        disabled={!layer}
        value={opacity}
        onPointerDown={() => {
          before.current = doc.state
        }}
        onPointerUp={() => {
          if (before.current) {
            doc.commitFrom('Opacity Change', before.current)
            before.current = null
          }
        }}
        onChange={(event) => setOpacity(Number(event.target.value))}
        className="w-20 accent-[var(--color-accent,#4da3ff)]"
      />
      <span className="w-9 text-right text-[11.5px] tabular-nums text-fg-2">{opacity}%</span>
    </div>
  )
}

export function LayersPanel({ doc }: { doc: CanvasDocument }) {
  useRevision(doc)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [renaming, setRenaming] = useState<string | null>(null)
  const [drop, setDrop] = useState<{ id: string; where: 'above' | 'below' | 'into' } | null>(null)
  const [clipHint, setClipHint] = useState<{ id: string; edge: Edge } | null>(null)
  const [adjustments, setAdjustments] = useState(false)
  const { state } = doc
  const rows = rowsOf(state, collapsed)
  const picked = new Set(doc.picked.map((layer) => layer.id))
  const active = doc.active

  // The line below a row clips that row's layer; the line above it, the row above's.
  const onClipEdge = (layer: CanvasLayer, edge: Edge) => {
    const index = rows.findIndex((entry) => entry.layer.id === layer.id)
    const upper = edge === 'bottom' ? layer : rows[index - 1]?.layer

    if (!upper || upper.isGroup) {
      return
    }

    const next = setClipped(state, upper.id, !upper.maskSourceID)

    if (next !== state) {
      doc.commit(upper.maskSourceID ? 'Release Clipping Mask' : 'Create Clipping Mask', next)
    }
  }

  const onDragOver = (event: React.DragEvent, layer: CanvasLayer) => {
    if (!event.dataTransfer.types.includes(DRAG_TYPE)) {
      return
    }

    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    const at = (event.clientY - rect.top) / rect.height
    const where = layer.isGroup && at > 0.3 && at < 0.7 ? 'into' : at < 0.5 ? 'above' : 'below'

    if (drop?.id !== layer.id || drop.where !== where) {
      setDrop({ id: layer.id, where })
    }
  }

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault()
    const id = event.dataTransfer.getData(DRAG_TYPE)
    const target = drop && doc.layer(drop.id)
    setDrop(null)

    if (!id || !drop || !target || target.id === id) {
      return
    }

    if (drop.where === 'into') {
      const inside = childrenOf(state, target.id).filter((layer) => layer.id !== id)
      doc.commit('Move Layer', moveLayer(state, id, target.id, inside.length))

      return
    }

    const siblings = childrenOf(state, target.parentID).filter((layer) => layer.id !== id)
    const index = siblings.indexOf(target)
    // The panel lists top first: above a row is higher in the stack.
    doc.commit('Move Layer', moveLayer(state, id, target.parentID, drop.where === 'above' ? index + 1 : index))
  }

  const toggleCollapsed = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current)

      if (!next.delete(id)) {
        next.add(id)
      }

      return next
    })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center px-3 text-[11px] font-medium tracking-wide text-fg-3 uppercase">Layers</div>
      <LayerControls doc={doc} layer={active} />
      <div role="tree" aria-label="Layers" aria-multiselectable className="min-h-0 flex-1 overflow-y-auto" onDragLeave={(event) => !event.currentTarget.contains(event.relatedTarget as Node) && setDrop(null)}>
        {rows.map((row) => (
          <LayerRow
            key={row.layer.id}
            doc={doc}
            row={row}
            picked={picked.has(row.layer.id)}
            renaming={renaming === row.layer.id}
            onRename={setRenaming}
            collapsed={collapsed.has(row.layer.id)}
            onToggleCollapsed={() => toggleCollapsed(row.layer.id)}
            drop={drop?.id === row.layer.id ? drop.where : null}
            onDragOver={onDragOver}
            onDrop={onDrop}
            clipEdge={clipHint?.id === row.layer.id ? clipHint.edge : null}
            onClipEdge={onClipEdge}
            onClipHint={(edge) => setClipHint((current) => (edge ? (current?.id === row.layer.id && current.edge === edge ? current : { id: row.layer.id, edge }) : current?.id === row.layer.id ? null : current))}
          />
        ))}
        {!rows.length && <div className="p-4 text-center text-[12px] text-fg-3">No layers</div>}
      </div>
      <div className="flex h-9 shrink-0 items-center justify-end gap-0.5 border-t border-line px-1.5">
        <div className="relative">
          <button
            type="button"
            title="New adjustment layer"
            aria-label="New adjustment layer"
            aria-haspopup="menu"
            aria-expanded={adjustments}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => setAdjustments(!adjustments)}
            className={cn('grid size-7 place-items-center rounded-md text-fg-3 hover:bg-white/8 hover:text-fg', adjustments && 'bg-white/10 text-fg')}
          >
            <IconAdjustmentsPlus size={15} />
          </button>
          {adjustments && (
            <Menu
              align="left"
              className="bottom-full mb-1 max-h-[60vh] overflow-y-auto"
              onClose={() => setAdjustments(false)}
              items={ADJUSTMENT_MENU.map(({ kind, dividerBefore }) => {
                const Icon = ADJUSTMENT_ICONS[kind]

                return { id: kind, label: kind, icon: <Icon />, dividerBefore, onSelect: () => addAdjustmentLayer(doc, kind) }
              })}
            />
          )}
        </div>
        {[
          { label: 'Clip to the layer below', icon: <IconCornerLeftDown size={15} />, run: () => toggleClipping(doc), disabled: !active || active.isGroup },
          { label: 'Add a mask', icon: <IconMask size={15} />, run: () => addMask(doc), disabled: !active || Boolean(active.mask) },
          { label: 'New folder', icon: <IconFolderPlus size={15} />, run: () => addFolder(doc) },
          { label: 'Duplicate', icon: <IconCopy size={15} />, run: () => duplicatePicked(doc), disabled: !active },
          { label: 'New layer', icon: <IconPlus size={15} />, run: () => addLayer(doc) },
          { label: 'Delete', icon: <IconTrash size={15} />, run: () => deletePicked(doc), disabled: !active }
        ].map((button) => (
          <button
            key={button.label}
            type="button"
            title={button.label}
            aria-label={button.label}
            disabled={button.disabled}
            onClick={button.run}
            className="grid size-7 place-items-center rounded-md text-fg-3 hover:bg-white/8 hover:text-fg disabled:opacity-35 disabled:hover:bg-transparent"
          >
            {button.icon}
          </button>
        ))}
      </div>
    </div>
  )
}
