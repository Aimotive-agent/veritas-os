/*
 * The Type tool: click to start a line of text where the click is (its first baseline), or drag a
 * box for paragraph text that wraps inside it, then type on the canvas. Clicking a text layer
 * edits it again. Clicking elsewhere, another tool or ⌘Enter puts the text in; Escape drops the
 * edit. The options bar's font, size, colour and spacing apply to the text being typed (or to the
 * active text layer).
 */

import { atom } from 'nanostores'
import { defaultTransform, type LayerTransform, type TextStyle, type Vec2 } from '../../../../shared/canvas/comp-format.ts'
import { type CanvasDocument, type CanvasLayer, findLayer, insertLayer, isShown, placementFor, removeLayers, withLayer } from '../engine/document.ts'
import { containsPoint } from '../engine/geometry.ts'
import type { View } from '../engine/gpu/view.ts'
import type { Rect } from '../engine/raster.ts'
import { quadOf } from '../engine/transform.ts'
import { editedRuns, fontFace, layoutText, measureFor, originForAnchor, postScriptName, type TextLayout, textStyle } from '../engine/text.ts'
import { $documents, notify } from '../store.ts'
import { makeTextLayer, restyleText, textPlacement } from '../text-layers.ts'
import { drawOutline } from './select.ts'
import { $foreground, $type, setTool, type TypeOptions } from './state.ts'
import { redraw, type ToolHandler } from './types.ts'

export interface TypeSession {
  docKey: string
  /** The text layer being edited; null for new text. */
  layerId: string | null
  /** The style as edited, with the text typed so far. */
  style: TextStyle
  /** New text: the point it hangs from (point text), or its box's top-left (paragraph text). */
  at: Vec2
}

export const $typing = atom<TypeSession | null>(null)

/** A text style from the options bar and the foreground colour. */
export function optionsStyle(content: string, options: TypeOptions = $type.get()): TextStyle {
  const [r, g, b] = $foreground.get()

  return textStyle({
    content,
    fontName: postScriptName({ family: options.family, weight: options.weight, italic: options.italic }),
    fontSize: options.size,
    red: r / 255,
    green: g / 255,
    blue: b / 255,
    alignment: options.alignment,
    tracking: options.tracking,
    leading: options.leading
  })
}

/** The options bar set from a text style (when a text layer is picked up for editing). */
export function optionsFrom(style: TextStyle): TypeOptions {
  const face = fontFace(style.fontName)

  return { family: face.family, weight: face.weight, italic: face.italic, size: style.fontSize, alignment: style.alignment, tracking: style.tracking, leading: style.leading }
}

/** The topmost shown text layer under a document point. */
export function textLayerAt(doc: CanvasDocument, x: number, y: number): CanvasLayer | null {
  for (let i = doc.state.layers.length - 1; i >= 0; i--) {
    const layer = doc.state.layers[i]

    if (layer.text && isShown(doc.state, layer) && containsPoint(layer.transform, [x, y])) {
      return layer
    }
  }

  return null
}

function begin(doc: CanvasDocument, session: TypeSession): void {
  $typing.set(session)
  doc.interacting = true
  redraw()
}

/** Edit a text layer's text on the canvas (the Type tool is picked up for it). */
export async function editTextLayer(doc: CanvasDocument, layer: CanvasLayer): Promise<void> {
  if (!layer.text) {
    return
  }

  await commitTyping(doc)

  if (doc.state.activeLayerId !== layer.id) {
    doc.select(layer.id)
  }

  setTool('type')
  $type.set(optionsFrom(layer.text))
  begin(doc, { docKey: doc.key, layerId: layer.id, style: layer.text, at: [0, 0] })
}

/** Where the text being typed sits: its layout, and the placement of its box in the document. */
export function typingPlacement(doc: CanvasDocument, session: TypeSession): { layout: TextLayout; transform: LayerTransform } | null {
  const layer = session.layerId ? findLayer(doc.state, session.layerId) : null

  if (session.layerId) {
    return layer?.text ? textPlacement(layer.transform, layer.text, session.style) : null
  }

  const layout = layoutText(session.style, measureFor(session.style))
  const [x, y] = session.style.boxSize ? session.at : originForAnchor(layout, session.at[0], session.at[1])

  return { layout, transform: defaultTransform(layout.width, layout.height, x, y) }
}

