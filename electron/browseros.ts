import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { log } from './log.ts'

/*
 * BrowserOS — the user's daily AI browser (Chromium-based, ships as an AppImage). Veritas OS uses it
 * as the "real" browser: this module finds the running instance through its local server, starts it
 * when needed, and drives it over CDP. The shell's own page gives an inline Chromium view for quick
 * browsing and hands anything bigger to BrowserOS.
 */

const appImagePath = (): string => path.join(os.homedir(), 'Applications/BrowserOS.AppImage')
const configPath = (): string => path.join(os.homedir(), '.config/browser-os/.browseros/config.json')

export interface BrowserOsInfo {
  installed: boolean
  server: boolean
  version?: string
  chromium?: string
  ports: { cdp: number; proxy: number; server: number }
}

function readConfig(): { version?: string; chromium?: string; ports: { cdp: number; proxy: number; server: number } } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as {
      instance?: { browseros_version?: string; chromium_version?: string }
      ports?: { cdp?: number; proxy?: number; server?: number }
    }

    return {
      version: raw.instance?.browseros_version,
      chromium: raw.instance?.chromium_version,
      ports: { cdp: raw.ports?.cdp ?? 9103, proxy: raw.ports?.proxy ?? 9000, server: raw.ports?.server ?? 9200 }
    }
  } catch {
    return null
  }
}

export async function status(): Promise<BrowserOsInfo> {
  const config = readConfig()
  const ports = config?.ports ?? { cdp: 9103, proxy: 9000, server: 9200 }
  const installed = fs.existsSync(appImagePath())
  let server = false

  try {
    const response = await fetch(`http://127.0.0.1:${ports.server}/health`, { signal: AbortSignal.timeout(2500) })
    server = response.ok
  } catch {
    server = false
  }

  return { installed, server, version: config?.version, chromium: config?.chromium, ports }
}

/** Start BrowserOS (detached) when it is not already answering, then wait for its server. */
export async function launch(): Promise<BrowserOsInfo> {
  const current = await status()
  if (current.server) {
    return current
  }
  const app = appImagePath()
  if (!fs.existsSync(app)) {
    throw new Error(`BrowserOS is not installed at ${app}`)
  }
  const child = spawn(app, ['--no-sandbox'], { detached: true, stdio: 'ignore', env: { ...process.env } })
  child.unref()
  log('browser', 'starting BrowserOS')

  const started = Date.now()
  while (Date.now() - started < 25_000) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    const next = await status()
    if (next.server) {
      return next
    }
  }
  return status()
}

/** Open a URL in BrowserOS as a new tab (CDP), starting the browser if needed. */
export async function openUrl(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('only http(s) URLs can open in BrowserOS')
  }
  const info = await launch()
  if (!info.server) {
    throw new Error('BrowserOS server is not reachable')
  }
  const target = `http://127.0.0.1:${info.ports.cdp}/json/new?${encodeURIComponent(url)}`
  for (const method of ['PUT', 'GET']) {
    try {
      const response = await fetch(target, { method, signal: AbortSignal.timeout(4000) })
      if (response.ok) {
        return
      }
    } catch {
      // Try the other verb; Chromium changed this endpoint's method across versions.
    }
  }
  throw new Error('BrowserOS refused to open a new tab')
}

/** The pages BrowserOS currently has open. */
export async function tabs(): Promise<{ id: string; title: string; url: string }[]> {
  const info = await status()
  if (!info.server) {
    return []
  }
  try {
    const response = await fetch(`http://127.0.0.1:${info.ports.cdp}/json/list`, { signal: AbortSignal.timeout(3000) })
    const list = (await response.json()) as { id: string; type: string; title: string; url: string }[]

    return list.filter(entry => entry.type === 'page').map(entry => ({ id: entry.id, title: entry.title, url: entry.url }))
  } catch {
    return []
  }
}
