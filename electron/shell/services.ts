import { execFile, spawn } from 'node:child_process'
import { ipcMain } from 'electron'
import { type ClipboardEntry, type HeraldOsResult, IPC, type PowerAction } from '../../shared/ipc.ts'
import { log } from '../log.ts'

const POWER_COMMANDS: Record<PowerAction, string[]> = {
  suspend: ['systemctl', 'suspend'],
  reboot: ['systemctl', 'reboot'],
  poweroff: ['systemctl', 'poweroff'],
  logout: ['niri', 'msg', 'action', 'quit', '--skip-confirmation'],
  lock: ['herald-os', 'lock']
}

function run(command: string, args: string[], input?: string, timeout = 60_000): Promise<HeraldOsResult> {
  return new Promise(resolve => {
    const child = execFile(command, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? ((error as NodeJS.ErrnoException & { code?: number | string }).code === 'ENOENT' ? 127 : (child.exitCode ?? 1)) : 0
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? (error?.message ?? '')) })
    })

    if (input !== undefined) {
      child.stdin?.end(input)
    }
  })
}

/** System services every surface can reach: the CLI, power actions, clipboard history. Linux only. */
export function registerServiceIpc(): void {
  ipcMain.handle(IPC.shellHeraldOs, async (_event, args: string[]): Promise<HeraldOsResult> => {
    if (process.platform !== 'linux') {
      return { code: 127, stdout: '', stderr: 'herald-os CLI is only available on Veritas OS Linux' }
    }

    if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) {
      throw new Error('herald-os arguments must be strings')
    }

    // Long installs may exceed a minute; give package managers room.
    const timeout = args[0] === 'install' || args[0] === 'remove' || args[0] === 'update' ? 20 * 60_000 : 60_000
    const result = await run('herald-os', args, undefined, timeout)
    log('services', `herald-os ${args.join(' ')} -> ${result.code}`)

    return result
  })

  ipcMain.handle(IPC.shellPower, async (_event, action: PowerAction) => {
    const command = POWER_COMMANDS[action]

    if (!command) {
      throw new Error(`unknown power action ${String(action)}`)
    }

    log('services', `power ${action}`)
    const child = spawn(command[0], command.slice(1), { detached: true, stdio: 'ignore' })
    child.on('error', error => log('services', `${command[0]} failed: ${error.message}`))
    child.unref()
  })

  ipcMain.handle(IPC.clipboardHistory, async (_event, limit = 50): Promise<ClipboardEntry[]> => {
    const result = await run('cliphist', ['list'], undefined, 5000)

    if (result.code !== 0) {
      return []
    }

    return result.stdout
      .split('\n')
      .filter(Boolean)
      .slice(0, Math.max(1, Math.min(200, limit)))
      .map(line => {
        const tab = line.indexOf('\t')

        return tab > 0 ? { id: line.slice(0, tab), preview: line.slice(tab + 1) } : { id: line, preview: line }
      })
  })

  ipcMain.handle(IPC.clipboardPaste, async (_event, id: string) => {
    if (!/^\d+$/.test(String(id))) {
      throw new Error('clipboard entry ids are numeric')
    }

    // cliphist decode expects the id (or the full list line) on stdin and prints the raw content.
    const decoded = await new Promise<Buffer>((resolve, reject) => {
      const child = execFile('cliphist', ['decode'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
        if (error) {
          reject(error)
        } else {
          resolve(stdout as unknown as Buffer)
        }
      })
      child.stdin?.end(`${id}\n`)
    })

    await new Promise<void>((resolve, reject) => {
      const copy = spawn('wl-copy', [], { stdio: ['pipe', 'ignore', 'ignore'] })
      copy.on('error', reject)
      copy.on('exit', () => resolve())
      copy.stdin.end(decoded)
    })
  })
}
