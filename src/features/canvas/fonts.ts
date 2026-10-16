/*
 * The fonts on this computer, for the Type tool and for reading font names. Chromium's Local Font
 * Access API lists every face with its real PostScript name (main grants Veritas's own pages the
 * permission), so a text layer names exactly the face it uses, as Compositor and Photoshop expect.
 * Without it, the families come from the system's font list and names are put together.
 */

import { atom } from 'nanostores'
import { registerFaces } from './engine/text.ts'

interface LocalFont {
  postscriptName: string
  fullName: string
  family: string
  style: string
}

type FontQuery = () => Promise<LocalFont[]>

/** Font families on this computer, sorted; null until listed. */
export const $fontFamilies = atom<string[] | null>(null)

let loading: Promise<string[]> | null = null

/** List the fonts once (later calls share the first): families for the font field, faces for exact names. */
export function loadFonts(): Promise<string[]> {
  loading ??= (async () => {
    const query = (globalThis as { queryLocalFonts?: FontQuery }).queryLocalFonts
    let families: string[] = []

    try {
      const fonts = query ? await query() : []

      if (fonts.length) {
        registerFaces(fonts)
        families = [...new Set(fonts.map((font) => font.family))]
      }
    } catch {
      // Not allowed or not there: the system's list below.
    }

    if (!families.length) {
      families = await window.heraldOS.fonts.list().catch(() => [] as string[])
    }

    families.sort((a, b) => a.localeCompare(b))
    $fontFamilies.set(families)

    return families
  })()

  return loading
}
