/*
 * The window's side of the model worker: one worker for the window, started on first use, and a
 * promise for each request. Pixels are copied in (layers share theirs with the undo history) and
 * masks come back as transferred buffers.
 */

import type { Raster } from '../engine/raster.ts'
import type { MlReply, MlRequest } from './ml-protocol.ts'
import type { MaskOptions } from './segment-math.ts'

type Request = MlRequest extends infer R ? (R extends MlRequest ? Omit<R, 'id'> : never) : never

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, { resolve: (reply: MlReply) => void; reject: (error: Error) => void }>()

function start(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./ml-worker.ts', import.meta.url), { type: 'module', name: 'herald-canvas-models' })
    worker.onmessage = (event: MessageEvent<MlReply>) => {
      const reply = event.data
      const waiting = pending.get(reply.id)
      pending.delete(reply.id)

      if (reply.ok) {
        waiting?.resolve(reply)
      } else {
        waiting?.reject(new Error(reply.error ?? 'The model could not run'))
      }
    }
    worker.onerror = (event) => {
      event.preventDefault()
      const error = new Error(event.message || 'The model worker stopped')
      pending.forEach((waiting) => waiting.reject(error))
      pending.clear()
      worker?.terminate()
      worker = null
    }
  }

  return worker
}

function call(request: Request, transfer: Transferable[] = []): Promise<MlReply> {
  const id = nextId++

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    start().postMessage({ ...request, id }, transfer)
  })
}

/** A copy of a layer's pixels the worker may keep. */
const copyOf = (raster: Raster): Uint8ClampedArray => raster.data.slice()

/** Run the salient-object model on pixels; later masks for them (`salientMask`) refer to `token`. */
export async function segment(token: string, pixels: Raster): Promise<'webgpu' | 'wasm'> {
  const rgba = copyOf(pixels)
  const reply = await call({ op: 'segment', token, rgba, width: pixels.width, height: pixels.height }, [rgba.buffer])

  return reply.backend ?? 'wasm'
}

/** The subject's mask at a size (the pixels' own, or smaller for a preview). */
export async function salientMask(token: string, width: number, height: number, options: Partial<MaskOptions>): Promise<Uint8Array> {
  return (await call({ op: 'salientMask', token, width, height, options })).mask!
}

export const forget = (token: string): void => void call({ op: 'forget', token }).catch(() => {})

/** Encode a picture for Object Select; answers with the size it was encoded at (points are given in it). */
export async function encode(key: string, rgba: Uint8ClampedArray, width: number, height: number): Promise<{ width: number; height: number; backend: 'webgpu' | 'wasm' }> {
  const reply = await call({ op: 'encode', key, rgba, width, height }, [rgba.buffer])

  return { width: reply.width!, height: reply.height!, backend: reply.backend ?? 'wasm' }
}

/** The object at some points (and a box's corners) of an encoded picture, as a mask `width`×`height`. */
export async function decode(key: string, points: [number, number][], labels: number[], width: number, height: number): Promise<Uint8Array> {
  return (await call({ op: 'decode', key, points, labels, width, height })).mask!
}
