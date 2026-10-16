import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isExcluded } from '../../shared/continuity.ts'
import type { ContextSnapshot, ProjectActivity, RecentFile } from '../../shared/ipc.ts'
import { run } from '../platform/exec.ts'
import { hostPlatform } from '../platform/index.ts'

/*
 * The raw material for "Pick up where you left off": documents used or changed lately, project
 * folders with recent activity (git state when they are repositories) and the apps running now.
 * Metadata only; file contents, window titles and the screen are never read.
 */

const DAY = 86_400_000
const FILE_WINDOW = 3 * DAY
const PROJECT_WINDOW = 7 * DAY
const MAX_FILES = 24
const MAX_PROJECTS = 8
const MAX_APPS = 12
/** Project folders inspected per snapshot, newest first, so a huge ~/Projects stays cheap. */
const MAX_CANDIDATES = 60
const NOISE_SEGMENTS = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.next', '__pycache__', 'venv', '.venv'])
const PROJECT_ROOTS = ['Projects', 'Apps', 'Developer', 'Code', 'code', 'src', 'dev', 'repos', 'GitHub', 'Documents/GitHub']

export interface SnapshotOptions {
  exclude: readonly string[]
  /** Files the user removed from Recents. */
  hidden: readonly string[]
  projectsRoot?: string
  now?: number
}

export async function takeSnapshot(options: SnapshotOptions): Promise<ContextSnapshot> {
  const now = options.now ?? Date.now()
  const home = os.homedir()
  const hidden = new Set(options.hidden)
  const skip = (target: string) => hidden.has(target) || isExcluded(target, options.exclude, home) || isNoise(target, home)
  const [files, projects, apps] = await Promise.all([
    recentWork(home, now, skip),
    projectActivity(home, now, options.projectsRoot, skip),
    runningApps(name => isExcluded(name, options.exclude, home))
  ])

  return { takenAt: now, files, projects, apps }
}

function isNoise(target: string, home: string): boolean {
  const relative = target.startsWith(`${home}/`) ? target.slice(home.length + 1) : target

  return relative.split('/').some(segment => segment.startsWith('.') || NOISE_SEGMENTS.has(segment))
}

const touched = (file: RecentFile) => Math.max(file.lastUsedAt, file.modifiedAt)

/** Documents opened lately (the system's recents) plus anything new on the Desktop or in Downloads. */
async function recentWork(home: string, now: number, skip: (target: string) => boolean): Promise<RecentFile[]> {
  const [used, ...dropped] = await Promise.all([
    hostPlatform()
      .recentFiles(80)
      .catch(() => [] as RecentFile[]),
    ...['Desktop', 'Downloads'].map(dir => changedIn(path.join(home, dir), now - FILE_WINDOW))
  ])

  return mergeRecent([...used, ...dropped.flat()], now - FILE_WINDOW)
    .filter(file => !skip(file.path))
    .slice(0, MAX_FILES)
}

/** Newest first, one row per path, only rows touched since `since`. */
export function mergeRecent(rows: readonly RecentFile[], since: number): RecentFile[] {
  const byPath = new Map<string, RecentFile>()

  for (const row of rows) {
    const seen = byPath.get(row.path)
    byPath.set(row.path, seen ? { ...seen, lastUsedAt: Math.max(seen.lastUsedAt, row.lastUsedAt), modifiedAt: Math.max(seen.modifiedAt, row.modifiedAt) } : row)
  }

  return [...byPath.values()].filter(row => touched(row) >= since).sort((a, b) => touched(b) - touched(a))
}

async function changedIn(dir: string, since: number): Promise<RecentFile[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[])
  const rows: RecentFile[] = []

  await Promise.all(
    entries
      .filter(entry => !entry.name.startsWith('.'))
      .slice(0, 300)
      .map(async entry => {
        const full = path.join(dir, entry.name)
        const stat = await fs.stat(full).catch(() => null)

        if (stat && stat.mtimeMs >= since) {
          rows.push({ path: full, name: entry.name, extension: path.extname(entry.name).toLowerCase(), size: stat.size, modifiedAt: stat.mtimeMs, lastUsedAt: 0, kind: stat.isDirectory() ? 'directory' : 'file' })
        }
      })
  )

  return rows
}

/** Folders under the usual project roots with a commit, an uncommitted change or a new file this week. */
async function projectActivity(home: string, now: number, projectsRoot: string | undefined, skip: (target: string) => boolean): Promise<ProjectActivity[]> {
  const roots = [...new Set([projectsRoot, ...PROJECT_ROOTS.map(dir => path.join(home, dir))].filter((dir): dir is string => Boolean(dir)))]
  const candidates: { path: string; mtime: number }[] = []

  for (const root of roots) {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [] as Dirent[])

    await Promise.all(
      entries
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(async entry => {
          const full = path.join(root, entry.name)
          const stat = await fs.stat(full).catch(() => null)

          if (stat && !skip(full)) {
            candidates.push({ path: full, mtime: stat.mtimeMs })
          }
        })
    )
  }

  const unique = [...new Map(candidates.map(c => [c.path, c])).values()].sort((a, b) => b.mtime - a.mtime).slice(0, MAX_CANDIDATES)
  const rows: ProjectActivity[] = []

  await pool(unique, 6, async candidate => {
    const row = await inspectProject(candidate.path, candidate.mtime)

    if (row && row.touchedAt >= now - PROJECT_WINDOW) {
      rows.push(row)
    }
  })

  return rows.sort((a, b) => b.touchedAt - a.touchedAt).slice(0, MAX_PROJECTS)
}

