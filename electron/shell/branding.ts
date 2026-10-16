import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BrowserWindow, ipcMain } from 'electron'
import { BRANDING_MIME, type BrandingKind, type BrandingPatch, type BrandingView, brandingFileName, brandingName, MAX_BRANDING_BYTES } from '../../shared/branding.ts'
import { IPC } from '../../shared/ipc.ts'
import { log } from '../log.ts'

/*
 * Branding (About's logo and name, the Linux lock-screen picture). Main is the only writer: Settings,
 * the commands and `herald-os branding` all come here; `herald-os lock` reads branding.json.
 */

interface Stored {
  name?: string
  logo?: string
  lock?: string
}

export const brandingDir = (): string => path.join(os.homedir(), '.config', 'herald-os', 'branding')
const storeFile = () => path.join(brandingDir(), 'branding.json')
const expandHome = (value: string) => (value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value)

function readStored(): Stored {
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(), 'utf8')) as Record<string, unknown>
    // Only bare file names inside the branding folder count.
    const file = (value: unknown) => (typeof value === 'string' && value === path.basename(value) && value !== '' ? value : undefined)

    return { name: brandingName(raw.name) ?? undefined, logo: file(raw.logo), lock: file(raw.lock) }
  } catch {
    return {}
  }
}

export function brandingView(): BrandingView {
  const stored = readStored()
  const located = (file?: string) => (file && fs.existsSync(path.join(brandingDir(), file)) ? path.join(brandingDir(), file) : null)
  const logoPath = located(stored.logo)
  let logo: string | null = null

  if (logoPath) {
    const type = BRANDING_MIME[path.extname(logoPath).toLowerCase()] ?? 'application/octet-stream'
    logo = `data:${type};base64,${fs.readFileSync(logoPath).toString('base64')}`
  }

  return { name: stored.name ?? null, logo, lock: located(stored.lock) }
}

function replaceImage(stored: Stored, kind: BrandingKind, source: string | null): void {
  const previous = stored[kind]
  let next: string | undefined

  if (source) {
    const resolved = path.resolve(expandHome(source))
    const named = brandingFileName(kind, resolved)

    if ('error' in named) {
      throw new Error(named.error)
    }

    const stat = fs.statSync(resolved, { throwIfNoEntry: false })

    if (!stat?.isFile()) {
      throw new Error(`No image at ${resolved}`)
    }

    if (stat.size > MAX_BRANDING_BYTES) {
      throw new Error(`${path.basename(resolved)} is larger than ${MAX_BRANDING_BYTES / 1024 / 1024} MB`)
    }

    // Copy beside the old one first, so choosing the file that is already there still works.
    const staging = path.join(brandingDir(), `.${named.file}.new`)
    fs.copyFileSync(resolved, staging)
    next = named.file

    if (previous && previous !== next) {
      fs.rmSync(path.join(brandingDir(), previous), { force: true })
    }

    fs.renameSync(staging, path.join(brandingDir(), next))
  } else if (previous) {
    fs.rmSync(path.join(brandingDir(), previous), { force: true })
  }

  if (next) {
    stored[kind] = next
  } else {
    delete stored[kind]
  }
}

/** Apply a change, keep it, tell every window, and return the result. */
export function setBranding(patch: BrandingPatch): BrandingView {
  const stored = readStored()
  fs.mkdirSync(brandingDir(), { recursive: true })

  if ('name' in patch) {
    const name = brandingName(patch.name)

    if (name) {
      stored.name = name
    } else {
      delete stored.name
    }
  }

  for (const kind of ['logo', 'lock'] as const) {
    if (kind in patch) {
      replaceImage(stored, kind, patch[kind] ?? null)
    }
  }

  fs.writeFileSync(storeFile(), `${JSON.stringify(stored, null, 2)}\n`)
  log('branding', `name=${stored.name ?? '-'} logo=${stored.logo ?? '-'} lock=${stored.lock ?? '-'}`)

  const view = brandingView()

  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(IPC.brandingChanged, view)
  }

  return view
}

export function registerBrandingIpc(): void {
  ipcMain.handle(IPC.brandingGet, () => brandingView())
  ipcMain.handle(IPC.brandingSet, (_event, patch: BrandingPatch) => setBranding(patch && typeof patch === 'object' ? patch : {}))
}
