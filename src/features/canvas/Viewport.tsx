import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '../../lib/cn.ts'
import type { CanvasDocument, CanvasLayer } from './engine/document.ts'
import { apply, corners } from './engine/geometry.ts'
import { docToScreen, fitView, type Look, ScreenRenderer, SETTLE_MS, type View, zoomAt } from './engine/gpu/view.ts'
import type { Raster } from './engine/raster.ts'
import { traceOutline } from './engine/selection.ts'
import { HANDLERS } from './tools/index.ts'
import { registerScreen } from './tools/screen.ts'
import { movingSelection } from './tools/select.ts'
import { dragGuide, guideAt } from './tools/guides.ts'
import { $draftGuide, $snapMarks, drawSnapMarks } from './tools/snap.ts'
import { $spaceHeld, $tool } from './tools/state.ts'
import { $transform, sessionFor } from './tools/transform.ts'
import { $typing } from './tools/type.ts'
import { $overlayTick, modKey, type PointerInfo, type ToolDrag } from './tools/types.ts'
import { TypeEditor } from './TypeEditor.tsx'
import { $pointer, $viewOptions, $views, setView, viewOf, viewport, zoomStep } from './view-state.ts'

const LOOK: Look = { workspace: null, checkerLight: [0.4, 0.4, 0.42], checkerDark: [0.31, 0.31, 0.33] }
const OUTLINE = '#4da3ff'

/** Marching ants step every this many milliseconds. */
const ANTS_STEP = 110

interface Drag {
  move: (event: PointerEvent) => void
  up?: (event: PointerEvent) => void
  cancel?: () => void
}

/** The selection's outline as a path in document pixels, traced once per selection. */
const outlines = new WeakMap<Raster, Path2D>()

function outlineOf(selection: Raster): Path2D {
  let path = outlines.get(selection)

  if (!path) {
    path = new Path2D()

    for (const loop of traceOutline(selection)) {
      path.moveTo(loop[0], loop[1])

      for (let i = 2; i < loop.length; i += 2) {
        path.lineTo(loop[i], loop[i + 1])
      }

      path.closePath()
    }

    outlines.set(selection, path)
  }

  return path
}

let antsPhase = 0

/**
 * The document on screen. Scroll to pan, pinch or ⌘-scroll to zoom, Space or the middle button to
 * drag the view; everything else goes to the tool in hand.
 */
