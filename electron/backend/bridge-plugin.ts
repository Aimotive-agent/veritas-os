import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BackendRuntime } from '../../shared/ipc.ts'
import { log } from '../log.ts'
import { hermesHome, heraldOsDataDir } from '../paths.ts'

/*
 * A packaged Veritas OS carries the herald-os-bridge plugin in its resources. Hermes loads user
 * plugins from ~/.hermes/plugins, and only enabled ones, so before Hermes starts the app links its
 * copy there and turns it and its tools on: what `npm run bootstrap` does for a checkout and
 * `herald-os setup` for the Linux packages. docs/SYSTEM-BRIDGE.md lists every change.
 */

export type PluginEntry = { kind: 'missing' } | { kind: 'link'; target: string; exists: boolean } | { kind: 'folder' }

const TOOL_SEARCH = 'tools.tool_search.enabled'

/** The Tool Search value found before Veritas OS first turned it off; every setup path writes it once. */
const toolSearchRecord = () => path.join(heraldOsDataDir(), 'tool-search-before')

/** What to do with ~/.hermes/plugins/herald-os-bridge, given the app's own copy (pure; tested). */
export function bridgeLinkPlan(entry: PluginEntry, bundled: string): 'create' | 'replace' | 'keep' {
  if (entry.kind === 'missing') {
    return 'create'
  }

  // A folder is the person's own, and a checkout's link (bootstrap, herald-os setup) stays theirs.
  if (entry.kind === 'folder' || path.resolve(entry.target) === path.resolve(bundled)) {
    return 'keep'
  }

  // A link that leads nowhere, or into another copy of the app (moved, updated, run from the DMG).
  const anotherApp = /\.app\/Contents\/Resources\/herald-os-bridge\/?$/.test(entry.target) || entry.target.startsWith('/opt/herald-os/')

  return !entry.exists || anotherApp ? 'replace' : 'keep'
}

function readEntry(link: string): PluginEntry {
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) {
      return { kind: 'folder' }
    }
  } catch {
    return { kind: 'missing' }
  }

  const target = path.resolve(path.dirname(link), fs.readlinkSync(link))

  return { kind: 'link', target, exists: fs.existsSync(target) }
}

interface HermesResult {
  ok: boolean
  stdout: string
  /** stdout and stderr, for the log and the error the shell shows. */
  output: string
}

// `hermes tools enable` reports an unknown toolset as a ✗ line and still exits 0.
const HERMES_ERROR = /^\s*✗/m
const ANSI = /\u001b\[[0-9;]*m/g

function hermes(runtime: BackendRuntime, args: string[]): Promise<HermesResult> {
  const [command, ...head] = runtime.command

  return new Promise(resolve => {
    if (!command) {
      resolve({ ok: false, stdout: '', output: 'no Hermes command' })

      return
    }

    // Generous: the first Hermes command after an update finishes that update (its builds) first.
    const child = execFile(command, [...head, ...args], { cwd: runtime.root ?? undefined, env: { ...process.env, HERMES_HOME: hermesHome(), NO_COLOR: '1' }, timeout: 10 * 60_000 }, (error, stdout, stderr) => {
      const output = `${stdout}\n${stderr}`.replace(ANSI, '').trim() || error?.message || ''
      const ok = !error && !HERMES_ERROR.test(output)

      if (!ok) {
        log('bridge', `hermes ${args.join(' ')} failed: ${output}`)
      }

      resolve({ ok, stdout: String(stdout).replace(ANSI, ''), output })
    })
    // A closed stdin answers Hermes's override prompt "no": the bridge never replaces built-in tools.
    child.stdin?.end()
  })
}

/** Hermes's ✗ lines, else what it printed, without its ⚠ warnings (pure; tested). */
export function failureReason(output: string): string {
  const lines = output
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('⚠'))
  const errors = lines.filter(line => HERMES_ERROR.test(line))

  return (errors.length ? errors : lines).join(' ').slice(0, 300)
}

