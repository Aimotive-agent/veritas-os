/*
 * Veritas Canvas's model runner: ONNX Runtime in a worker, on the GPU through WebGPU when the
 * system has it and on the CPU (WebAssembly) otherwise. Model files come from the main process
 * over herald-model:, which serves only files that match their published digests.
 */

import * as ort from 'onnxruntime-web/webgpu'
import wasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'
import { modelFileUrl, type ModelId, modelInfo } from '../../../../shared/canvas/models.ts'
import type { MlReply, MlRequest } from './ml-protocol.ts'
import { fitSide, type MaskOptions, maskFromLogits, maskFromProbability, maskOptions, modelInput, normalise } from './segment-math.ts'

/** The parts of a worker's global scope this uses (the window's type library describes a page). */
interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent<MlRequest>) => void) | null
  crossOriginIsolated: boolean
  location: { href: string }
  navigator: { hardwareConcurrency?: number; gpu?: { requestAdapter(): Promise<unknown> } }
}

const scope = globalThis as unknown as WorkerScope

ort.env.wasm.wasmPaths = { wasm: new URL(wasm, scope.location.href).href }
// Threads need cross-origin isolation, which the shell's pages do not have.
ort.env.wasm.numThreads = scope.crossOriginIsolated ? Math.min(4, scope.navigator.hardwareConcurrency || 1) : 1
ort.env.logLevel = 'error'

type Backend = 'webgpu' | 'wasm'

const sessions = new Map<string, { session: ort.InferenceSession; backend: Backend }>()
let gpu: boolean | null = null

async function hasGpu(): Promise<boolean> {
  if (gpu === null) {
    try {
      gpu = Boolean(await scope.navigator.gpu?.requestAdapter())
    } catch {
      gpu = false
    }
  }

  return gpu
}

