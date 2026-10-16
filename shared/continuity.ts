/*
 * Exclusions for "Pick up where you left off", shared by main (paths) and the renderer (chat
 * titles, calendar events). An entry is either a folder (absolute or `~/` path) or a word.
 */

const normalise = (text: string) => text.toLowerCase().replace(/[\s._-]+/g, ' ').trim()

function isFolderEntry(entry: string): boolean {
  return entry.startsWith('/') || entry === '~' || entry.startsWith('~/')
}

function expand(entry: string, home: string): string {
  const full = entry === '~' || entry.startsWith('~/') ? home + entry.slice(1) : entry

  return full.replace(/\/+$/, '') || '/'
}

/**
 * True when `text` (a path, a title, an app name) falls under one of the exclusions. A folder hides
 * everything inside it, and its name hides titles that mention it; a word hides anything that
 * contains it, ignoring case and `-`, `_`, `.` separators.
 */
export function isExcluded(text: string, exclude: readonly string[], home: string): boolean {
  if (!text) {
    return false
  }

  const haystack = normalise(text)

  for (const raw of exclude) {
    const entry = raw.trim()

    if (!entry) {
      continue
    }

    if (isFolderEntry(entry)) {
      const folder = expand(entry, home)

      if (text === folder || text.startsWith(`${folder}/`)) {
        return true
      }

      // Short names ("src", "tmp") would hide far too much prose.
      const name = normalise(folder.split('/').pop() ?? '')

      if (name.length >= 4 && !text.startsWith('/') && haystack.includes(name)) {
        return true
      }

      continue
    }

    const word = normalise(entry)

    if (word && haystack.includes(word)) {
      return true
    }
  }

  return false
}
