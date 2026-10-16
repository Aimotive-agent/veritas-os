import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

/*
 * Images Chromium cannot decode (HEIC, TIFF, camera RAW) become a PNG through whatever the system
 * has: `sips` on the Mac (ImageIO reads all of them), and on Linux libheif, darktable, ImageMagick
 * or libvips, tried in turn. Photoshop documents are read by Veritas Canvas itself, and only come
 * here when one is wanted as a single picture.
 */

const run = promisify(execFile)

const RAW = new Set(['.dng', '.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2'])
const HEIF = new Set(['.heic', '.heif'])

/** Converter commands to try, in order, for a file (pure; tested). */
export function converters(file: string, out: string, platform: NodeJS.Platform = process.platform): string[][] {
  if (platform === 'darwin') {
    return [['sips', '-s', 'format', 'png', file, '--out', out]]
  }

  const extension = path.extname(file).toLowerCase()
  const commands: string[][] = []

  if (HEIF.has(extension)) {
    // libheif's decoder: heif-dec now, heif-convert in older releases.
    commands.push(['heif-dec', file, out], ['heif-convert', file, out])
  }

  if (RAW.has(extension)) {
    commands.push(['darktable-cli', file, out])
  }

  // `[0]` takes the first frame or page: the flattened image of a PSD or a multi-page TIFF.
  commands.push(['magick', `${file}[0]`, out], ['convert', `${file}[0]`, out], ['vips', 'copy', file, out])

  return commands
}

/**
 * What a Linux system needs for a kind of file, with the package names Fedora and Debian use (pure;
 * tested). `output` is what the converters said: a HEIC photo compressed with HEVC (an iPhone's)
 * needs a decoder Fedora does not ship.
 */
export function converterHint(file: string, output = ''): string {
  const extension = path.extname(file).toLowerCase()

  if (HEIF.has(extension) && /HEVC|libde265/i.test(output)) {
    return 'install libheif-freeworld from RPM Fusion on Fedora, or libheif-plugin-libde265 on Debian and Ubuntu'
  }

  if (HEIF.has(extension)) {
    return 'install libheif’s tools (libheif-tools on Fedora, libheif-examples on Debian and Ubuntu) or ImageMagick'
  }

  if (RAW.has(extension)) {
    return 'install darktable, or ImageMagick with RAW support (ImageMagick on Fedora, imagemagick on Debian and Ubuntu)'
  }

  return 'install ImageMagick (ImageMagick on Fedora, imagemagick on Debian and Ubuntu) or libvips (vips-tools on Fedora, libvips-tools on Debian and Ubuntu)'
}

export async function convertToPng(file: string): Promise<Uint8Array> {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'herald-canvas-'))
  const out = path.join(folder, 'image.png')
  let tried = 0
  let said = ''

  try {
    for (const [command, ...args] of converters(file, out)) {
      try {
        await run(command, args, { timeout: 180_000 })
        const bytes = await fs.readFile(out)

        if (bytes.length) {
          return new Uint8Array(bytes)
        }
      } catch (error) {
        // Not installed, or it could not read this file: try the next one.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          tried++
          said += String((error as { stderr?: unknown }).stderr ?? '')
        }
      }
    }

    const kind = path.extname(file).slice(1).toUpperCase() || 'these'

    if (process.platform !== 'linux') {
      throw new Error(`This computer could not open the ${kind} file`)
    }

    if (HEIF.has(path.extname(file).toLowerCase()) && /HEVC|libde265/i.test(said)) {
      throw new Error(`This HEIC photo is compressed with HEVC, which libheif here cannot decode: ${converterHint(file, said)}`)
    }

    throw new Error(tried ? `The converters on this computer could not read this ${kind} file; it may be damaged, or need a newer one (${converterHint(file)})` : `Nothing on this computer opens ${kind} files yet: ${converterHint(file)}`)
  } finally {
    await fs.rm(folder, { recursive: true, force: true })
  }
}
