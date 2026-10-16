/*
 * Which on-device models this computer has, and getting one: the window asks the person first
 * (name, size, licence), shows the download and lets them cancel it. Commands never download:
 * they say which model is missing so Hermes can ask the person.
 */

import { atom } from 'nanostores'
import { type ModelId, modelBytes, modelInfo, type ModelProgress, MODELS, type ModelStatus, sizeLabel } from '../../../../shared/canvas/models.ts'

export const $models = atom<Partial<Record<ModelId, ModelStatus>>>({})

/** Downloads under way (or just ended), by model. */
export const $downloads = atom<Partial<Record<ModelId, ModelProgress>>>({})

/** The question on screen: may this model be downloaded? */
export interface ModelAsk {
  id: ModelId
  /** What the person was doing, so the question makes sense. */
  why: string
  answer: (ready: boolean) => void
}

export const $modelAsk = atom<ModelAsk | null>(null)

/** Where in the window each model is asked for, for the message a command gives. */
const ASKED_IN: Record<ModelId, string> = {
  isnet: 'Layer > Remove Background',
  efficientsam: 'the Object Select tool (W)'
}

let listening = false

function listen(): void {
  if (listening) {
    return
  }

  listening = true
  window.heraldOS.canvas.models.onProgress((progress) => {
    $downloads.set({ ...$downloads.get(), [progress.id]: progress })

    if (progress.outcome) {
      void refreshModels()
    }
  })
}

export async function refreshModels(): Promise<Partial<Record<ModelId, ModelStatus>>> {
  listen()
  const list = await window.heraldOS.canvas.models.list()
  const next = Object.fromEntries(list.map((status) => [status.id, status])) as Partial<Record<ModelId, ModelStatus>>
  $models.set(next)

  return next
}

export async function modelReady(id: ModelId): Promise<boolean> {
  return (await refreshModels())[id]?.state === 'ready'
}

/** What a command says when the model it needs is not on this computer. */
export function missingModelMessage(id: ModelId, feature: string): string {
  const model = modelInfo(id)

  return `${feature} needs the ${model.name} model (${sizeLabel(modelBytes(model))}, ${model.licence} licence), which is not downloaded yet. Ask the person to allow the download in Veritas Canvas (${ASKED_IN[id]}), then try again; it is never downloaded without them.`
}

/** For commands: an error naming the model when it is missing. */
export async function requireModel(id: ModelId, feature: string): Promise<void> {
  if (!(await modelReady(id))) {
    throw new Error(missingModelMessage(id, feature))
  }
}

/** In the window: true once the model is here, asking the person (and downloading it) first when it is not. */
export async function ensureModel(id: ModelId, why: string): Promise<boolean> {
  if (await modelReady(id)) {
    return true
  }

  // One question at a time; a second request waits on the same answer.
  const open = $modelAsk.get()

  if (open?.id === id) {
    return new Promise((resolve) => {
      const previous = open.answer
      $modelAsk.set({ ...open, answer: (ready) => (previous(ready), resolve(ready)) })
    })
  }

  open?.answer(false)

  return new Promise((resolve) => $modelAsk.set({ id, why, answer: resolve }))
}

/** Start the download the person agreed to; resolves true once it is verified. */
export async function download(id: ModelId): Promise<boolean> {
  listen()
  $downloads.set({ ...$downloads.get(), [id]: { id, received: 0, total: modelBytes(modelInfo(id)) } })

  try {
    await window.heraldOS.canvas.models.download(id)

    return true
  } catch {
    return false
  } finally {
    await refreshModels()
  }
}

export const cancelDownload = (id: ModelId): Promise<void> => window.heraldOS.canvas.models.cancel(id)

export async function removeModel(id: ModelId): Promise<void> {
  await window.heraldOS.canvas.models.remove(id)
  await refreshModels()
}

export { MODELS }
