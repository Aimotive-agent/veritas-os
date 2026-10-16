/*
 * Layer effects as records: their names, the order the panel lists them in, and changes to one
 * effect at a time. A missing record means the layer lacks that effect; a hidden one keeps its
 * settings. Effects this version does not know (written by another app) are kept as they were.
 */

import { EFFECT_KINDS, type EffectKind, type LayerEffects } from '../../../../shared/canvas/comp-format.ts'
import type { CanvasLayer } from './document.ts'

export const EFFECT_NAMES: Record<EffectKind, string> = {
  stroke: 'Stroke',
  shadow: 'Drop Shadow',
  colorOverlay: 'Colour Overlay',
  innerShadow: 'Inner Shadow',
  outerGlow: 'Outer Glow',
  innerGlow: 'Inner Glow'
}

/** Top to bottom as they stack on the layer: the order the Properties panel lists them in. */
export const EFFECT_ORDER: EffectKind[] = ['stroke', 'innerShadow', 'innerGlow', 'colorOverlay', 'outerGlow', 'shadow']

/** Which layers can carry effects: anything with pixels of its own (not folders or adjustments). */
export const takesEffects = (layer: CanvasLayer | undefined): boolean => Boolean(layer && !layer.isGroup && !layer.adjustment)

/** The effects a layer has, hidden or not. */
export const effectKinds = (effects: LayerEffects | undefined): EffectKind[] => EFFECT_KINDS.filter((kind) => effects?.[kind])

/** One effect set (or removed, with undefined); undefined back when nothing is left. */
export function withEffect<K extends EffectKind>(effects: LayerEffects | undefined, kind: K, record: LayerEffects[K] | undefined): LayerEffects | undefined {
  const next: LayerEffects = { ...effects }

  if (record) {
    next[kind] = record
  } else {
    delete next[kind]
  }

  return Object.keys(next).length ? next : undefined
}

/** Every effect shown or hidden at once, keeping their settings. */
export function withAllShown(effects: LayerEffects | undefined, shown: boolean): LayerEffects | undefined {
  let next = effects

  for (const kind of effectKinds(effects)) {
    const record = effects![kind] as { enabled?: boolean }
    next = withEffect(next, kind, { ...record, enabled: shown } as LayerEffects[typeof kind])
  }

  return next
}

/** Without the effects this version knows; what other apps wrote stays. */
export function withoutKnownEffects(effects: LayerEffects | undefined): LayerEffects | undefined {
  let next = effects

  for (const kind of EFFECT_KINDS) {
    next = withEffect(next, kind, undefined)
  }

  return next
}

/** The effects this version knows, copied out of a layer's (for Copy Layer Style); undefined when it has none. */
export function knownEffects(effects: LayerEffects | undefined): LayerEffects | undefined {
  const kinds = effectKinds(effects)

  return kinds.length ? Object.fromEntries(kinds.map((kind) => [kind, { ...effects![kind] }])) : undefined
}

/** A layer's effects replaced by copied ones (Paste Layer Style); what other apps wrote on the layer stays. */
export function withEffectsFrom(effects: LayerEffects | undefined, copied: LayerEffects | undefined): LayerEffects | undefined {
  let next = withoutKnownEffects(effects)

  for (const kind of effectKinds(copied)) {
    next = withEffect(next, kind, { ...copied![kind] } as LayerEffects[typeof kind])
  }

  return next
}
