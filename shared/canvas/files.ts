/* Which files Veritas Canvas opens: its `.comp` projects and the images it can start a project from. */

export const PROJECT_EXTENSION = '.comp'

/** Decoded in the renderer directly. */
export const DIRECT_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif', '.svg', '.ico'])

/** Converted to PNG by the system first (macOS reads all of them; Linux uses the tools it has). */
export const CONVERTED_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['.heic', '.heif', '.tif', '.tiff', '.dng', '.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2'])

/** Photoshop documents, read by Veritas Canvas itself: they open with their layers. */
export const LAYERED_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['.psd', '.psb'])

export const CANVAS_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([...DIRECT_IMAGE_EXTENSIONS, ...CONVERTED_IMAGE_EXTENSIONS, ...LAYERED_IMAGE_EXTENSIONS])

const extension = (file: string): string => {
  const match = /(\.[^./\\]+)$/.exec(file)

  return match ? match[1].toLowerCase() : ''
}

export const isProjectPath = (file: string): boolean => extension(file.replace(/[/\\]+$/, '')) === PROJECT_EXTENSION
export const isCanvasImage = (file: string): boolean => CANVAS_IMAGE_EXTENSIONS.has(extension(file))
export const isLayeredImage = (file: string): boolean => LAYERED_IMAGE_EXTENSIONS.has(extension(file))
export const canOpenInCanvas = (file: string): boolean => isProjectPath(file) || isCanvasImage(file)

/** The `.comp` folder a path lies in (a manifest or an image picked inside one), or null. */
export function projectContaining(file: string): string | null {
  const parts = file.replace(/[/\\]+$/, '').split(/[/\\]/)

  for (let i = parts.length; i > 0; i--) {
    const candidate = parts.slice(0, i).join('/')

    if (extension(candidate) === PROJECT_EXTENSION) {
      return candidate || null
    }
  }

  return null
}

/** A file name without its folder and extension, for titles and suggested names. */
export function baseName(file: string): string {
  const name = file.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? ''

  return name.replace(/\.[^.]+$/, '') || 'Untitled'
}
