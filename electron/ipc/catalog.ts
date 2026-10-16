import { app, ipcMain, shell } from 'electron'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type CatalogGroupView, type CatalogResult, IPC } from '../../shared/ipc.ts'
import { loginShellPath } from '../backend/shell-env.ts'
import { type CatalogEntry, type CatalogGroup, entryView, findEntry, macGroups, parseCliListing, pickMacMethod, readCatalog } from '../catalog/catalog.ts'
import { log } from '../log.ts'
import { run } from '../platform/exec.ts'

const INSTALL_TIMEOUT_MS = 60 * 60_000
const LOCAL_BIN = path.join(os.homedir(), '.local', 'bin')

/** Packaged builds carry the catalog as a resource; dev runs read the repo; Linux installs a copy. */
export function catalogDirs(): string[] {
  return [
    path.join(process.resourcesPath ?? '', 'catalog'),
    path.resolve(app.getAppPath(), '..', '..', 'linux', 'catalog'),
    '/usr/local/share/herald-os-linux/catalog',
    path.resolve(app.getAppPath(), 'resources', 'catalog'),
    '/usr/share/herald-os/catalog'
  ]
}

export function loadCatalog(): CatalogGroup[] {
  return readCatalog(catalogDirs())
}

function tail(text: string, lines = 6): string {
  return text
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(Boolean)
    .slice(-lines)
    .join('\n')
}

// ---- macOS -----------------------------------------------------------------------------------

/** GUI apps on macOS start with a bare PATH; installs use the login shell's, with ~/.local/bin first. */
async function macPath(): Promise<string> {
  return [LOCAL_BIN, await loginShellPath()].join(':')
}

function which(name: string, searchPath: string): string | null {
  for (const dir of searchPath.split(':')) {
    const candidate = path.join(dir, name)

    if (dir && fs.existsSync(candidate)) {
      return candidate
    }
  }

  return null
}

function execWithPath(command: string, args: string[], searchPath: string, timeout = INSTALL_TIMEOUT_MS): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(command, args, { timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PATH: searchPath } }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? Number((error as { code?: unknown }).code) : 1) : 0
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

function macInstalled(entry: CatalogEntry, searchPath: string): boolean {
  if (entry.detect?.some(item => fs.existsSync(item.replace(/^~(?=\/)/, os.homedir())))) {
    return true
  }

  return Boolean(entry.bin?.some(name => which(name, searchPath)))
}

/** Installed by the catalog's macOS method: npm into ~/.local/bin, or something Homebrew lists. */
async function macRemovable(entry: CatalogEntry, searchPath: string, brew: string | null): Promise<boolean> {
  for (const method of entry.install) {
    if (method.kind === 'npm' && entry.bin?.some(name => fs.existsSync(path.join(LOCAL_BIN, name)))) {
      return true
    }

    if (brew && (method.kind === 'brew' || method.kind === 'brew-cask')) {
      const listed = await execWithPath(brew, ['list', ...(method.kind === 'brew-cask' ? ['--cask'] : ['--formula']), '--versions', method.ref], searchPath, 20_000)

      if (listed.code === 0 && listed.stdout.trim()) {
        return true
      }
    }
  }

  return false
}

async function macList(): Promise<CatalogGroupView[]> {
  const searchPath = await macPath()
  const brew = which('brew', searchPath)
  const tools = { npm: Boolean(which('npm', searchPath)), brew: Boolean(brew) }

  return Promise.all(
    macGroups(loadCatalog()).map(async group => ({
      id: group.id,
      label: group.label,
      description: group.description ?? '',
      entries: await Promise.all(
        group.entries.map(async entry => {
          const installed = macInstalled(entry, searchPath)

          return entryView(group, entry, { installed, removable: installed && (await macRemovable(entry, searchPath, brew)), ...pickMacMethod(entry, tools) })
        })
      )
    }))
  )
}

