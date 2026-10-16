/*
 * Guides: lines over the canvas that layers, crops and selections snap to, kept in the project's
 * `guides` (the format Compositor reads too). Adding, moving and removing them, and the layouts
 * Hermes asks for: margins, equal columns with gutters, and centre lines.
 */

import { type Guide, LIMITS, newId, RANGES } from '../../../../shared/canvas/comp-format.ts'
import type { DocState } from './document.ts'

export type GuideAxis = Guide['axis']

/** A guide's position held to the format's range and tidied to a hundredth of a pixel. */
const tidyPosition = (position: number): number => Math.round(Math.max(RANGES.position[0], Math.min(RANGES.position[1], position)) * 100) / 100

/** The document with guides added (one already there at the same place is not added twice). */
export function withGuides(state: DocState, added: readonly { axis: GuideAxis; position: number }[]): { state: DocState; added: Guide[] } {
  const guides = [...state.guides]
  const made: Guide[] = []

  for (const { axis, position } of added) {
    const at = tidyPosition(position)

    if (guides.some((guide) => guide.axis === axis && Math.abs(guide.position - at) < 0.005)) {
      continue
    }

    if (guides.length >= LIMITS.guides) {
      throw new Error(`A document holds at most ${LIMITS.guides.toLocaleString('en')} guides`)
    }

    const guide: Guide = { id: newId(), axis, position: at }
    guides.push(guide)
    made.push(guide)
  }

  return { state: made.length ? { ...state, guides } : state, added: made }
}

export const withGuideMoved = (state: DocState, id: string, position: number): DocState => ({ ...state, guides: state.guides.map((guide) => (guide.id === id ? { ...guide, position: tidyPosition(position) } : guide)) })

export const withoutGuides = (state: DocState, ids: Iterable<string>): DocState => {
  const gone = new Set(ids)

  return { ...state, guides: state.guides.filter((guide) => !gone.has(guide.id)) }
}

/** Is a guide's position on the canvas (a guide dragged off it is deleted)? */
export const onCanvas = (state: { width: number; height: number }, axis: GuideAxis, position: number): boolean => position >= 0 && position <= (axis === 'vertical' ? state.width : state.height)

/** A position in pixels from a number or a percentage of `length` ("50%"); undefined when not given. */
export function positionFrom(value: unknown, length: number, name = 'position'): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }

  const text = String(value).trim()
  const percent = /^(-?\d+(?:\.\d+)?)\s*%$/.exec(text)
  const number = percent ? (Number(percent[1]) / 100) * length : Number(text)

  if (!Number.isFinite(number)) {
    throw new Error(`${name} is pixels or a percentage, like 540 or "50%"`)
  }

  return number
}

export interface GuideLayout {
  /** Pixels in from each edge. */
  margins?: number
  /** Equal columns between the margins (vertical guides at each column's edges). */
  columns?: number
  /** Pixels between columns. */
  gutter?: number
  /** Guides through the middle, both ways. */
  center?: boolean
}

/** The guides a layout asks for on a canvas. */
export function layoutGuides(canvas: { width: number; height: number }, layout: GuideLayout): { axis: GuideAxis; position: number }[] {
  const out: { axis: GuideAxis; position: number }[] = []
  const margin = Math.max(0, layout.margins ?? 0)

  if (margin > 0) {
    if (margin * 2 >= Math.min(canvas.width, canvas.height)) {
      throw new Error(`margins of ${margin} pixels leave nothing of a ${canvas.width}×${canvas.height} canvas`)
    }

    out.push({ axis: 'vertical', position: margin }, { axis: 'vertical', position: canvas.width - margin }, { axis: 'horizontal', position: margin }, { axis: 'horizontal', position: canvas.height - margin })
  }

  const columns = Math.round(layout.columns ?? 0)

  if (columns > 1) {
    if (columns > 100) {
      throw new Error('columns is at most 100')
    }

    const gutter = Math.max(0, layout.gutter ?? 0)
    const inner = canvas.width - margin * 2
    const width = (inner - gutter * (columns - 1)) / columns

    if (width <= 0) {
      throw new Error(`${columns} columns with a ${gutter}-pixel gutter do not fit in ${inner} pixels`)
    }

    for (let i = 0; i < columns; i++) {
      const left = margin + i * (width + gutter)

      if (i > 0) {
        out.push({ axis: 'vertical', position: left })
      }

      if (i < columns - 1) {
        out.push({ axis: 'vertical', position: left + width })
      }
    }
  }

  if (layout.center) {
    out.push({ axis: 'vertical', position: canvas.width / 2 }, { axis: 'horizontal', position: canvas.height / 2 })
  }

  return out
}

/** The guide nearest a position on an axis, within `reach`; undefined when none is that close. */
export function guideNear(state: DocState, axis: GuideAxis, position: number, reach = 1): Guide | undefined {
  return state.guides.filter((guide) => guide.axis === axis && Math.abs(guide.position - position) <= reach).sort((a, b) => Math.abs(a.position - position) - Math.abs(b.position - position))[0]
}
