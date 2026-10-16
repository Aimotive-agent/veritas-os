/*
 * Photoshop documents off the window's thread: reading one (its structure first, checked against
 * Veritas Canvas's limits, then each layer's pixels in turn) and mapping it to layers, or writing
 * one from layers the window prepared. One request a worker; the window ends it afterwards.
 */

import { decodeLayerPixels, getCompositeImageData, initializeCanvas, type Layer, readPsd, writePsdUint8Array } from 'ag-psd'
import { LIMITS } from '../../../../shared/canvas/comp-format.ts'
import { fromPsd, type ImportedPsd, type PsdSource, toPsd } from './psd-map.ts'

export type PsdRequest = { read: ArrayBuffer } | { write: PsdSource }

export type PsdReply = { ok: true; read: ImportedPsd } | { ok: true; written: Uint8Array; notes: string[] } | { ok: false; error: string }

interface WorkerScope {
  postMessage(message: PsdReply, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent<PsdRequest>) => void) | null
}

const scope = globalThis as unknown as WorkerScope

// ag-psd makes its pixel buffers through a canvas by default, and a worker has no document: plain buffers do.
initializeCanvas(
  (width, height) => new OffscreenCanvas(width, height) as unknown as HTMLCanvasElement,
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: 'srgb' }) as ImageData
)

const COLOUR_MODES: Record<number, string> = { 0: 'bitmap', 2: 'indexed', 7: 'multichannel', 8: 'duotone', 9: 'Lab' }

function read(buffer: ArrayBuffer): ImportedPsd {
  const psd = readPsd(buffer, { useRawData: true, useRawThumbnail: true, skipThumbnail: true, skipLinkedFilesData: true })

  if (psd.colorMode !== undefined && COLOUR_MODES[psd.colorMode]) {
    throw new Error(`This document uses ${COLOUR_MODES[psd.colorMode]} colour, which Veritas Canvas does not open: convert it to RGB first`)
  }

  if (psd.width > LIMITS.side || psd.height > LIMITS.side || psd.width * psd.height > LIMITS.sourcePixels) {
    throw new Error(`This document is ${psd.width.toLocaleString('en')}×${psd.height.toLocaleString('en')}; Veritas Canvas opens up to ${LIMITS.side.toLocaleString('en')} pixels a side, ${(LIMITS.sourcePixels / 1e6).toLocaleString('en')} million in all`)
  }

  let count = 0
  const decode = (layers: Layer[] | undefined) => {
    for (const layer of layers ?? []) {
      if (++count > LIMITS.layers) {
        throw new Error(`This document has more than ${LIMITS.layers.toLocaleString('en')} layers, more than Veritas Canvas holds`)
      }

      const width = Math.max(0, (layer.right ?? 0) - (layer.left ?? 0))
      const height = Math.max(0, (layer.bottom ?? 0) - (layer.top ?? 0))

      // A layer too large to hold keeps no pixels (the mapping notes it), rather than exhausting memory.
      if (width * height <= LIMITS.sourcePixels) {
        decodeLayerPixels(layer, true)
      }

      decode(layer.children)
    }
  }
  decode(psd.children)

  if (!psd.children?.length) {
    psd.imageData = getCompositeImageData(psd)
  }

  return fromPsd(psd)
}

scope.onmessage = (event) => {
  try {
    if ('read' in event.data) {
      const result = read(event.data.read)
      const transfer = result.layers.flatMap((layer) => [layer.pixels?.data.buffer, layer.mask?.data.buffer]).filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer)
      scope.postMessage({ ok: true, read: result }, [...new Set(transfer)])
    } else {
      const { psd, notes } = toPsd(event.data.write)
      // Past Photoshop's 30,000 pixels a side (a layer's edges included) only the large format will do.
      const reach = (layers: Layer[] | undefined): number => Math.max(0, ...(layers ?? []).map((layer) => Math.max(Math.abs(layer.left ?? 0), Math.abs(layer.top ?? 0), layer.right ?? 0, layer.bottom ?? 0, reach(layer.children))))
      const large = Math.max(psd.width, psd.height, reach(psd.children)) > 30_000
      const written = writePsdUint8Array(psd, { psb: large, noBackground: true })
      scope.postMessage({ ok: true, written, notes }, [written.buffer as ArrayBuffer])
    }
  } catch (error) {
    scope.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}
