import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc.ts'
import { type MenuExtensions, parseMenuExtensions } from '../../shared/menu-extensions.ts'
import { log } from '../log.ts'

/*
 * The person's control-menu entries (~/.config/herald-os/menu.json). The menu shows them; main
 * starts their programs, and only ever the program the file names for the entry it is asked about.
 */

export const menuFile = (): string => path.join(os.homedir(), '.config', 'herald-os', 'menu.json')

export function readMenuExtensions(): MenuExtensions {
  let text: string

  try {
    text = fs.readFileSync(menuFile(), 'utf8')
  } catch {
    return { entries: [], errors: [] }
  }

  try {
    return parseMenuExtensions(JSON.parse(text))
  } catch (error) {
    return { entries: [], errors: [`menu.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] }
  }
}

const expandHome = (arg: string) => (arg === '~' ? os.homedir() : arg.startsWith('~/') ? path.join(os.homedir(), arg.slice(2)) : arg)

/** Start an entry's program, detached from the shell; resolves once it started. */
export function runMenuExtension(id: string): Promise<void> {
  const entry = readMenuExtensions().entries.find(item => item.id === id)

  if (!entry || entry.action.kind !== 'exec') {
    return Promise.reject(new Error('That entry is no longer in menu.json'))
  }

  const [program, ...args] = entry.action.argv.map(expandHome)
  log('menu', `${entry.label}: ${program} ${args.join(' ')}`)

  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: os.homedir(), detached: true, stdio: 'ignore' })
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
    child.once('error', error => reject(new Error(`${program}: ${error.message}`)))
  })
}

export function registerMenuExtensionsIpc(): void {
  ipcMain.handle(IPC.menuExtensions, () => readMenuExtensions())
  ipcMain.handle(IPC.menuExtensionRun, (_event, id: string) => runMenuExtension(String(id)))
}
