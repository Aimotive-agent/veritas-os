/* Content-aware fill off the window's thread: one fill a worker, with progress; cancelling ends the worker. */

import { inpaint } from './patchmatch.ts'

export interface InpaintRequest {
  rgba: Uint8ClampedArray
  width: number
  height: number
  hole: Uint8Array
  source?: Uint8Array
  seed?: number
}

export type InpaintReply = { progress: number } | { ok: true; rgba: Uint8ClampedArray } | { ok: false; error: string }

interface WorkerScope {
  postMessage(message: InpaintReply, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent<InpaintRequest>) => void) | null
}

const scope = globalThis as unknown as WorkerScope

scope.onmessage = (event) => {
  const { rgba, width, height, hole, source, seed } = event.data
  let reported = 0

  try {
    const out = inpaint(rgba, width, height, hole, {
      seed,
      source,
      onProgress: (fraction) => {
        if (fraction - reported >= 0.02) {
          reported = fraction
          scope.postMessage({ progress: fraction })
        }
      }
    })
    scope.postMessage({ ok: true, rgba: out }, [out.buffer])
  } catch (error) {
    scope.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}
