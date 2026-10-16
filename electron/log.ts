import fs from 'node:fs'
import path from 'node:path'
import { hermesHome } from './paths.ts'

const MAX_TAIL = 400
const tail: string[] = []
let stream: fs.WriteStream | null = null

function ensureStream(): fs.WriteStream | null {
  if (stream) {
    return stream
  }

  try {
    const dir = path.join(hermesHome(), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    stream = fs.createWriteStream(path.join(dir, 'herald-os.log'), { flags: 'a' })
  } catch {
    stream = null
  }

  return stream
}

export function log(scope: string, message: string): void {
  const line = `${new Date().toISOString()} [${scope}] ${message}`
  tail.push(line)

  if (tail.length > MAX_TAIL) {
    tail.splice(0, tail.length - MAX_TAIL)
  }

  console.log(line)
  ensureStream()?.write(line + '\n')
}

export function logTail(lines = 120): string[] {
  return tail.slice(-lines)
}
