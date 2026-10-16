import { IconArrowUpRight, IconArrowBackUp, IconCopy, IconDeviceFloppy, IconEyeOff, IconHighlight, IconPencil, IconSquare, IconTrash, IconTypography } from '@tabler/icons-react'
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react'
import { HermesAvatar } from '../../components/app-icon.tsx'
import { GlassButton } from '../../components/ui/glass.tsx'
import { cn } from '../../lib/cn.ts'
import { askAbout } from '../../store/capture.ts'
import { notify } from '../../store/notifications.ts'

/*
 * Markup: draw on a screenshot before sharing it. Shapes are kept in image pixels and drawn on a
 * canvas the size of the image, so saving writes the full resolution whatever the window's size.
 * "Hide" covers something private with a solid block before the picture goes anywhere.
 */

type Tool = 'arrow' | 'pen' | 'box' | 'highlight' | 'hide' | 'text'

interface Point {
  x: number
  y: number
}

interface Shape {
  tool: Tool
  color: string
  points: Point[]
  text?: string
}

const TOOLS: { id: Tool; label: string; icon: React.ReactNode }[] = [
  { id: 'arrow', label: 'Arrow', icon: <IconArrowUpRight /> },
  { id: 'pen', label: 'Pen', icon: <IconPencil /> },
  { id: 'box', label: 'Box', icon: <IconSquare /> },
  { id: 'highlight', label: 'Highlight', icon: <IconHighlight /> },
  { id: 'hide', label: 'Hide (black out)', icon: <IconEyeOff /> },
  { id: 'text', label: 'Text', icon: <IconTypography /> }
]

// Annotation ink is part of the picture, not the interface, so it keeps its own fixed colours.
const COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#ffffff', '#000000']

function drawShape(ctx: CanvasRenderingContext2D, shape: Shape, scale: number): void {
  const [start, end = start] = [shape.points[0], shape.points[shape.points.length - 1]]
  const width = Math.max(3, scale * 4)
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = shape.color
  ctx.fillStyle = shape.color
  ctx.lineWidth = width

  switch (shape.tool) {
    case 'pen':
    case 'highlight':
      if (shape.tool === 'highlight') {
        ctx.globalAlpha = 0.35
        ctx.lineWidth = width * 5
      }

      ctx.beginPath()
      shape.points.forEach((point, i) => (i === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)))
      ctx.stroke()
      break
    case 'box':
      ctx.strokeRect(Math.min(start.x, end.x), Math.min(start.y, end.y), Math.abs(end.x - start.x), Math.abs(end.y - start.y))
      break
    case 'hide':
      ctx.fillStyle = '#000000'
      ctx.fillRect(Math.min(start.x, end.x), Math.min(start.y, end.y), Math.abs(end.x - start.x), Math.abs(end.y - start.y))
      break
    case 'arrow': {
      const angle = Math.atan2(end.y - start.y, end.x - start.x)
      const head = width * 5
      ctx.beginPath()
      ctx.moveTo(start.x, start.y)
      ctx.lineTo(end.x, end.y)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(end.x, end.y)
      ctx.lineTo(end.x - head * Math.cos(angle - Math.PI / 7), end.y - head * Math.sin(angle - Math.PI / 7))
      ctx.lineTo(end.x - head * Math.cos(angle + Math.PI / 7), end.y - head * Math.sin(angle + Math.PI / 7))
      ctx.closePath()
      ctx.fill()
      break
    }
    case 'text':
      ctx.font = `600 ${Math.round(width * 7)}px -apple-system, system-ui, sans-serif`
      ctx.textBaseline = 'top'
      ctx.lineWidth = width * 1.2
      ctx.strokeStyle = shape.color === '#000000' ? '#ffffff' : '#000000'
      ctx.strokeText(shape.text ?? '', start.x, start.y)
      ctx.fillText(shape.text ?? '', start.x, start.y)
      break
  }

  ctx.restore()
}

