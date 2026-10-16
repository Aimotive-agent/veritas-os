/* The Filter menu's filters off the window's thread: one run a worker; cancelling ends the worker. */

import { applyFilter, type FilterSpec, type Pixels } from './engine/filters.ts'

export interface FilterRequest {
  pixels: Pixels
  spec: FilterSpec
  origin: [number, number]
}

export type FilterReply = { ok: true; data: Uint8ClampedArray } | { ok: false; error: string }

interface WorkerScope {
  postMessage(message: FilterReply, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent<FilterRequest>) => void) | null
}

const scope = globalThis as unknown as WorkerScope

scope.onmessage = (event) => {
  const { pixels, spec, origin } = event.data

  try {
    const data = applyFilter(pixels, spec, origin)
    scope.postMessage({ ok: true, data }, [data.buffer])
  } catch (error) {
    scope.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}
