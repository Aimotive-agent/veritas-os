import type { RecentFile } from '../../shared/ipc.ts'

/*
 * Ranking for "open hello.pdf": the user names a file the way they remember it, so an exact name
 * beats a prefix, which beats a substring; ties go to what was used or changed most recently, and
 * files in obvious user folders beat caches and build output. Pure; shared by every platform.
 */

const NOISE = /\/(Library|node_modules|\.git|\.cache|\.Trash|dist|build|DerivedData|Pods|\.venv|venv|__pycache__)\//

/** Normalise a spoken or typed file name: "hello dot pdf" -> "hello.pdf", quotes and case dropped. */
export function normaliseFileQuery(query: string): string {
  return query
    .trim()
    .toLowerCase()
    .replace(/^["'“‘]+|["'”’]+$/g, '')
    .replace(/\s+dot\s+/g, '.')
    .replace(/\s+\.\s*/g, '.')
    .trim()
}

export function scoreMatch(query: string, file: Pick<RecentFile, 'name' | 'path'>): number {
  const q = normaliseFileQuery(query)
  const name = file.name.toLowerCase()
  const stem = name.replace(/\.[^.]+$/, '')

  if (!q) {
    return 0
  }

  let score = 0

  if (name === q) {
    score = 100
  } else if (stem === q) {
    score = 90
  } else if (name.startsWith(q)) {
    score = 70
  } else if (name.includes(q)) {
    score = 50
  } else {
    const words = q.split(/[\s._-]+/).filter(Boolean)
    score = words.length > 0 && words.every(w => name.includes(w)) ? 35 : 0
  }

  if (score > 0 && NOISE.test(file.path)) {
    score -= 30
  }

  return score
}

/** Best matches first: score, then last used / modified. Drops non-matches. */
export function rankFiles(query: string, files: RecentFile[], limit: number): RecentFile[] {
  return files
    .map(file => ({ file, score: scoreMatch(query, file) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.file.lastUsedAt - a.file.lastUsedAt || b.file.modifiedAt - a.file.modifiedAt)
    .slice(0, limit)
    .map(entry => entry.file)
}
