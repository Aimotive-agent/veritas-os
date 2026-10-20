import { exec } from 'node:child_process'
import { clipboard } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { hostPlatform } from '../platform/index.ts'

/*
 * The Veritas agent's everyday toolkit: files, the shell, processes, the clipboard and a durable
 * notes file. It already has OpenCode's own shell/file tools; these make the same capabilities
 * explicit, bounded and easy for the model to reach for.
 */

const execAsync = promisify(exec)

const MAX_OUTPUT = 8000
const MAX_FILE_BYTES = 512 * 1024
const SHELL_TIMEOUT_MS = 60_000

export interface CeoTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run: (args: Record<string, unknown>) => Promise<string>
}

const stringArg = (args: Record<string, unknown>, key: string): string => (typeof args[key] === 'string' ? (args[key] as string).trim() : '')

/** Expand ~ and make the path absolute. */
function resolvePath(input: string): string {
  const expanded = input.startsWith('~') ? path.join(os.homedir(), input.slice(1)) : input

  return path.resolve(expanded)
}

function notesPath(): string {
  return path.join(os.homedir(), '.config', 'veritas-os', 'notes.md')
}

function clip(text: string, limit = MAX_OUTPUT): string {
  const value = text.trim()

  if (!value) {
    return '(no output)'
  }

  return value.length > limit ? `${value.slice(0, limit)}\n… (truncated)` : value
}

