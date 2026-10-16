import { BrowserWindow, ipcMain, net, protocol } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { MODEL_SCHEME, type ModelId, MODELS, type ModelProgress } from '../../shared/canvas/models.ts'
import { IPC } from '../../shared/ipc.ts'
import { log } from '../log.ts'
import { heraldOsDataDir } from '../paths.ts'
import { ModelStore } from './model-store.ts'

const known = (id: unknown): ModelId => {
  if (!MODELS.some((model) => model.id === id)) {
    throw new Error(`There is no model called ${String(id)}`)
  }

  return id as ModelId
}

/** Every window hears how a download goes: any Canvas window may be showing it. */
function broadcast(progress: ModelProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.canvasModelProgress, progress)
    }
  }

  if (progress.outcome) {
    log('canvas', `model ${progress.id}: ${typeof progress.outcome === 'string' ? progress.outcome : progress.outcome.error}`)
  }
}

/**
 * Downloads, lists and removes models for the windows, and serves the verified files on
 * herald-model://<model>/<file> to their workers (which load them straight into the runtime).
 */
export function registerModelIpc(): void {
  const store = new ModelStore(path.join(heraldOsDataDir(), 'models'), (url, init) => net.fetch(url, { ...init, redirect: 'follow' }), broadcast)

  ipcMain.handle(IPC.canvasModels, () => store.status())
  ipcMain.handle(IPC.canvasModelDownload, (_event, id: unknown) => store.download(known(id)))
  ipcMain.handle(IPC.canvasModelCancel, (_event, id: unknown) => store.cancel(known(id)))
  ipcMain.handle(IPC.canvasModelRemove, (_event, id: unknown) => store.remove(known(id)))

  protocol.handle(MODEL_SCHEME, async (request) => {
    const cors = { 'access-control-allow-origin': '*' }

    try {
      const url = new URL(request.url)
      const file = await store.verifiedFile(known(url.hostname), decodeURIComponent(url.pathname.slice(1)))
      const response = await net.fetch(pathToFileURL(file).toString())

      return new Response(response.body, { headers: { ...cors, 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } })
    } catch (error) {
      return new Response(error instanceof Error ? error.message : String(error), { status: 404, headers: { ...cors, 'content-type': 'text/plain' } })
    }
  })
}
