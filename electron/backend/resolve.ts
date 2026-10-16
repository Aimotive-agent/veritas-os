import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BackendRuntime } from '../../shared/ipc.ts'
import { osEnv } from '../env.ts'
import { hermesHome } from '../paths.ts'

const isExecutable = (file: string): boolean => {
  try {
    fs.accessSync(file, fs.constants.X_OK)

    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** A source checkout is usable only if it carries a venv AND the `serve` subcommand. */
function checkoutRuntime(root: string, kind: BackendRuntime['kind'], label: string): BackendRuntime | null {
  const python = path.join(root, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const serveModule = path.join(root, 'hermes_cli', 'subcommands', 'dashboard.py')

  if (!isExecutable(python) || !fs.existsSync(serveModule)) {
    return null
  }

  return { kind, label, root, command: [python, '-m', 'hermes_cli.main'] }
}

function pathRuntime(extraDirs: string[]): BackendRuntime | null {
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), ...extraDirs].filter(Boolean)

  for (const dir of dirs) {
    const candidate = path.join(dir, process.platform === 'win32' ? 'hermes.exe' : 'hermes')

    if (isExecutable(candidate)) {
      return { kind: 'path', label: `hermes on PATH (${candidate})`, command: [candidate] }
    }
  }

  return null
}

/**
 * Ordered ladder. Each rung is validated before it is trusted; a failed read falls to the next.
 *   1. HERALD_OS_HERMES_ROOT (explicit developer override)
 *   2. $HERMES_HOME/hermes-agent managed install (what the official installer and `hermes update` maintain)
 *   3. `hermes` shim on PATH (+ the usual user bin dirs a GUI app does not inherit)
 */
export function resolveBackendRuntime(): BackendRuntime | null {
  const envRoot = osEnv('HERMES_ROOT')?.trim()

  if (envRoot) {
    const runtime = checkoutRuntime(envRoot, 'env', `HERALD_OS_HERMES_ROOT (${envRoot})`)

    if (runtime) {
      return runtime
    }
  }

  const managed = checkoutRuntime(path.join(hermesHome(), 'hermes-agent'), 'managed', 'managed Hermes install')

  if (managed) {
    return managed
  }

  return pathRuntime([path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'])
}