export function createCeoTools(deps: { openUrl: (url: string) => void } = { openUrl: () => undefined }): CeoTool[] {
  return [
    {
      name: 'run_shell',
      description: 'Run a shell command on this computer and return its output.',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      run: async args => {
        const command = stringArg(args, 'command')

        if (!command) {
          return 'Error: command is required.'
        }

        try {
          const { stdout, stderr } = await execAsync(command, { timeout: SHELL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, cwd: os.homedir() })

          return clip([stdout, stderr].filter(Boolean).join('\n'))
        } catch (error) {
          return clip(`Error: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    },
    {
      name: 'read_file',
      description: 'Read a text file (paths may start with ~).',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      run: async args => {
        const target = stringArg(args, 'path')

        if (!target) {
          return 'Error: path is required.'
        }

        try {
          const stat = await fsp.stat(resolvePath(target))

          if (!stat.isFile()) {
            return `Error: ${target} is not a file.`
          }

          if (stat.size > MAX_FILE_BYTES) {
            return `Error: ${target} is ${Math.round(stat.size / 1024)} KB; too large to read at once.`
          }

          return clip(await fsp.readFile(resolvePath(target), 'utf8'))
        } catch (error) {
          return clip(`Error: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    },
    {
      name: 'write_file',
      description: 'Write text to a file, creating parent folders as needed (paths may start with ~).',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content']
      },
      run: async args => {
        const target = stringArg(args, 'path')
        const content = typeof args.content === 'string' ? args.content : ''

        if (!target) {
          return 'Error: path is required.'
        }

        try {
          const full = resolvePath(target)
          await fsp.mkdir(path.dirname(full), { recursive: true })
          await fsp.writeFile(full, content, 'utf8')
          return `Wrote ${content.length} characters to ${full}.`
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : String(error)}`
        }
      }
    },
    {
      name: 'list_files',
      description: 'List the files and folders in a directory (paths may start with ~).',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      run: async args => {
        const target = stringArg(args, 'path') || '~'

        try {
          const entries = await fsp.readdir(resolvePath(target), { withFileTypes: true })
          const rows = entries
            .slice(0, 300)
            .map(entry => `${entry.isDirectory() ? 'd' : '-'} ${entry.name}`)

          return rows.length ? rows.join('\n') : '(empty directory)'
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : String(error)}`
        }
      }
    },
    {
      name: 'search_files',
      description: 'Find files by name under a folder (paths may start with ~).',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, path: { type: 'string' } },
        required: ['query']
      },
      run: async args => {
        const query = stringArg(args, 'query').toLowerCase()
        const root = resolvePath(stringArg(args, 'path') || '~')

        if (!query) {
          return 'Error: query is required.'
        }

        const found: string[] = []
        const skip = new Set(['node_modules', '.git', '.cache', '.venv', 'venv', '__pycache__', '.next', 'dist', 'target'])

        const walk = async (dir: string, depth: number): Promise<void> => {
          if (found.length >= 40 || depth > 5) {
            return
          }

          let entries: fs.Dirent[] = []

          try {
            entries = await fsp.readdir(dir, { withFileTypes: true })
          } catch {
            return
          }

          for (const entry of entries) {
            if (found.length >= 40) {
              return
            }

            if (entry.name.startsWith('.') && entry.name !== '.config') {
              continue
            }

            if (skip.has(entry.name)) {
              continue
            }

            const full = path.join(dir, entry.name)

            if (entry.isDirectory()) {
              await walk(full, depth + 1)
            } else if (entry.name.toLowerCase().includes(query)) {
              found.push(full)
            }
          }
        }

        try {
          await walk(root, 0)

          return found.length ? found.join('\n') : `No file matching "${query}" under ${root}.`
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : String(error)}`
        }
      }
    },
    {
      name: 'list_processes',
      description: 'List the running processes, busiest first (by cpu or memory).',
      inputSchema: { type: 'object', properties: { sort: { type: 'string', enum: ['cpu', 'memory'] } } },
      run: async args => {
        const sort = stringArg(args, 'sort') === 'memory' ? 'memory' : 'cpu'

        try {
          const rows = await hostPlatform().listProcesses(sort, 15)

          return rows.map(row => `${row.pid}\t${row.name}\tcpu ${row.cpuPercent.toFixed(1)}%\tmem ${row.memPercent.toFixed(1)}%`).join('\n') || '(no processes)'
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : String(error)}`
        }
      }
    },
    {
      name: 'kill_process',
      description: 'Terminate a running process by pid.',
      inputSchema: { type: 'object', properties: { pid: { type: 'number' } }, required: ['pid'] },
      run: async args => {
        const pid = Number(args.pid)

        if (!Number.isInteger(pid) || pid <= 0) {
          return 'Error: pid must be a positive integer.'
        }

        try {
          process.kill(pid, 'SIGTERM')
          return `Sent SIGTERM to ${pid}.`
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : String(error)}`
        }
      }
    },
    {
      name: 'clipboard_get',
      description: 'Read the current clipboard contents.',
      inputSchema: { type: 'object', properties: {} },
      run: async () => clip(clipboard.readText() || '(clipboard is empty)')
    },
    {
      name: 'clipboard_set',
      description: 'Put text on the clipboard.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      run: async args => {
        const text = typeof args.text === 'string' ? args.text : ''

        if (!text) {
          return 'Error: text is required.'
        }

        clipboard.writeText(text)
        return 'Copied to the clipboard.'
      }
    },
    {
      name: 'remember',
      description: 'Save a note to your durable notes, so you can recall it later (see recall).',
      inputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
      run: async args => {
        const note = (typeof args.note === 'string' ? args.note : '').trim()

        if (!note) {
          return 'Error: note is required.'
        }

        try {
          const file = notesPath()
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.appendFileSync(file, `- ${new Date().toISOString()} ${note}\n`, 'utf8')
          return 'Noted.'
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : String(error)}`
        }
      }
    },
    {
      name: 'recall',
      description: 'Read back your saved notes.',
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        try {
          const file = notesPath()

          if (!fs.existsSync(file)) {
            return '(no notes yet)'
          }

          return clip(await fsp.readFile(file, 'utf8'))
        } catch (error) {
          return `Error: ${error instanceof Error ? error.message : String(error)}`
        }
      }
    },
    {
      name: 'open_url',
      description: 'Open a web page in the browser.',
      inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      run: async args => {
        const url = stringArg(args, 'url')

        if (!/^https?:\/\//i.test(url)) {
          return 'Error: url must start with http:// or https://'
        }

        deps.openUrl(url)
        return `Opened ${url}.`
      }
    }
  ]
}
