/* Select and Mask off the window's thread: the matte refined, colours decontaminated, and the view drawn. */

import { decontaminate, refineMatte, type RefineSettings, type RefineView, viewPixels } from './engine/refine-edge.ts'

export interface RefineRequest {
  matte: Float32Array
  /** The picture the edge follows (straight RGBA, the matte's size). */
  picture: Uint8ClampedArray
  width: number
  height: number
  settings: RefineSettings
  painted: Uint8Array | null
  /** Pixels to decontaminate with the refined matte, and by how much (0 to 1). */
  colours?: { rgba: Uint8ClampedArray; amount: number; reach: number }
  view?: RefineView
}

export type RefineReply = { ok: true; matte: Float32Array; colours?: Uint8ClampedArray; view?: Uint8ClampedArray } | { ok: false; error: string }

interface WorkerScope {
  postMessage(message: RefineReply, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent<RefineRequest>) => void) | null
}

const scope = globalThis as unknown as WorkerScope

scope.onmessage = (event) => {
  const { matte, picture, width, height, settings, painted, colours, view } = event.data

  try {
    const refined = refineMatte(matte, picture, width, height, settings, painted)
    const cleaned = colours ? decontaminate(colours.rgba, refined, width, height, colours.amount, colours.reach) : undefined
    const shown = view ? viewPixels(picture, refined, view) : undefined
    const transfer: Transferable[] = [refined.buffer, ...(cleaned ? [cleaned.buffer] : []), ...(shown ? [shown.buffer] : [])]
    scope.postMessage({ ok: true, matte: refined, colours: cleaned, view: shown }, transfer)
  } catch (error) {
    scope.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}