/** One step, logged with what it changes; the error for the shell when it fails. */
async function step(runtime: BackendRuntime, args: string[], change: string): Promise<string | null> {
  log('bridge', `hermes ${args.join(' ')}: ${change}`)
  const result = await hermes(runtime, args)

  return result.ok ? null : `hermes ${args.join(' ')} failed: ${failureReason(result.output)}`
}

/**
 * Link the bundled plugin and, once, turn it on in Hermes. Returns why Hermes could not be set up,
 * for the shell to show, or null.
 */
function projectResourcesPath(): string {
  const bundled = process.resourcesPath ?? ''
  if (fs.existsSync(path.join(bundled, 'herald-os-bridge', 'plugin.yaml'))) return bundled
  // Unpackaged dev runs keep the plugin beside the repo checkout.
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'resources')
}

export async function ensureBridgePlugin(runtime: BackendRuntime, resources: string = projectResourcesPath()): Promise<string | null> {
  const bundled = path.join(resources, 'herald-os-bridge')

  if (!resources || !fs.existsSync(path.join(bundled, 'plugin.yaml'))) {
    return null
  }

  const link = path.join(hermesHome(), 'plugins', 'herald-os-bridge')
  // Once: enable the plugin and its tools, and keep them directly callable (tool search would hide
  // them behind a lookup). The marker means it worked, so a failed try runs again on the next start
  // and a person who turns the plugin off or removes its link later (setup --undo) is left alone.
  const enabled = path.join(heraldOsDataDir(), 'bridge-enabled')

  try {
    const entry = readEntry(link)
    const plan = bridgeLinkPlan(entry, bundled)

    // A folder of the person's own, a checkout's link, or a link removed after setup: theirs to manage.
    if ((plan === 'keep' && !(entry.kind === 'link' && path.resolve(entry.target) === path.resolve(bundled))) || (plan === 'create' && fs.existsSync(enabled))) {
      return null
    }

    if (plan !== 'keep') {
      fs.mkdirSync(path.dirname(link), { recursive: true })
      fs.rmSync(link, { force: true })
      fs.symlinkSync(bundled, link)
      log('bridge', `${plan === 'create' ? 'linked' : 'relinked'} ${link} -> ${bundled}`)
    }
  } catch (error) {
    const message = `could not link the bridge plugin into ${link}: ${error instanceof Error ? error.message : String(error)}`
    log('bridge', message)

    return message
  }

  if (fs.existsSync(enabled)) {
    return null
  }

  const failed =
    (await step(runtime, ['plugins', 'enable', 'herald-os-bridge'], `adds it to plugins.enabled in ${path.join(hermesHome(), 'config.yaml')}`)) ??
    (await step(runtime, ['tools', 'enable', 'herald_os'], 'saves platform_toolsets.cli with herald_os in it; the tools run only in Veritas OS sessions')) ??
    (await keepToolsDirect(runtime))

  if (failed) {
    return failed
  }

  fs.mkdirSync(path.dirname(enabled), { recursive: true })
  fs.writeFileSync(enabled, `${new Date().toISOString()}\n`)

  return null
}

/** Tool Search off, with the value it had first written down so it can be put back. */
async function keepToolsDirect(runtime: BackendRuntime): Promise<string | null> {
  const current = await hermes(runtime, ['config', 'get', TOOL_SEARCH])
  const before = current.stdout.trim().split('\n').pop()?.trim()

  if (!current.ok || !before) {
    return `hermes config get ${TOOL_SEARCH} failed: ${failureReason(current.output)}`
  }

  if (before === 'off') {
    return null
  }

  const record = toolSearchRecord()

  if (!fs.existsSync(record)) {
    fs.mkdirSync(path.dirname(record), { recursive: true })
    fs.writeFileSync(record, `${before}\n`)
  }

  return step(runtime, ['config', 'set', TOOL_SEARCH, 'off'], `turns Tool Search off for every Hermes session (it was ${before}; saved in ${record})`)
}
