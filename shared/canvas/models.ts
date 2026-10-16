/*
 * The on-device models Veritas Canvas can use. None ships with the app: each is downloaded from
 * where its publisher put it the first time the person allows it, checked against the size and
 * SHA-256 recorded here, and only then run. Only permissively licensed weights are listed.
 */

export type ModelId = 'isnet' | 'efficientsam'

export const PERMISSIVE_LICENCES = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause'] as const

export type Licence = (typeof PERMISSIVE_LICENCES)[number]

export interface ModelFile {
  name: string
  url: string
  bytes: number
  sha256: string
}

export interface ModelInfo {
  id: ModelId
  name: string
  /** What it does, to follow "which" in the download question. */
  purpose: string
  licence: Licence
  /** Where the model and its licence are published. */
  source: string
  /** Who made the files the app downloads, when not the model's authors. */
  converted?: string
  files: ModelFile[]
}

export const MODELS: readonly ModelInfo[] = [
  {
    id: 'isnet',
    name: 'ISNet (general use)',
    purpose: 'finds the main subject of a picture (for Remove Background and Select Subject)',
    licence: 'Apache-2.0',
    source: 'https://github.com/xuebinqin/DIS',
    converted: 'ONNX conversion of the authors’ isnet-general-use weights, published by the rembg project (https://github.com/danielgatis/rembg)',
    files: [
      {
        name: 'isnet-general-use.onnx',
        url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx',
        bytes: 178_648_008,
        sha256: '60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a'
      }
    ]
  },
  {
    id: 'efficientsam',
    name: 'EfficientSAM (tiny)',
    purpose: 'picks out the object you click or draw a box around (for Object Select)',
    licence: 'Apache-2.0',
    source: 'https://github.com/yformer/EfficientSAM',
    files: [
      {
        name: 'efficient_sam_vitt_encoder.onnx',
        url: 'https://raw.githubusercontent.com/yformer/EfficientSAM/d525f622e6f640acf5a0fc37c7ca1f243da5bde0/weights/efficient_sam_vitt_encoder.onnx',
        bytes: 24_799_761,
        sha256: '84ed466ffcc5c1f8d08409bc34a23bb364ab2c15e402cb12d4335a42be0e0951'
      },
      {
        name: 'efficient_sam_vitt_decoder.onnx',
        url: 'https://raw.githubusercontent.com/yformer/EfficientSAM/d525f622e6f640acf5a0fc37c7ca1f243da5bde0/weights/efficient_sam_vitt_decoder.onnx',
        bytes: 16_565_728,
        sha256: 'a62f8fa5ea080447c0689418d69e58f1e83e0b7adf9c142e2bd9bcc8045c0b11'
      }
    ]
  }
]

export function modelInfo(id: string): ModelInfo {
  const model = MODELS.find((entry) => entry.id === id)

  if (!model) {
    throw new Error(`There is no model called ${id}`)
  }

  return model
}

export const modelBytes = (model: ModelInfo): number => model.files.reduce((sum, file) => sum + file.bytes, 0)

/** The scheme the main process serves verified model files on, to the window's workers. */
export const MODEL_SCHEME = 'herald-model'

export const modelFileUrl = (id: ModelId, file: string): string => `${MODEL_SCHEME}://${id}/${encodeURIComponent(file)}`

/** "179 MB": a download's size the way the question shows it. */
export function sizeLabel(bytes: number): string {
  if (bytes >= 1e9) {
    return `${(bytes / 1e9).toFixed(1)} GB`
  }

  return bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`
}

export type ModelState = 'missing' | 'downloading' | 'ready'

/** A model as the main process knows it: downloaded or not, and how much of it is on disk. */
export interface ModelStatus {
  id: ModelId
  state: ModelState
  /** Bytes of it on disk. */
  bytes: number
  /** While downloading: bytes so far and in all. */
  received?: number
  total?: number
}

/** A download's news, sent to every window as it goes. */
export interface ModelProgress {
  id: ModelId
  received: number
  total: number
  /** Set once it ends: done, cancelled, or the reason it failed. */
  outcome?: 'done' | 'cancelled' | { error: string }
}