async function session(model: ModelId, file: string, backend?: Backend): Promise<{ session: ort.InferenceSession; backend: Backend }> {
  const key = `${model}/${file}`
  const known = sessions.get(key)

  if (known && (!backend || known.backend === backend)) {
    return known
  }

  await known?.session.release()
  const chosen: Backend = backend ?? ((await hasGpu()) ? 'webgpu' : 'wasm')
  const response = await fetch(modelFileUrl(model, file))

  if (!response.ok) {
    throw new Error(await response.text())
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  const created = { session: await ort.InferenceSession.create(bytes, { executionProviders: [chosen] }), backend: chosen }
  sessions.set(key, created)

  return created
}

/** Run a model, on the GPU when it can be; a GPU failure is retried once on the CPU. */
async function run(model: ModelId, file: string, feeds: Record<string, ort.Tensor>): Promise<{ outputs: ort.InferenceSession.OnnxValueMapType; backend: Backend }> {
  let current = await session(model, file)

  try {
    return { outputs: await current.session.run(feeds), backend: current.backend }
  } catch (error) {
    if (current.backend !== 'webgpu') {
      throw error
    }

    current = await session(model, file, 'wasm')

    return { outputs: await current.session.run(feeds), backend: current.backend }
  }
}

async function values(tensor: ort.Tensor): Promise<Float32Array> {
  return (tensor.location === 'gpu-buffer' ? await tensor.getData() : tensor.data) as Float32Array
}

// --- The salient-object model (Remove Background, Select Subject) ------------------------------

const SALIENT_SIDE = 1024

/** The picture and the model's answer for it, kept while the person tries thresholds. */
const salient = new Map<string, { rgba: Uint8ClampedArray; width: number; height: number; probability: Float32Array }>()

async function segment(token: string, rgba: Uint8ClampedArray, width: number, height: number): Promise<Backend> {
  const file = modelInfo('isnet').files[0].name
  const input = modelInput(rgba, width, height, SALIENT_SIDE, SALIENT_SIDE, [0.5, 0.5, 0.5], [1, 1, 1])
  const { outputs, backend } = await run('isnet', file, { input_image: new ort.Tensor('float32', input, [1, 3, SALIENT_SIDE, SALIENT_SIDE]) })
  const probability = normalise(await values(outputs.output_image as ort.Tensor))
  salient.clear()
  salient.set(token, { rgba, width, height, probability })

  return backend
}

function salientMask(token: string, width: number, height: number, options: MaskOptions): Uint8Array {
  const entry = salient.get(token)

  if (!entry) {
    throw new Error('Run the model on the picture first')
  }

  let { rgba } = entry

  // A smaller mask (a preview) is refined against a smaller picture.
  if (width !== entry.width || height !== entry.height) {
    rgba = shrinkRgba(entry.rgba, entry.width, entry.height, width, height)
  }

  return maskFromProbability(entry.probability, SALIENT_SIDE, SALIENT_SIDE, rgba, width, height, options)
}

function shrinkRgba(rgba: Uint8ClampedArray, width: number, height: number, outWidth: number, outHeight: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(outWidth * outHeight * 4)

  for (let y = 0; y < outHeight; y++) {
    const sy = Math.min(height - 1, Math.floor(((y + 0.5) * height) / outHeight))

    for (let x = 0; x < outWidth; x++) {
      const sx = Math.min(width - 1, Math.floor(((x + 0.5) * width) / outWidth))
      out.set(rgba.subarray((sy * width + sx) * 4, (sy * width + sx) * 4 + 4), (y * outWidth + x) * 4)
    }
  }

  return out
}

// --- Segment anything (Object Select) ----------------------------------------------------------

const SAM_SIDE = 1024
const embeddings = new Map<string, { embedding: ort.Tensor; width: number; height: number }>()

async function encode(key: string, rgba: Uint8ClampedArray, width: number, height: number): Promise<{ width: number; height: number; backend: Backend }> {
  const size = fitSide(width, height, SAM_SIDE)
  const input = modelInput(rgba, width, height, size.width, size.height)
  const file = modelInfo('efficientsam').files[0].name
  const { outputs, backend } = await run('efficientsam', file, { batched_images: new ort.Tensor('float32', input, [1, 3, size.height, size.width]) })
  const embedding = outputs.image_embeddings as ort.Tensor
  const kept = embedding.location === 'gpu-buffer' ? new ort.Tensor('float32', await values(embedding), embedding.dims) : embedding

  // Two pictures at most: the layer in hand and the one before it.
  if (embeddings.size >= 2) {
    embeddings.delete(embeddings.keys().next().value!)
  }

  embeddings.set(key, { embedding: kept, width: size.width, height: size.height })

  return { width: size.width, height: size.height, backend }
}

/** Points are in the encoded picture's pixels; labels 1 (part of it), 0 (not part of it), 2 and 3 (a box's corners). */
async function decode(key: string, points: [number, number][], labels: number[], width: number, height: number): Promise<Uint8Array> {
  const entry = embeddings.get(key)

  if (!entry) {
    throw new Error('Analyse the picture first')
  }

  const file = modelInfo('efficientsam').files[1].name
  const { outputs } = await run('efficientsam', file, {
    image_embeddings: entry.embedding,
    batched_point_coords: new ort.Tensor('float32', Float32Array.from(points.flat()), [1, 1, points.length, 2]),
    batched_point_labels: new ort.Tensor('float32', Float32Array.from(labels), [1, 1, labels.length]),
    orig_im_size: new ort.Tensor('int64', BigInt64Array.from([BigInt(entry.height), BigInt(entry.width)]), [2])
  })
  const iou = await values(outputs.iou_predictions as ort.Tensor)
  const masks = await values(outputs.output_masks as ort.Tensor)
  const best = iou.indexOf(Math.max(...iou))
  const plane = entry.width * entry.height

  return maskFromLogits(masks.subarray(best * plane, (best + 1) * plane), entry.width, entry.height, width, height)
}

// --- Messages ----------------------------------------------------------------------------------

async function handle(request: MlRequest): Promise<{ reply: Omit<MlReply, 'id'>; transfer: Transferable[] }> {
  switch (request.op) {
    case 'segment': {
      const backend = await segment(request.token, request.rgba, request.width, request.height)

      return { reply: { ok: true, backend }, transfer: [] }
    }
    case 'salientMask': {
      const mask = salientMask(request.token, request.width, request.height, maskOptions(request.options))

      return { reply: { ok: true, mask }, transfer: [mask.buffer] }
    }
    case 'encode': {
      const encoded = await encode(request.key, request.rgba, request.width, request.height)

      return { reply: { ok: true, ...encoded }, transfer: [] }
    }
    case 'decode': {
      const mask = await decode(request.key, request.points, request.labels, request.width, request.height)

      return { reply: { ok: true, mask }, transfer: [mask.buffer] }
    }
    case 'forget':
      salient.delete(request.token)

      return { reply: { ok: true }, transfer: [] }
  }
}

/** One request at a time: the runtime creates one GPU session at a time, and runs are queued anyway. */
let queue: Promise<unknown> = Promise.resolve()

scope.onmessage = (event) => {
  const request = event.data

  queue = queue.then(() =>
    handle(request).then(
      ({ reply, transfer }) => scope.postMessage({ ...reply, id: request.id }, transfer),
      (error: unknown) => scope.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies MlReply)
    )
  )
}
