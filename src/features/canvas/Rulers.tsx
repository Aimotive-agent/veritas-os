import { useStore } from '@nanostores/react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '../../lib/cn.ts'
import type { CanvasDocument } from './engine/document.ts'
import { onCanvas, withGuides } from './engine/guides.ts'
import { rulerSteps } from './engine/snapping.ts'
import { $draftGuide, snapPoint } from './tools/snap.ts'
import { $pointer, $viewOptions, $views, viewOf } from './view-state.ts'

/*
 * Rulers along the top and left of the view, in pixels, with a mark where the pointer is. A guide
 * comes out of a ruler: drag from the top one for a horizontal guide, from the left one for a
 * vertical guide, and let go over the canvas.
 */

const SIDE = 20

function Ruler({ doc, axis }: { doc: CanvasDocument; axis: 'horizontal' | 'vertical' }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const views = useStore($views)
  const pointer = useStore($pointer)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const across = axis === 'horizontal'

  useEffect(() => {
    const element = ref.current!
    const observer = new ResizeObserver(() => {
      const rect = element.getBoundingClientRect()
      setSize({ width: rect.width, height: rect.height })
    })
    observer.observe(element)

    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = ref.current
    const context = canvas?.getContext('2d')

    if (!canvas || !context || !size.width || !size.height) {
      return
    }

    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(size.width * dpr)
    canvas.height = Math.round(size.height * dpr)
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, size.width, size.height)
    const view = viewOf(doc)
    const length = across ? size.width : size.height
    const pan = across ? view.panX : view.panY
    const { step, parts } = rulerSteps(view.zoom)
    const minor = step / parts
    const first = Math.floor(-pan / view.zoom / step) * step
    context.strokeStyle = 'rgba(255, 255, 255, 0.32)'
    context.fillStyle = 'rgba(255, 255, 255, 0.62)'
    context.font = '9.5px system-ui, sans-serif'
    context.lineWidth = 1
    context.beginPath()

    for (let at = first; pan + at * view.zoom <= length; at += minor) {
      const screen = Math.round(pan + at * view.zoom) + 0.5
      const major = Math.abs(at / step - Math.round(at / step)) < 1e-6
      const half = !major && parts % 2 === 0 && Math.abs(at / (step / 2) - Math.round(at / (step / 2))) < 1e-6
      const tick = major ? SIDE : half ? 8 : 4

      if (across) {
        context.moveTo(screen, SIDE - tick)
        context.lineTo(screen, SIDE)
      } else {
        context.moveTo(SIDE - tick, screen)
        context.lineTo(SIDE, screen)
      }

      if (major) {
        const label = String(Math.round(at))

        if (across) {
          context.fillText(label, screen + 3, 9)
        } else {
          context.save()
          context.translate(9, screen + 3)
          context.rotate(-Math.PI / 2)
          context.textAlign = 'right'
          context.fillText(label, 0, 0)
          context.restore()
        }
      }
    }

    context.stroke()

    // Where the pointer is.
    if (pointer) {
      const screen = Math.round(pan + (across ? pointer.x + 0.5 : pointer.y + 0.5) * view.zoom) + 0.5
      context.strokeStyle = 'rgba(77, 163, 255, 0.95)'
      context.beginPath()

      if (across) {
        context.moveTo(screen, 0)
        context.lineTo(screen, SIDE)
      } else {
        context.moveTo(0, screen)
        context.lineTo(SIDE, screen)
      }

      context.stroke()
    }
  }, [views, pointer, size, doc, across])

  // A guide pulled out of the ruler: horizontal from the top one, vertical from the left one.
  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) {
      return
    }

    event.preventDefault()
    const element = event.currentTarget
    element.setPointerCapture(event.pointerId)
    const rect = element.getBoundingClientRect()
    const guideAxis = across ? 'horizontal' : 'vertical'
    // The view starts where the ruler ends.
    const origin = across ? rect.bottom : rect.right
    let position: number | null = null

    const move = (e: PointerEvent) => {
      const view = viewOf(doc)
      const screen = (across ? e.clientY : e.clientX) - origin

      if (screen < 0) {
        position = null
        $draftGuide.set(null)

        return
      }

      const raw = (screen - (across ? view.panY : view.panX)) / view.zoom
      const snapped = e.shiftKey ? raw : across ? snapPoint(doc, [Number.NaN, raw], view, { guides: false })[1] : snapPoint(doc, [raw, Number.NaN], view, { guides: false })[0]
      position = Math.round(snapped)
      $draftGuide.set({ docKey: doc.key, axis: guideAxis, position })
    }
    const up = () => {
      element.removeEventListener('pointermove', move)
      element.removeEventListener('pointerup', up)
      element.removeEventListener('pointercancel', up)
      $draftGuide.set(null)

      if (position !== null && onCanvas(doc.state, guideAxis, position)) {
        doc.commit('New Guide', withGuides(doc.state, [{ axis: guideAxis, position }]).state)
      }
    }
    element.addEventListener('pointermove', move)
    element.addEventListener('pointerup', up)
    element.addEventListener('pointercancel', up)
  }

  return (
    <canvas
      ref={ref}
      aria-label={across ? 'Horizontal ruler: drag down for a guide' : 'Vertical ruler: drag right for a guide'}
      onPointerDown={onPointerDown}
      className={cn('block border-line bg-black/25', across ? 'h-5 min-w-0 flex-1 cursor-row-resize border-b' : 'w-5 shrink-0 cursor-col-resize self-stretch border-r')}
    />
  )
}

/** The view with rulers on its top and left edges, when View > Rulers is on. */
export function Rulers({ doc, children }: { doc: CanvasDocument; children: React.ReactNode }) {
  const { rulers } = useStore($viewOptions)

  if (!rulers) {
    return <>{children}</>
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-5 shrink-0">
        <div className="w-5 shrink-0 border-r border-b border-line bg-black/25" />
        <Ruler doc={doc} axis="horizontal" />
      </div>
      <div className="flex min-h-0 flex-1">
        <Ruler doc={doc} axis="vertical" />
        {children}
      </div>
    </div>
  )
}