async function macRun(id: string, action: 'install' | 'remove'): Promise<CatalogResult> {
  const found = findEntry(loadCatalog(), id)

  if (!found) {
    return { ok: false, output: `${id} is not in the catalog` }
  }

  const searchPath = await macPath()
  const npm = which('npm', searchPath)
  const brew = which('brew', searchPath)
  const { method, reason } = pickMacMethod(found.entry, { npm: Boolean(npm), brew: Boolean(brew) })

  if (!method) {
    return { ok: false, output: `${found.entry.label} cannot be installed on this Mac: ${reason ?? 'no macOS method'}` }
  }

  if (method.kind === 'link') {
    if (action === 'remove') {
      return { ok: false, output: `${found.entry.label} came from its own site; remove it the way you installed it.` }
    }

    await shell.openExternal(method.ref)

    return { ok: true, output: `Opened ${method.ref}` }
  }

  const argv: [string, string[]] =
    method.kind === 'npm'
      ? [npm as string, [action === 'install' ? 'install' : 'uninstall', '-g', '--prefix', path.dirname(LOCAL_BIN), method.ref]]
      : [brew as string, [action === 'install' ? 'install' : 'uninstall', ...(method.kind === 'brew-cask' ? ['--cask'] : []), method.ref]]
  log('catalog', `${action} ${id}: ${argv[0]} ${argv[1].join(' ')}`)
  const result = await execWithPath(argv[0], argv[1], searchPath)

  // Homebrew's Ollama is a server; start it so "Use with Hermes" finds it.
  if (result.code === 0 && action === 'install' && method.kind === 'brew' && found.entry.hermes === 'ollama') {
    await execWithPath(brew as string, ['services', 'start', method.ref], searchPath, 60_000)
  }

  return { ok: result.code === 0, output: tail(result.code === 0 ? result.stdout || result.stderr : result.stderr || result.stdout) }
}

// ---- Local model servers ----------------------------------------------------------------------

const LOCAL_SERVERS = {
  ollama: { label: 'Ollama', url: 'http://127.0.0.1:11434/api/tags', names: (body: { models?: { name?: string }[] }) => (body.models ?? []).map(model => model.name ?? '') },
  lmstudio: { label: 'LM Studio', url: 'http://127.0.0.1:1234/v1/models', names: (body: { data?: { id?: string }[] }) => (body.data ?? []).map(model => model.id ?? '') }
} as const

async function localModels(kind: 'ollama' | 'lmstudio'): Promise<string[]> {
  const server = LOCAL_SERVERS[kind]
  let response: Response

  try {
    response = await fetch(server.url, { signal: AbortSignal.timeout(4000) })
  } catch {
    throw new Error(kind === 'ollama' ? 'Ollama is not running here. Start it (or install it from the catalog), then try again.' : "LM Studio's server is off. In LM Studio, open Developer and start the server, then try again.")
  }

  if (!response.ok) {
    throw new Error(`${server.label} answered ${response.status}`)
  }

  const names = server.names((await response.json()) as never).filter(Boolean)

  if (names.length === 0) {
    throw new Error(kind === 'ollama' ? 'Ollama has no models yet. Pull one first, e.g. `ollama pull llama3.2` in the Terminal.' : 'LM Studio has no models loaded. Download one in LM Studio first.')
  }

  return names
}

// ---- IPC --------------------------------------------------------------------------------------

export function registerCatalogIpc(): void {
  ipcMain.handle(IPC.catalogList, async (): Promise<CatalogGroupView[]> => {
    if (process.platform !== 'linux') {
      return macList()
    }

    const result = await run('herald-os', ['catalog', 'list', '--json'], 120_000)

    if (result.code !== 0) {
      throw new Error(tail(result.stderr) || `herald-os catalog exited ${result.code}`)
    }

    return parseCliListing(result.stdout)
  })

  for (const [channel, action] of [
    [IPC.catalogInstall, 'install'],
    [IPC.catalogRemove, 'remove']
  ] as const) {
    ipcMain.handle(channel, async (_event, id: string): Promise<CatalogResult> => {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(id))) {
        return { ok: false, output: 'Not a catalog id' }
      }

      if (process.platform !== 'linux') {
        return macRun(id, action)
      }

      const result = await run('herald-os', ['catalog', action, id], INSTALL_TIMEOUT_MS)

      return { ok: result.code === 0, output: tail(result.code === 0 ? result.stdout || result.stderr : result.stderr || result.stdout) }
    })
  }

  ipcMain.handle(IPC.catalogLocalModels, (_event, kind: string) => {
    if (kind !== 'ollama' && kind !== 'lmstudio') {
      throw new Error('Unknown local model server')
    }

    return localModels(kind)
  })
}
