/*
 * The things that can be done to a layer's mask, by name. Kept apart from the engine (masks.ts) so
 * the command registry can list them without loading the editor.
 */

export const MASK_ACTIONS = ['reveal', 'hide', 'revealSelection', 'hideSelection', 'invert', 'apply', 'enable', 'disable', 'remove', 'link', 'unlink'] as const
export type MaskAction = (typeof MASK_ACTIONS)[number]

/** What each action is called in the menus and the History. */
export const MASK_LABELS: Record<MaskAction, string> = {
  reveal: 'Reveal All',
  hide: 'Hide All',
  revealSelection: 'Reveal Selection',
  hideSelection: 'Hide Selection',
  invert: 'Invert Mask',
  apply: 'Apply Mask',
  enable: 'Enable Mask',
  disable: 'Disable Mask',
  remove: 'Delete Mask',
  link: 'Link Mask',
  unlink: 'Unlink Mask'
}
