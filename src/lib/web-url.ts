/** Only http(s) pages may open in a Veritas OS web window (main enforces the same rule). */
export const isWebUrl = (url: string): boolean => /^https?:\/\/\S+$/i.test(url)

export interface WebUrlParts {
  host: string
  /** Path, query and hash; empty for a bare origin. */
  rest: string
  secure: boolean
}

/** What the read-only address bar shows: the host in full colour, the rest quieter, a lock for https. */
export function describeWebUrl(url: string): WebUrlParts | null {
  if (!isWebUrl(url)) {
    return null
  }

  try {
    const parsed = new URL(url)
    const rest = `${parsed.pathname}${parsed.search}${parsed.hash}`

    return { host: parsed.host, rest: rest === '/' ? '' : rest, secure: parsed.protocol === 'https:' }
  } catch {
    return null
  }
}
