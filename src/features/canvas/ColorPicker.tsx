import { useEffect, useRef, useState } from 'react'
import { cn } from '../../lib/cn.ts'
import { cssOf, hexOf, hsvToRgb, parseHex, type RGB, rgbToHsv } from './color.ts'

/** Drag inside an element: the pointer's position across and down it, 0 to 1. */
function useDrag(onChange: (x: number, y: number) => void) {
  const ref = useRef<HTMLDivElement>(null)

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const element = ref.current!
    element.setPointerCapture(event.pointerId)
    const report = (e: { clientX: number; clientY: number }) => {
      const rect = element.getBoundingClientRect()
      onChange(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)))
    }
    report(event)
    const move = (e: PointerEvent) => report(e)
    const up = () => {
      element.removeEventListener('pointermove', move)
      element.removeEventListener('pointerup', up)
    }
    element.addEventListener('pointermove', move)
    element.addEventListener('pointerup', up)
  }

  return { ref, onPointerDown }
}

/**
 * A small colour picker: saturation and brightness in a square, hue on a strip, a hex field and
 * the system's own picker. Changes apply as they are made.
 */
export function ColorPicker({ colour, onChange, onClose, title, className }: { colour: RGB; onChange: (colour: RGB) => void; onClose: () => void; title: string; className?: string }) {
  const root = useRef<HTMLDivElement>(null)
  // Hue is kept apart from the colour, so it survives a trip through gray.
  const [hsv, setHsv] = useState(() => rgbToHsv(colour))
  const [hex, setHex] = useState(hexOf(colour))

  useEffect(() => {
    if (hexOf(hsvToRgb(hsv)) !== hexOf(colour)) {
      const next = rgbToHsv(colour)
      setHsv(next[1] === 0 ? [hsv[0], next[1], next[2]] : next)
    }

    setHex(hexOf(colour))
  }, [colour])

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        onClose()
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)

    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  const set = (next: [number, number, number]) => {
    setHsv(next)
    onChange(hsvToRgb(next))
  }

  const square = useDrag((x, y) => set([hsv[0], x, 1 - y]))
  const strip = useDrag((x) => set([x * 360, hsv[1], hsv[2]]))
  const hue = cssOf(hsvToRgb([hsv[0], 1, 1]))

  return (
    <div ref={root} role="dialog" aria-label={title} className={cn('float menu-surface absolute z-40 w-56 rounded-xl p-3 animate-pop', className)} onMouseDown={(event) => event.stopPropagation()}>
      <div className="mb-2 text-[11.5px] text-fg-3">{title}</div>
      <div
        ref={square.ref}
        onPointerDown={square.onPointerDown}
        className="relative h-36 w-full cursor-crosshair touch-none rounded-lg"
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hue})` }}
      >
        <div
          className="pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
          style={{ left: `${hsv[1] * 100}%`, top: `${(1 - hsv[2]) * 100}%`, background: cssOf(colour) }}
        />
      </div>
      <div
        ref={strip.ref}
        onPointerDown={strip.onPointerDown}
        className="relative mt-2.5 h-3 w-full cursor-pointer touch-none rounded-full"
        style={{ background: 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)' }}
      >
        <div className="pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.5)]" style={{ left: `${(hsv[0] / 360) * 100}%`, background: hue }} />
      </div>
      <div className="mt-3 flex items-center gap-2">
        <span className="size-7 shrink-0 rounded-md ring-1 ring-line" style={{ background: cssOf(colour) }} />
        <input
          aria-label="Hex colour"
          value={hex}
          onChange={(event) => {
            setHex(event.target.value)
            const parsed = parseHex(event.target.value)

            if (parsed) {
              onChange(parsed)
            }
          }}
          onKeyDown={(event) => event.stopPropagation()}
          className="glass-input h-7 min-w-0 flex-1 rounded-md px-2 font-mono text-[12px] text-fg outline-none"
        />
        <label className="relative grid h-7 shrink-0 cursor-pointer place-items-center rounded-md px-2 text-[11.5px] text-fg-2 ring-1 ring-line hover:bg-white/8" title="The system colour picker">
          More…
          <input type="color" value={hexOf(colour)} onChange={(event) => onChange(parseHex(event.target.value) ?? colour)} className="absolute inset-0 cursor-pointer opacity-0" />
        </label>
      </div>
    </div>
  )
}
