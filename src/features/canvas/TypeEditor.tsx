import { useEffect, useRef } from 'react'
import type { CanvasDocument } from './engine/document.ts'
import { multiply } from './engine/geometry.ts'
import { docToScreen, type View } from './engine/gpu/view.ts'
import { fontCss, isParagraph, measureFor } from './engine/text.ts'
import { layoutToDocument } from './text-layers.ts'
import { $typing, cancelTyping, commitTyping, type TypeSession, typingPlacement } from './tools/type.ts'

/**
 * The text being typed, on the canvas where it will be: a text field laid over the layer's box,
 * turned, flipped and scaled the way the layer is, in its font and colour. Escape drops the edit,
 * ⌘Enter puts it in.
 */
export function TypeEditor({ doc, session, view }: { doc: CanvasDocument; session: TypeSession; view: View }) {
  const field = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const element = field.current
    const root = element?.closest<HTMLElement>('[data-canvas-root]')

    if (element) {
      element.focus({ preventScroll: true })
      element.setSelectionRange(element.value.length, element.value.length)
    }

    // The window keeps the keys once the text is put in (tool keys, shortcuts).
    return () => {
      if (!document.activeElement || document.activeElement === element || document.activeElement === document.body) {
        root?.focus({ preventScroll: true })
      }
    }
  }, [session.docKey, session.layerId])

  const placement = typingPlacement(doc, session)

  if (!placement) {
    return null
  }

  const { layout, transform } = placement
  const { style } = session
  const m = multiply(docToScreen(view), layoutToDocument(transform, layout))
  const measure = measureFor(style)
  // A text field centres each line in its line height; the layout puts the baseline one ascent down.
  const shift = layout.pad - (layout.lineHeight - measure.ascent - measure.descent) / 2
  const colour = `rgb(${Math.round(style.red * 255)} ${Math.round(style.green * 255)} ${Math.round(style.blue * 255)})`
  const paragraph = isParagraph(style)

  return (
    <div
      className="absolute top-0 left-0 origin-top-left"
      style={{ transform: `matrix(${m.a}, ${m.b}, ${m.c}, ${m.d}, ${m.e}, ${m.f})`, width: layout.width, height: layout.height }}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <textarea
        ref={field}
        value={style.content}
        spellCheck={false}
        aria-label="Text"
        onChange={(event) => $typing.set({ ...session, style: { ...style, content: event.target.value } })}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            cancelTyping()
          } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            event.stopPropagation()
            void commitTyping(doc)
          }
        }}
        className="block resize-none overflow-hidden border-0 bg-transparent p-0 outline-none"
        style={{
          width: layout.width,
          height: layout.height,
          outline: 'none',
          boxShadow: 'none',
          transform: `translateY(${shift}px)`,
          paddingLeft: layout.pad,
          paddingRight: layout.pad,
          font: fontCss(style.fontName, style.fontSize),
          letterSpacing: `${style.tracking}px`,
          lineHeight: `${layout.lineHeight}px`,
          color: colour,
          caretColor: colour,
          textAlign: style.alignment === 'Center' ? 'center' : style.alignment === 'Right' ? 'right' : 'left',
          whiteSpace: paragraph ? 'pre-wrap' : 'pre',
          overflowWrap: paragraph ? 'anywhere' : 'normal'
        }}
      />
    </div>
  )
}
