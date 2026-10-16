import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { osEnv } from './env.ts'

/** Profile-aware Hermes home; mirrors upstream `get_hermes_home()` for the default profile. */
export function hermesHome(): string {
  const override = process.env.HERMES_HOME?.trim()

  if (override) {
    return override
  }

  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'hermes')
  }

  return path.join(os.homedir(), '.hermes')
}

export function heraldOsDataDir(): string {
  return path.join(hermesHome(), 'herald-os')
}

export const isDev = process.env.HERALD_OS_BUILD_MODE === 'development' || Boolean(osEnv('DEV_SERVER'))

export function devServerUrl(): string | undefined {
  return osEnv('DEV_SERVER')
}

/** The built renderer page. Every electron/ module is bundled into dist/electron/main.mjs. */
export function rendererIndex(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'renderer', 'index.html')
}

/**
 * Whether `url` is the shell's own page: the dev server's origin, or the bundled renderer. Shell
 * windows carry the preload bridge, so they must load nothing else (a dropped HTML file or a stray
 * link would otherwise get it), and only the shell may use the microphone.
 */
export function isShellPage(url: string, index = rendererIndex(), dev: string | undefined = devServerUrl()): boolean {
  try {
    const target = new URL(url)

    if (dev) {
      return target.origin === new URL(dev).origin
    }

    return target.protocol === 'file:' && target.pathname === pathToFileURL(index).pathname
  } catch {
    return false
  }
}