export function CaptureEditor({ file }: { file?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tool, setTool] = useState<Tool>('arrow')
  const [color, setColor] = useState(COLORS[0])
  const [shapes, setShapes] = useState<Shape[]>([])
  const [draft, setDraft] = useState<Shape | null>(null)
  const [typing, setTyping] = useState<{ at: Point; css: Point; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!file) {
      return
    }

    let cancelled = false
    window.heraldOS.capture
      .readImage(file)
      .then(url => {
        const img = new Image()
        img.onload = () => !cancelled && setImage(img)
        img.src = url
      })
      .catch(reason => setError(reason instanceof Error ? reason.message : String(reason)))

    return () => {
      cancelled = true
    }
  }, [file])

  // A line a few pixels wide on screen, whatever the screenshot's resolution.
  const scale = image ? Math.max(1, image.naturalWidth / 1400) : 1

  useEffect(() => {
    const node = canvas.current
    const ctx = node?.getContext('2d')

    if (!node || !ctx || !image) {
      return
    }

    node.width = image.naturalWidth
    node.height = image.naturalHeight
    ctx.drawImage(image, 0, 0)

    for (const shape of draft ? [...shapes, draft] : shapes) {
      drawShape(ctx, shape, scale)
    }
  }, [image, shapes, draft, scale])

  const toImage = (event: ReactPointerEvent<HTMLCanvasElement>): { image: Point; css: Point } => {
    const rect = event.currentTarget.getBoundingClientRect()
    const css = { x: event.clientX - rect.left, y: event.clientY - rect.top }

    return { image: { x: (css.x * event.currentTarget.width) / rect.width, y: (css.y * event.currentTarget.height) / rect.height }, css }
  }

  const down = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const { image: point, css } = toImage(event)

    if (tool === 'text') {
      setTyping({ at: point, css, text: '' })

      return
    }

    event.currentTarget.setPointerCapture(event.pointerId)
    setDraft({ tool, color, points: [point] })
  }

  const move = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!draft) {
      return
    }

    const { image: point } = toImage(event)
    setDraft({ ...draft, points: draft.tool === 'pen' || draft.tool === 'highlight' ? [...draft.points, point] : [draft.points[0], point] })
  }

  const up = () => {
    if (draft && draft.points.length > 1) {
      setShapes(current => [...current, draft])
    }

    setDraft(null)
  }

  const exportPng = () => canvas.current?.toDataURL('image/png') ?? ''

  const markedUpName = (source: string) => source.replace(/(\.[a-z0-9]+)?$/i, ' (marked up).png')

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true)

    try {
      await work()
    } catch (reason) {
      notify({ title: 'Markup', body: reason instanceof Error ? reason.message : String(reason), level: 'error' })
    } finally {
      setBusy(false)
    }
  }

  if (!file) {
    return <div className="flex h-full items-center justify-center text-[13px] text-fg-3">Take a screenshot to mark it up.</div>
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
        {TOOLS.map(item => (
          <button key={item.id} type="button" aria-label={item.label} title={item.label} aria-pressed={tool === item.id} onClick={() => setTool(item.id)} className={cn('flex size-8 items-center justify-center rounded-lg [&_svg]:size-4', tool === item.id ? 'bg-accent text-accent-fg' : 'text-fg-2 hover:bg-white/10 hover:text-fg')}>
            {item.icon}
          </button>
        ))}
        <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
        {COLORS.map(swatch => (
          <button key={swatch} type="button" aria-label={`Colour ${swatch}`} aria-pressed={color === swatch} onClick={() => setColor(swatch)} className={cn('size-6 rounded-full border border-line', color === swatch && 'ring-2 ring-accent-strong')} style={{ background: swatch }} />
        ))}
        <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
        <GlassButton size="icon" variant="ghost" aria-label="Undo" disabled={shapes.length === 0} onClick={() => setShapes(current => current.slice(0, -1))}>
          <IconArrowBackUp />
        </GlassButton>
        <GlassButton size="icon" variant="ghost" aria-label="Clear everything" disabled={shapes.length === 0} onClick={() => setShapes([])}>
          <IconTrash />
        </GlassButton>
        <span className="flex-1" />
        <GlassButton size="sm" variant="ghost" disabled={busy || !image} onClick={() => void act(async () => window.heraldOS.capture.copyImage(exportPng()).then(() => notify({ title: 'Copied', body: 'The marked-up picture is on the clipboard.', level: 'success' })))}>
          <IconCopy />
          Copy
        </GlassButton>
        <GlassButton
          size="sm"
          variant="ghost"
          disabled={busy || !image}
          onClick={() =>
            void act(async () => {
              const saved = await window.heraldOS.capture.saveImage(markedUpName(file), exportPng())
              askAbout(saved)
            })
          }
        >
          <HermesAvatar size={16} rounded={4} />
          Ask Hermes
        </GlassButton>
        <GlassButton size="sm" variant="primary" disabled={busy || !image} onClick={() => void act(async () => window.heraldOS.capture.saveImage(markedUpName(file), exportPng()).then(saved => notify({ title: 'Saved', body: saved.split('/').pop() ?? saved, level: 'success', actions: [{ label: 'Show', command: 'files.show', args: { path: saved } }] })))}>
          <IconDeviceFloppy />
          Save
        </GlassButton>
      </div>
      <div className="relative min-h-0 flex-1 overflow-auto p-3">
        {error ? (
          <div className="text-[13px] text-danger">{error}</div>
        ) : !image ? (
          <div className="shimmer h-full w-full rounded-xl" />
        ) : (
          <div className="relative mx-auto w-fit">
            <canvas ref={canvas} onPointerDown={down} onPointerMove={move} onPointerUp={up} className="block max-h-[calc(100vh-140px)] max-w-full cursor-crosshair rounded-lg shadow-(--shadow-card)" aria-label="Screenshot to mark up" />
            {typing && (
              <input
                autoFocus
                value={typing.text}
                onChange={event => setTyping({ ...typing, text: event.target.value })}
                onKeyDown={event => {
                  if (event.key === 'Enter' && typing.text.trim()) {
                    setShapes(current => [...current, { tool: 'text', color, points: [typing.at], text: typing.text.trim() }])
                    setTyping(null)
                  } else if (event.key === 'Escape') {
                    setTyping(null)
                  }
                }}
                onBlur={() => setTyping(null)}
                placeholder="Type, then Enter"
                aria-label="Text to add"
                className="glass-input absolute h-8 w-56 rounded-md px-2 text-[13px] outline-none"
                style={{ left: typing.css.x, top: typing.css.y }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}