export function Viewport({ doc }: { doc: CanvasDocument }) {
  const host = useRef<HTMLDivElement>(null)
  const glCanvas = useRef<HTMLCanvasElement>(null)
  const overlay = useRef<HTMLCanvasElement>(null)
  const renderer = useRef<ScreenRenderer | null>(null)
  const docRef = useRef(doc)
  const frame = useRef(0)
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const drag = useRef<Drag | null>(null)
  const hidden = useRef<{ id: string | null; map: ReadonlyMap<string, Partial<CanvasLayer>> | undefined }>({ id: null, map: undefined })
  const [failure, setFailure] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const views = useStore($views)
  const tool = useStore($tool)
  const space = useStore($spaceHeld)
  const tick = useStore($overlayTick)
  const typing = useStore($typing)
  const transform = useStore($transform)
  const viewOptions = useStore($viewOptions)
  const snapMarks = useStore($snapMarks)
  const draftGuide = useStore($draftGuide)
  docRef.current = doc

  // The text layer being typed into is hidden: its words show in the editor instead.
  const editing = typing?.docKey === doc.key ? typing.layerId : null

  if (hidden.current.id !== editing) {
    hidden.current = { id: editing, map: editing ? new Map([[editing, { isVisible: false }]]) : undefined }
  }

  const paint = () => {
    frame.current = 0
    const current = docRef.current
    const view = viewOf(current)
    const dpr = window.devicePixelRatio || 1
    let draft = false

    try {
      draft = renderer.current?.draw(current, view, LOOK, dpr, { overrides: hidden.current.map }) ?? false
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    }

    drawOverlay(overlay.current, current, view, dpr)
    clearTimeout(settle.current)

    // A draft drawn while things moved: the full frame follows once they are still.
    if (draft) {
      settle.current = setTimeout(() => schedule(), SETTLE_MS + 10)
    }
  }
  const paintRef = useRef(paint)
  paintRef.current = paint
  const schedule = useRef(() => {
    if (!frame.current) {
      frame.current = requestAnimationFrame(() => paintRef.current())
    }
  }).current

  // The GL context, sized to the viewport in device pixels.
  useEffect(() => {
    const canvas = glCanvas.current!
    const element = host.current!

    try {
      renderer.current = new ScreenRenderer(canvas)
      registerScreen(renderer.current)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    }

    const lost = (event: Event) => event.preventDefault()
    const restored = () => {
      try {
        renderer.current = new ScreenRenderer(canvas)
        registerScreen(renderer.current)
        schedule()
      } catch (error) {
        setFailure(error instanceof Error ? error.message : String(error))
      }
    }
    const resize = () => {
      const rect = element.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      viewport.width = rect.width
      viewport.height = rect.height

      for (const target of [canvas, overlay.current!]) {
        target.width = Math.max(1, Math.round(rect.width * dpr))
        target.height = Math.max(1, Math.round(rect.height * dpr))
      }

      schedule()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    resize()
    canvas.addEventListener('webglcontextlost', lost)
    canvas.addEventListener('webglcontextrestored', restored)

    return () => {
      observer.disconnect()
      canvas.removeEventListener('webglcontextlost', lost)
      canvas.removeEventListener('webglcontextrestored', restored)
      cancelAnimationFrame(frame.current)
      clearTimeout(settle.current)
      frame.current = 0
      registerScreen(null)
      renderer.current?.dispose()
      renderer.current = null
    }
  }, [schedule])

  // A document seen for the first time opens fitted, never past 100%.
  useEffect(() => {
    if (!$views.get()[doc.key]) {
      setView(doc, fitView(viewport.width, viewport.height, doc.state.width, doc.state.height, 1))
    }

    schedule()

    return doc.subscribe(schedule)
  }, [doc, schedule])

  useEffect(schedule, [views, tool, tick, typing, transform, viewOptions, snapMarks, draftGuide, schedule])

  // The tool put down (or the document left) finishes what it had under way.
  useEffect(() => {
    const handler = HANDLERS[tool]

    return () => handler?.release?.(doc)
  }, [tool, doc])

  // Marching ants, while something is selected.
  const selection = doc.state.selection

  useEffect(() => {
    if (!selection) {
      return
    }

    const timer = setInterval(() => {
      antsPhase = (antsPhase + 1) % 8
      schedule()
    }, ANTS_STEP)

    return () => clearInterval(timer)
  }, [selection, schedule])

  // Wheel: scroll pans, pinch (ctrl) or ⌘-scroll zooms. Not passive, so the page never scrolls.
  useEffect(() => {
    const element = host.current!
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const current = docRef.current
      const view = viewOf(current)
      const rect = element.getBoundingClientRect()
      const unit = event.deltaMode === 1 ? 16 : 1

      if (event.ctrlKey || event.metaKey) {
        // A pinch sends small deltas with ctrl held; a wheel with ⌘ sends large ones.
        const factor = Math.exp(-event.deltaY * unit * (event.metaKey ? 0.0025 : 0.01))
        setView(current, zoomAt(view, factor, event.clientX - rect.left, event.clientY - rect.top))
      } else {
        setView(current, { ...view, panX: view.panX - event.deltaX * unit, panY: view.panY - event.deltaY * unit })
      }
    }
    element.addEventListener('wheel', onWheel, { passive: false })

    return () => element.removeEventListener('wheel', onWheel)
  }, [])

  // Escape lets go of a drag.
  useEffect(() => {
    if (!dragging) {
      return
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && drag.current) {
        event.stopPropagation()
        const current = drag.current
        drag.current = null
        current.cancel?.()
        setDragging(false)
      }
    }
    window.addEventListener('keydown', onKey, true)

    return () => window.removeEventListener('keydown', onKey, true)
  }, [dragging])

  const pointerInfo = (event: { clientX: number; clientY: number; shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean; pressure?: number; pointerType?: string }): PointerInfo => {
    const rect = host.current!.getBoundingClientRect()
    const view = viewOf(docRef.current)
    const sx = event.clientX - rect.left
    const sy = event.clientY - rect.top

    return {
      x: (sx - view.panX) / view.zoom,
      y: (sy - view.panY) / view.zoom,
      sx,
      sy,
      shift: event.shiftKey,
      alt: event.altKey,
      mod: modKey(event),
      pressure: event.pointerType === 'pen' && event.pressure ? event.pressure : 1,
      view
    }
  }

  const begin = (next: Drag, event: React.PointerEvent) => {
    drag.current = next
    setDragging(true)
    const target = event.currentTarget as HTMLElement
    target.setPointerCapture(event.pointerId)
    const move = (e: PointerEvent) => drag.current?.move(e)
    const up = (e: PointerEvent) => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', cancel)
      const current = drag.current
      drag.current = null
      current?.up?.(e)
      setDragging(false)
    }
    const cancel = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', cancel)
      const current = drag.current
      drag.current = null
      current?.cancel?.()
      setDragging(false)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', cancel)
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    ;(event.currentTarget.closest('[data-canvas-root]') as HTMLElement | null)?.focus({ preventScroll: true })
    const current = docRef.current
    const at = pointerInfo(event)

    if (event.button === 1 || $spaceHeld.get() || $tool.get() === 'hand') {
      event.preventDefault()
      const start = viewOf(current)
      begin({ move: (e) => setView(current, { ...start, panX: start.panX + e.clientX - event.clientX, panY: start.panY + e.clientY - event.clientY }) }, event)

      return
    }

    if (event.button !== 0) {
      return
    }

    if ($tool.get() === 'zoom') {
      zoomStep(current, event.altKey ? -1 : 1, at.sx, at.sy)

      return
    }

    // A guide drags with the Move tool, or with ⌘ held whatever the tool.
    const guide = ($tool.get() === 'move' || at.mod) && !sessionFor(current) ? guideAt(current, at) : null

    if (guide) {
      const guideDrag = dragGuide(current, guide)
      begin({ move: (e) => guideDrag.move(pointerInfo(e), []), up: (e) => guideDrag.up(pointerInfo(e)), cancel: () => guideDrag.cancel?.() }, event)

      return
    }

    const handler = HANDLERS[$tool.get()]
    const toolDrag: ToolDrag | null | void = handler?.down(current, at)

    if (!toolDrag) {
      updateCursor(at)

      return
    }

    begin(
      {
        move: (e) => {
          const trail = (e.getCoalescedEvents?.() ?? []).map(pointerInfo)
          const now = pointerInfo(e)
          toolDrag.move(now, trail.length ? trail : [now])
        },
        up: (e) => {
          const now = pointerInfo(e)
          toolDrag.up(now)
          updateCursor(now)
        },
        cancel: () => toolDrag.cancel?.()
      },
      event
    )
  }

  const updateCursor = (at: PointerInfo | null) => {
    const element = host.current

    if (!element) {
      return
    }

    const current = docRef.current
    const name = $tool.get()

    const guide = at && !drag.current && (name === 'move' || at.mod) && !sessionFor(current) ? guideAt(current, at) : null

    if ($spaceHeld.get() || name === 'hand') {
      element.style.cursor = drag.current ? 'grabbing' : 'grab'
    } else if (name === 'zoom') {
      element.style.cursor = 'zoom-in'
    } else if (guide) {
      element.style.cursor = guide.axis === 'vertical' ? 'col-resize' : 'row-resize'
    } else {
      element.style.cursor = HANDLERS[name]?.cursor?.(current, at) ?? 'default'
    }
  }

  const onPointerMove = (event: React.PointerEvent) => {
    const at = pointerInfo(event)
    const { width, height } = docRef.current.state
    $pointer.set(at.x >= 0 && at.y >= 0 && at.x < width && at.y < height ? { x: Math.floor(at.x), y: Math.floor(at.y) } : null)

    if (!drag.current) {
      HANDLERS[$tool.get()]?.hover?.(docRef.current, at)
      updateCursor(at)
    }
  }

  const onPointerLeave = () => {
    $pointer.set(null)

    if (!drag.current) {
      HANDLERS[$tool.get()]?.hover?.(docRef.current, null)
    }
  }

  useEffect(() => updateCursor(null), [tool, space, dragging])

  return (
    <div
      ref={host}
      className={cn('relative min-h-0 min-w-0 flex-1 overflow-hidden touch-none select-none')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onDoubleClick={(event) => HANDLERS[$tool.get()]?.doubleClick?.(docRef.current, pointerInfo(event))}
      onAuxClick={(event) => event.preventDefault()}
    >
      <canvas ref={glCanvas} className="absolute inset-0 size-full" />
      <canvas ref={overlay} className="pointer-events-none absolute inset-0 size-full" />
      {typing?.docKey === doc.key && <TypeEditor doc={doc} session={typing} view={viewOf(doc)} />}
      {failure && (
        <div className="absolute inset-0 flex items-center justify-center p-8 text-center text-[13px] text-fg-3">
          <div className="max-w-sm">Veritas Canvas could not draw this document: {failure}</div>
        </div>
      )}
    </div>
  )
}

