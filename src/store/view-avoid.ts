import { atom } from 'nanostores'
import { type RefObject, useLayoutEffect } from 'react'

/*
 * Native web views (pages, the file viewer) draw above all DOM, so shell overlays that must stay
 * visible while a page is open (the voice pill, action captions) register their rect here and web
 * windows trim their view around them.
 */

export interface AvoidRect {
  top: number
  bottom: number
  left: number
  right: number
}

export const $viewAvoid = atom<Record<string, AvoidRect>>({})

let counter = 0

/** Keep the element's on-screen rect registered while it is mounted. */
export function useViewAvoid(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const element = ref.current

    if (!element) {
      return
    }

    const key = `avoid-${++counter}`
    const report = () => {
      const rect = element.getBoundingClientRect()
      $viewAvoid.set({ ...$viewAvoid.get(), [key]: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right } })
    }

    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    window.addEventListener('resize', report)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      const next = { ...$viewAvoid.get() }
      delete next[key]
      $viewAvoid.set(next)
    }
  }, [ref])
}

const GAP = 8

/** Trim a view rect so it stops short of every avoided rect it overlaps (from below or above). */
export function trimAround(rect: { x: number; y: number; width: number; height: number }, avoid: readonly AvoidRect[]): { x: number; y: number; width: number; height: number } {
  let top = rect.y
  let bottom = rect.y + rect.height

  for (const a of avoid) {
    const overlaps = a.left < rect.x + rect.width && rect.x < a.right && a.top < bottom && top < a.bottom

    if (!overlaps) {
      continue
    }

    if ((a.top + a.bottom) / 2 > (top + bottom) / 2) {
      bottom = Math.min(bottom, a.top - GAP)
    } else {
      top = Math.max(top, a.bottom + GAP)
    }
  }

  return { x: rect.x, y: top, width: rect.width, height: Math.max(0, bottom - top) }
}
