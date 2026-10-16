/*
 * Work a tool leaves open (a Free Transform, a crop box, text being typed): settled before a menu
 * command or another document takes over. Undo drops it (and does nothing more); anything else
 * puts it in first.
 */

import type { CanvasDocument } from '../engine/document.ts'
import { $selectMask, cancelSelectMask } from '../select-mask.ts'
import { $crop, cancelCrop } from './crop.ts'
import { cancelTransform, commitTransform, sessionFor } from './transform.ts'
import { $typing, cancelTyping, commitTyping } from './type.ts'

/** True when a tool holds open work on the document (a Free Transform, text being typed, a crop box, Select and Mask). */
export const hasOpenWork = (doc: CanvasDocument | null): boolean => Boolean((doc && sessionFor(doc)) || $typing.get() || $crop.get() || $selectMask.get())

export function settleTools(doc: CanvasDocument | null, how: 'commit' | 'cancel' = 'commit'): void {
  // Select and Mask is a workspace of its own: another command closes it, as Cancel would.
  if ($selectMask.get()) {
    cancelSelectMask()
  }

  if (doc && sessionFor(doc)) {
    if (how === 'cancel') {
      cancelTransform(doc)
    } else {
      commitTransform(doc)
    }
  }

  if ($typing.get()) {
    if (how === 'cancel') {
      cancelTyping()
    } else {
      void commitTyping(doc)
    }
  }

  if ($crop.get()) {
    cancelCrop()
  }
}
