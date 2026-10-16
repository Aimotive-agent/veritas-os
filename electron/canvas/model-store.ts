/*
 * Veritas Canvas's downloaded models, in a folder of the Veritas data directory: one folder per
 * model. A file is streamed to a `.part` file while its SHA-256 is worked out, and takes its real
 * name only when both its size and its digest match the manifest; a file is checked again before
 * it is first served in a session, so nothing unverified ever runs.
 */

import crypto from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { type ModelFile, type ModelId, type ModelInfo, type ModelProgress, MODELS, type ModelStatus } from '../../shared/canvas/models.ts'

export type Fetcher = (url: string, init: { signal: AbortSignal }) => Promise<Response>

interface Download {
  controller: AbortController
  received: number
  total: number
  done: Promise<void>
}

/** How often (in bytes) a download tells the windows how far it got. */
const PROGRESS_STEP = 1 << 20

async function sizeOf(file: string): Promise<number | null> {
  try {
    const stat = await fs.stat(file)

    return stat.isFile() ? stat.size : null
  } catch {
    return null
  }
}

/** A file's SHA-256, read in a stream (models are hundreds of megabytes). */
export async function digestOf(file: string): Promise<string> {
  const hash = crypto.createHash('sha256')

  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer)
  }

  return hash.digest('hex')
}

export class ModelStore {
  private readonly downloads = new Map<ModelId, Download>()
  /** Files checked this session, by path, with the size and time they had then. */
  private readonly checked = new Map<string, string>()

  constructor(
    readonly root: string,
    private readonly fetcher: Fetcher,
    private readonly onProgress: (progress: ModelProgress) => void = () => {},
    private readonly models: readonly ModelInfo[] = MODELS
  ) {}

  private info(id: ModelId): ModelInfo {
    const model = this.models.find((entry) => entry.id === id)

    if (!model) {
      throw new Error(`There is no model called ${id}`)
    }

    return model
  }

  fileOf(id: ModelId, name: string): string {
    if (!this.info(id).files.some((file) => file.name === name)) {
      throw new Error(`${name} is not part of the ${id} model`)
    }

    return path.join(this.root, id, name)
  }

  async status(): Promise<ModelStatus[]> {
    return Promise.all(
      this.models.map(async (model): Promise<ModelStatus> => {
        const sizes = await Promise.all(model.files.map((file) => sizeOf(this.fileOf(model.id, file.name))))
        const bytes = sizes.reduce<number>((sum, size) => sum + (size ?? 0), 0)
        const download = this.downloads.get(model.id)

        if (download) {
          return { id: model.id, state: 'downloading', bytes, received: download.received, total: download.total }
        }

        return { id: model.id, state: model.files.every((file, i) => sizes[i] === file.bytes) ? 'ready' : 'missing', bytes }
      })
    )
  }

  /** Download a model (the files it lacks); a download already under way is joined. */
  download(id: ModelId): Promise<void> {
    const running = this.downloads.get(id)

    if (running) {
      return running.done
    }

    const model = this.info(id)
    const download: Download = { controller: new AbortController(), received: 0, total: model.files.reduce((sum, file) => sum + file.bytes, 0), done: Promise.resolve() }
    this.downloads.set(id, download)
    download.done = this.fetchAll(id, model.files, download).then(
      () => {
        this.downloads.delete(id)
        this.onProgress({ id, received: download.total, total: download.total, outcome: 'done' })
      },
      (error: unknown) => {
        this.downloads.delete(id)
        const cancelled = download.controller.signal.aborted
        this.onProgress({ id, received: download.received, total: download.total, outcome: cancelled ? 'cancelled' : { error: error instanceof Error ? error.message : String(error) } })

        throw cancelled ? new Error('The download was cancelled') : error
      }
    )

    return download.done
  }

  cancel(id: ModelId): void {
    this.downloads.get(id)?.controller.abort()
  }

  async remove(id: ModelId): Promise<void> {
    const running = this.downloads.get(id)

    if (running) {
      running.controller.abort()
      await running.done.catch(() => {})
    }

    const folder = path.join(this.root, this.info(id).id)

    for (const key of [...this.checked.keys()]) {
      if (key.startsWith(folder + path.sep)) {
        this.checked.delete(key)
      }
    }

    await fs.rm(folder, { recursive: true, force: true })
  }

  /** The path of a model file that is on disk and matches its published digest; an error otherwise. */
  async verifiedFile(id: ModelId, name: string): Promise<string> {
    const file = this.fileOf(id, name)
    const expected = this.info(id).files.find((entry) => entry.name === name)!
    let stat: { size: number; mtimeMs: number }

    try {
      stat = await fs.stat(file)
    } catch {
      throw new Error(`The ${this.info(id).name} model is not downloaded`)
    }

    const key = `${stat.size}:${stat.mtimeMs}`

    if (this.checked.get(file) === key) {
      return file
    }

    if (stat.size !== expected.bytes || (await digestOf(file)) !== expected.sha256) {
      throw new Error(`The ${this.info(id).name} model on disk does not match its published checksum: remove it and download it again`)
    }

    this.checked.set(file, key)

    return file
  }

  private async fetchAll(id: ModelId, files: ModelFile[], download: Download): Promise<void> {
    await fs.mkdir(path.join(this.root, id), { recursive: true })

    for (const file of files) {
      const target = this.fileOf(id, file.name)

      // A file kept from an earlier, interrupted download; it is checked again before it runs.
      if ((await sizeOf(target)) === file.bytes) {
        download.received += file.bytes
        continue
      }

      await this.fetchFile(file, target, download)
    }
  }

  private async fetchFile(file: ModelFile, target: string, download: Download): Promise<void> {
    const part = `${target}.part`
    const { signal } = download.controller
    const start = download.received
    const response = await this.fetcher(file.url, { signal })

    if (!response.ok || !response.body) {
      throw new Error(`${new URL(file.url).host} answered ${response.status} for ${file.name}`)
    }

    const hash = crypto.createHash('sha256')
    const out = await fs.open(part, 'w')
    let received = 0
    let reported = 0

    try {
      const reader = response.body.getReader()

      for (;;) {
        const { done, value } = await reader.read()

        if (done) {
          break
        }

        received += value.byteLength

        if (received > file.bytes) {
          await reader.cancel()
          throw new Error(`${file.name} is larger than published; nothing was kept`)
        }

        hash.update(value)
        await out.write(value)
        download.received = start + received

        if (received - reported >= PROGRESS_STEP) {
          reported = received
          this.onProgress({ id: this.idOf(target), received: download.received, total: download.total })
        }
      }
    } catch (error) {
      await out.close()
      await fs.rm(part, { force: true })

      throw signal.aborted ? new Error('The download was cancelled') : error
    }

    await out.close()

    if (received !== file.bytes || hash.digest('hex') !== file.sha256) {
      await fs.rm(part, { force: true })
      throw new Error(`${file.name} did not match its published checksum; nothing was kept`)
    }

    await fs.rename(part, target)
    const stat = await fs.stat(target)
    this.checked.set(target, `${stat.size}:${stat.mtimeMs}`)
  }

  private idOf(target: string): ModelId {
    return path.basename(path.dirname(target)) as ModelId
  }
}
