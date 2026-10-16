/*
 * The gradients saved from the gradient editor, kept between sessions in local storage. Entries
 * that do not read back as gradients (edited by hand, say) are left out.
 */

import { atom } from 'nanostores'
import type { ColourStop, Gradient, OpacityStop } from './engine/gradient.ts'

const SAVED_KEY = 'herald-canvas.gradients'
const LIMIT = 60

const isFraction = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
const isChannel = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 255

/** A stored gradient read back, or null when it is not one. */
export function gradientFrom(value: unknown): Gradient | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const { name, colours, opacities } = value as Record<string, unknown>

  if (typeof name !== 'string' || !name.trim() || !Array.isArray(colours) || !Array.isArray(opacities) || colours.length < 2 || opacities.length < 2) {
    return null
  }

  const colourStops = colours.map((entry): ColourStop | null => {
    const { at, mid, colour } = (entry ?? {}) as Record<string, unknown>
    const known = colour === 'foreground' || colour === 'background' || (Array.isArray(colour) && colour.length === 3 && colour.every(isChannel))

    return isFraction(at) && isFraction(mid) && known ? { at, mid, colour: colour as ColourStop['colour'] } : null
  })
  const opacityStops = opacities.map((entry): OpacityStop | null => {
    const { at, mid, opacity } = (entry ?? {}) as Record<string, unknown>

    return isFraction(at) && isFraction(mid) && isFraction(opacity) ? { at, mid, opacity } : null
  })

  if (colourStops.some((entry) => !entry) || opacityStops.some((entry) => !entry)) {
    return null
  }

  return { name: name.trim(), colours: colourStops as ColourStop[], opacities: opacityStops as OpacityStop[] }
}

function stored(): Gradient[] {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(SAVED_KEY) ?? '[]')

    return Array.isArray(parsed) ? parsed.map(gradientFrom).filter((entry): entry is Gradient => Boolean(entry)) : []
  } catch {
    return []
  }
}

export const $savedGradients = atom<Gradient[]>(stored())

function keep(list: Gradient[]): void {
  $savedGradients.set(list)

  try {
    globalThis.localStorage?.setItem(SAVED_KEY, JSON.stringify(list))
  } catch {
    // Storage full or unavailable: the list lasts for this session.
  }
}

/** Save a gradient under its name, replacing one saved with the same name. */
export function saveGradient(gradient: Gradient): void {
  keep([...$savedGradients.get().filter((entry) => entry.name !== gradient.name), gradient].slice(-LIMIT))
}

export const forgetGradient = (name: string): void => keep($savedGradients.get().filter((entry) => entry.name !== name))