/** Put the typed text in as one step: a new layer, the edited one, or (emptied) no layer at all. */
export async function commitTyping(doc: CanvasDocument | null = null): Promise<void> {
  const session = $typing.get()
  $typing.set(null)
  redraw()

  if (!session) {
    return
  }

  const target = doc && doc.key === session.docKey ? doc : $documents.get().find((entry) => entry.key === session.docKey)

  if (!target) {
    return
  }

  target.interacting = false
  const empty = !session.style.content.trim()

  try {
    if (!session.layerId) {
      if (!empty) {
        const layer = await makeTextLayer(session.style, session.at, { from: session.style.boxSize ? 'top' : 'anchor' })
        target.commit('Type Tool', insertLayer(target.state, layer, placementFor(target.state)))
      }

      return
    }

    const layer = findLayer(target.state, session.layerId)

    if (!layer?.text) {
      return
    }

    if (empty) {
      target.commit('Delete Layer', removeLayers(target.state, [layer.id]))
    } else if (JSON.stringify(layer.text) !== JSON.stringify(session.style)) {
      target.commit('Edit Type', withLayer(target.state, layer.id, await restyleText(layer, session.style)))
    }
  } catch (error) {
    notify(`Could not set the text: ${error instanceof Error ? error.message : String(error)}`, 'error')
  }
}

/** Drop the text being typed. */
export function cancelTyping(): void {
  const session = $typing.get()
  $typing.set(null)
  redraw()

  const doc = session && $documents.get().find((entry) => entry.key === session.docKey)

  if (doc) {
    doc.interacting = false
  }
}

/** Change the text being typed (or the active text layer) from the options bar. */
export function applyTypeOptions(doc: CanvasDocument, options: TypeOptions, colour?: [number, number, number]): void {
  const session = $typing.get()
  // A face or colour picked for the whole text lets go of the runs of that kind (see `editedRuns`).
  const fromOptions = (style: TextStyle): TextStyle => {
    const next = optionsStyle(style.content, options)
    const [red, green, blue] = colour ? colour.map((value) => value / 255) : [style.red, style.green, style.blue]
    // The same face keeps the name it had (one from Photoshop or Compositor may be spelled otherwise).
    const face = fontFace(style.fontName)
    const fontName = face.family === options.family && face.weight === options.weight && face.italic === options.italic ? style.fontName : next.fontName

    return editedRuns(style, { ...style, ...next, fontName, red, green, blue, ...(style.boxSize ? { boxSize: style.boxSize } : {}) })
  }

  if (session?.docKey === doc.key) {
    $typing.set({ ...session, style: fromOptions(session.style) })

    return
  }

  const layer = doc.active

  if (layer?.text) {
    const style = fromOptions(layer.text)
    void restyleText(layer, style).then((patch) => {
      if (doc.layer(layer.id)?.text === layer.text) {
        doc.commit('Text Style', withLayer(doc.state, layer.id, patch))
      }
    })
  }
}

/** The box being dragged for paragraph text. */
let dragging: { docKey: string; box: Rect } | null = null

export const typeTool: ToolHandler = {
  cursor: () => 'text',

  down(doc, at) {
    // A click outside the text being typed puts it in.
    if ($typing.get()) {
      void commitTyping(doc)

      return null
    }

    const hit = textLayerAt(doc, at.x, at.y)

    if (hit) {
      void editTextLayer(doc, hit)

      return null
    }

    const from: Vec2 = [at.x, at.y]

    return {
      move: (now) => {
        const x = Math.min(from[0], now.x)
        const y = Math.min(from[1], now.y)
        dragging = { docKey: doc.key, box: { x, y, width: Math.abs(now.x - from[0]), height: Math.abs(now.y - from[1]) } }
        redraw()
      },
      up: () => {
        const box = dragging?.box
        dragging = null

        if (box && box.width >= 8 && box.height >= 8) {
          const style = { ...optionsStyle(''), boxSize: [Math.round(box.width), Math.round(box.height)] as Vec2 }
          begin(doc, { docKey: doc.key, layerId: null, style, at: [Math.round(box.x), Math.round(box.y)] })
        } else {
          begin(doc, { docKey: doc.key, layerId: null, style: optionsStyle(''), at: from })
        }
      },
      cancel: () => {
        dragging = null
        redraw()
      }
    }
  },

  key(_doc, event) {
    if (event.key === 'Escape' && $typing.get()) {
      cancelTyping()

      return true
    }

    return false
  },

  overlay(context, doc, view: View) {
    const session = $typing.get()
    const placement = session?.docKey === doc.key ? typingPlacement(doc, session) : null

    if (placement) {
      drawOutline(context, quadOf(placement.transform), view, true)
    }

    if (dragging?.docKey === doc.key) {
      const { x, y, width, height } = dragging.box
      drawOutline(
        context,
        [
          [x, y],
          [x + width, y],
          [x + width, y + height],
          [x, y + height]
        ],
        view,
        true
      )
    }
  },

  release(doc) {
    void commitTyping(doc)
  }
}