/** The selection's marching ants: white under black dashes that move along. */
function drawAnts(context: CanvasRenderingContext2D, selection: Raster, view: View, dpr: number, offset: [number, number]): void {
  const path = outlineOf(selection)
  context.save()
  context.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * (view.panX + offset[0] * view.zoom), dpr * (view.panY + offset[1] * view.zoom))
  context.lineWidth = 1 / view.zoom
  context.strokeStyle = '#fff'
  context.stroke(path)
  context.setLineDash([4 / view.zoom, 4 / view.zoom])
  context.lineDashOffset = -antsPhase / view.zoom
  context.strokeStyle = '#000'
  context.stroke(path)
  context.restore()
}

function drawOverlay(canvas: HTMLCanvasElement | null, doc: CanvasDocument, view: View, dpr: number): void {
  const context = canvas?.getContext('2d')

  if (!canvas || !context) {
    return
  }

  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.setTransform(dpr, 0, 0, dpr, 0, 0)
  const toScreen = docToScreen(view)
  const { width, height } = doc.state

  // The page edge, so a white document still reads against a light window.
  context.strokeStyle = 'rgba(255, 255, 255, 0.14)'
  context.lineWidth = 1
  context.strokeRect(Math.round(view.panX) - 0.5, Math.round(view.panY) - 0.5, Math.round(width * view.zoom) + 1, Math.round(height * view.zoom) + 1)

  const draft = $draftGuide.get()
  const guides = [...($viewOptions.get().guides ? doc.state.guides : []), ...(draft?.docKey === doc.key ? [draft] : [])]

  for (const guide of guides) {
    context.strokeStyle = guide === draft ? 'rgba(255, 255, 255, 0.9)' : 'rgba(0, 220, 255, 0.85)'
    context.beginPath()

    if (guide.axis === 'vertical') {
      const x = Math.round(view.panX + guide.position * view.zoom) + 0.5
      context.moveTo(x, 0)
      context.lineTo(x, canvas.height / dpr)
    } else {
      const y = Math.round(view.panY + guide.position * view.zoom) + 0.5
      context.moveTo(0, y)
      context.lineTo(canvas.width / dpr, y)
    }

    context.stroke()
  }

  drawSnapMarks(context, doc, view, { width: canvas.width / dpr, height: canvas.height / dpr })

  const tool = $tool.get()

  if (tool === 'move' && !$transform.get()) {
    context.strokeStyle = OUTLINE

    for (const layer of doc.picked) {
      if (layer.isGroup) {
        continue
      }

      const points = corners(layer.transform).map((point) => apply(toScreen, point))
      context.beginPath()
      points.forEach(([x, y], i) => (i ? context.lineTo(x, y) : context.moveTo(x, y)))
      context.closePath()
      context.stroke()
    }
  }

  if (doc.state.selection) {
    drawAnts(context, doc.state.selection, view, dpr, movingSelection.docKey === doc.key ? movingSelection.offset : [0, 0])
  }

  HANDLERS[tool]?.overlay?.(context, doc, view)
}
