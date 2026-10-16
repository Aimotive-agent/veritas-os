// Parse the diffs Hermes attaches to file edits (`tool.complete.inline_diff`) into the lines the
// Studio highlights. Hermes sends its transcript rendering: ANSI colours, a "review diff" banner and
// `a/<path> → b/<path>` file headers before ordinary `@@` hunks. Plain unified diffs
// (`--- a/x` / `+++ b/x`, `/dev/null` for a new file) are accepted too.

export interface FileDiff {
  /** Path after the change without the `a/` / `b/` prefix; the old path for a deletion. */
  path: string
  created: boolean
  deleted: boolean
  /** 1-based line numbers in the new file that were added or changed. */
  added: number[]
  removed: number
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,\d+)? @@/
const RENDERED_HEADER = /^a\/(.+?) → b\/(.+)$/
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

function stripPrefix(raw: string): string | null {
  const value = raw.replace(/\t.*$/, '').trim()

  if (value === '/dev/null') {
    return null
  }

  return value.replace(/^[ab]\//, '')
}

export function parseUnifiedDiff(diff: string | null | undefined): FileDiff[] {
  if (!diff) {
    return []
  }

  const files: FileDiff[] = []
  let current: FileDiff | null = null
  let oldPath: string | null = null
  let line = 0

  for (const raw of diff.replace(ANSI, '').split('\n')) {
    const rendered = RENDERED_HEADER.exec(raw.trim())

    if (rendered) {
      current = { path: rendered[2].trim(), created: false, deleted: false, added: [], removed: 0 }
      files.push(current)
      line = 0
      continue
    }

    if (raw.startsWith('--- ')) {
      oldPath = stripPrefix(raw.slice(4))
      current = null
      continue
    }

    if (raw.startsWith('+++ ')) {
      const newPath = stripPrefix(raw.slice(4))
      current = { path: newPath ?? oldPath ?? '', created: oldPath === null, deleted: newPath === null, added: [], removed: 0 }
      files.push(current)
      continue
    }

    const hunk = HUNK.exec(raw)

    if (hunk) {
      line = Number(hunk[3])

      // "@@ -0,0 +1,N @@" is a file that did not exist before.
      if (current && hunk[1] === '0' && hunk[2] === '0') {
        current.created = true
      }

      continue
    }

    if (!current || line === 0) {
      continue
    }

    if (raw.startsWith('+')) {
      current.added.push(line)
      line += 1
    } else if (raw.startsWith('-')) {
      current.removed += 1
    } else if (raw.startsWith(' ') || raw === '') {
      line += 1
    }
  }

  return files
}
