import { WebContentsView } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { log } from './log.ts'

/*
 * The OpenCode web client refuses to show anything until it is connected to a server, and it asks
 * for a *pairing link* — a one-time code that expires in five minutes. The shared service also has
 * a permanent password (`opencode service get password`), so the client can be connected once and
 * stay connected: the app writes that password into the client's own server list before the page
 * loads, and the client then authenticates with HTTP Basic auth forever.
 *
 * The client keeps its servers in localStorage under `opencode.global.dat:server`:
 *   {"list":[{"type":"http","http":{"url":"...","password":"..."}}],"hidden":{},"projects":{},
 *    "lastProject":{},"recentlyClosed":{}}
 * Everything else in that object is left alone: the user's projects and closed sessions survive.
 */

const STORAGE_KEY = 'opencode.global.dat:server'

/** Where the shared service registers itself. The CLI, the desktop app and Veritas OS all read these. */
function registrationFiles(): string[] {
  const roots = [process.env.XDG_STATE_HOME, path.join(os.homedir(), '.local/state'), path.join(os.homedir(), '.config/ai.opencode.desktop')].filter(Boolean) as string[]

  return roots.map(root => path.join(root, 'opencode/service.json'))
}

/** The shared service's registration, when it is running: where it listens and how to authenticate. */
export function opencodeServiceRegistration(): { url: string; password: string } | null {
  for (const file of registrationFiles()) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { url?: string; password?: string }

      if (raw.url && raw.password) {
        return { url: raw.url.replace(/\/+$/, ''), password: raw.password }
      }
    } catch {
      // Not registered here.
    }
  }

  return null
}

/**
 * The service password. The registration carries it, and `~/.config/opencode/service.json` is where
 * it is configured, so the client keeps working after the service restarts with a new registration.
 */
function opencodeServicePassword(): string | null {
  const files = [...registrationFiles(), path.join(os.homedir(), '.config/opencode/service.json')]

  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { password?: string }

      if (raw.password) {
        return raw.password
      }
    } catch {
      // Not here.
    }
  }

  return null
}

/** The client's own upsert: add the server, or refresh the password of one already listed. */
function seedScript(url: string, password: string): string {
  return `(() => {
    const key = ${JSON.stringify(STORAGE_KEY)}
    const seed = { url: ${JSON.stringify(url)}, password: ${JSON.stringify(password)} }
    let current = {}
    try { current = JSON.parse(localStorage.getItem(key) || '{}') } catch {}
    const list = Array.isArray(current.list) ? current.list : []
    const found = list.find(entry => entry && entry.http && entry.http.url === seed.url)
    if (found) { found.http = { ...found.http, password: seed.password } }
    else { list.push({ type: 'http', http: { url: seed.url, password: seed.password } }) }
    localStorage.setItem(key, JSON.stringify({ ...current, list }))
    return true
  })()`
}

const seeded = new Set<string>()

/**
 * Seed the guest partition's storage for the OpenCode client, when `url` is the shared service.
 *
 * The guest is sandboxed with no preload, so the write happens in a throwaway view that shares the
 * partition (and therefore its localStorage) and is closed straight after. Returns null for any
 * other URL, so the caller can load those pages without waiting.
 */
export function opencodeGuestSeed(url: string, preferences: Electron.WebPreferences): Promise<void> | null {
  const registration = opencodeServiceRegistration()

  if (!registration) {
    return null
  }

  let origin: string

  try {
    origin = new URL(url).origin
  } catch {
    return null
  }

  if (origin !== new URL(registration.url).origin) {
    return null
  }

  const password = opencodeServicePassword()

  if (!password) {
    return null
  }

  const partition = preferences.partition ?? 'default'
  const marker = `${partition}::${origin}`

  if (seeded.has(marker)) {
    return null
  }

  seeded.add(marker)

  const serviceUrl = url.replace(/\/+$/, '')

  return (async () => {
    const view = new WebContentsView({ webPreferences: { ...preferences } })

    try {
      await view.webContents.loadURL(serviceUrl)
      await view.webContents.executeJavaScript(seedScript(serviceUrl, password), true)
      log('web', `seeded the OpenCode web client at ${origin} with the shared service password`)
    } catch (error) {
      seeded.delete(marker)
      log('web', `could not seed the OpenCode web client: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (!view.webContents.isDestroyed()) {
        view.webContents.close()
      }
    }
  })()
}
