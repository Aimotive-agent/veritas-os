/*
 * Branding: a logo and a name for About, and a lock-screen picture (Veritas OS Linux). Kept in
 * ~/.config/herald-os/branding/ by main, which copies the images there; pure and tested.
 */

export interface BrandingView {
  /** Shown under the logo in About ("Acme Corp"). */
  name: string | null
  /** The logo as a data: URL, ready for an <img>. */
  logo: string | null
  /** The lock-screen picture's path (swaylock draws it behind the password ring). */
  lock: string | null
}

export type BrandingKind = 'logo' | 'lock'

export interface BrandingPatch {
  name?: string | null
  /** An image file to copy in; null removes the current one. */
  logo?: string | null
  lock?: string | null
}

export const MAX_BRANDING_BYTES = 8 * 1024 * 1024

const EXTENSIONS: Record<BrandingKind, readonly string[]> = {
  logo: ['.png', '.jpg', '.jpeg', '.webp', '.svg'],
  // swaylock reads PNG and JPEG.
  lock: ['.png', '.jpg', '.jpeg']
}

export const BRANDING_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
}

/** A name for About: one line, at most 40 characters; empty means none. */
export function brandingName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  // Control characters and line breaks become spaces.
  const name = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .trim()

  return name || null
}

/** The file name an image is kept under (`logo.png`, `lock.jpg`), or why it cannot be used. */
export function brandingFileName(kind: BrandingKind, source: string): { file: string } | { error: string } {
  const match = /(\.[a-z0-9]+)$/i.exec(source)
  const extension = match ? match[1].toLowerCase() : ''

  if (!EXTENSIONS[kind].includes(extension)) {
    return { error: `The ${kind === 'logo' ? 'logo' : 'lock-screen picture'} must be ${EXTENSIONS[kind].filter(ext => ext !== '.jpeg').join(', ')}` }
  }

  return { file: `${kind}${extension === '.jpeg' ? '.jpg' : extension}` }
}