async function inspectProject(dir: string, dirMtime: number): Promise<ProjectActivity | null> {
  const name = path.basename(dir)
  const isRepo = await fs
    .stat(path.join(dir, '.git'))
    .then(() => true)
    .catch(() => false)

  if (!isRepo) {
    return { path: dir, name, changed: 0, changedFiles: [], commits: [], touchedAt: Math.max(dirMtime, await newestMtime(dir, null)) }
  }

  // --no-optional-locks: looking must not rewrite the index (and make every repo look busy).
  const [status, log] = await Promise.all([
    run('git', ['--no-optional-locks', '-C', dir, 'status', '--porcelain=v1', '--branch'], 5000),
    run('git', ['-C', dir, 'log', '-3', '--format=%ct%x09%s'], 5000)
  ])

  if (status.code !== 0) {
    return null
  }

  const parsed = parseGitStatus(status.stdout)
  const commits = log.code === 0 ? parseGitLog(log.stdout) : []
  const changedAt = await newestMtime(dir, parsed.changed.slice(0, 40))

  return {
    path: dir,
    name,
    branch: parsed.branch,
    changed: parsed.changed.length,
    changedFiles: parsed.changed.slice(0, 6),
    commits,
    touchedAt: Math.max(dirMtime, commits[0]?.at ?? 0, changedAt)
  }
}

/** Commits from `git log --format=%ct%x09%s`, newest first. */
export function parseGitLog(stdout: string): { subject: string; at: number }[] {
  return stdout
    .split('\n')
    .map(line => {
      const [seconds, ...subject] = line.split('\t')

      return { subject: subject.join('\t').trim().slice(0, 140), at: Number(seconds) * 1000 }
    })
    .filter(commit => commit.at > 0 && commit.subject)
}

/** Newest mtime among `names` inside `dir` (its top-level entries when null). */
async function newestMtime(dir: string, names: string[] | null): Promise<number> {
  const list = names ?? (await fs.readdir(dir).catch(() => [] as string[])).filter(n => !n.startsWith('.')).slice(0, 60)
  const times = await Promise.all(list.map(n => fs.stat(path.join(dir, n)).then(s => s.mtimeMs, () => 0)))

  return Math.max(0, ...times)
}

/** Branch and changed paths from `git status --porcelain=v1 --branch`. */
export function parseGitStatus(stdout: string): { branch?: string; changed: string[] } {
  let branch: string | undefined
  const changed: string[] = []

  for (const line of stdout.split('\n')) {
    if (line.startsWith('## ')) {
      const head = line.slice(3)
      const fresh = /^No commits yet on (.+)$/.exec(head)
      const name = fresh ? fresh[1] : head.split('...')[0].split(' ')[0]
      branch = name && name !== 'HEAD' ? name : undefined
    } else if (line.length > 3) {
      // Renames read `R  old -> new`; the new path is the one on disk.
      changed.push(line.slice(3).split(' -> ').pop()!.replace(/^"|"$/g, ''))
    }
  }

  return { branch, changed }
}

/** GUI apps running now (macOS bundles; other systems report none). */
async function runningApps(skip: (name: string) => boolean): Promise<string[]> {
  const result = await run('ps', ['-axo', 'comm='], 4000)
  const names = new Set<string>()

  for (const line of result.stdout.split('\n')) {
    const name = appNameFromCommand(line.trim())

    if (name && !skip(name)) {
      names.add(name)
    }
  }

  return [...names].slice(0, MAX_APPS)
}

const NOT_AN_APP = /helper|agent|daemon|service|extension|updater|crashpad|renderer|webcontent/i
const SELF = new Set(['Electron', 'Veritas OS'])

/** `/Applications/Keynote.app/Contents/MacOS/Keynote` -> `Keynote`; helpers and system services -> null. */
export function appNameFromCommand(command: string): string | null {
  if (!command.includes('.app/Contents/MacOS/') || command.includes('/Library/') || command.includes('/Contents/Frameworks/')) {
    return null
  }

  const bundle = command.slice(0, command.lastIndexOf('.app/Contents/MacOS/'))
  const name = bundle.slice(bundle.lastIndexOf('/') + 1)

  return name && !NOT_AN_APP.test(name) && !SELF.has(name) ? name : null
}

async function pool<T>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      await fn(items[index++])
    }
  })
  await Promise.all(workers)
}
