import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'
import type { HeraldOSPrefs } from '../../shared/ipc.ts'
import { HERALD_SKIN, hermesSkinYaml, schemeOf, type ThemeSpec, type ThemeSummary, validateTheme } from '../../shared/theme.ts'
import { log } from '../log.ts'
import { hermesHome } from '../paths.ts'
import { run } from '../platform/exec.ts'

/** Where people's own themes live, on every platform (the Linux theme engine reads it too). */
export function userThemesDir(): string {
  return path.join(os.homedir(), '.config', 'herald-os', 'themes')
}

/** Theme folders shipped with Veritas OS, first match wins (the same order as linux/bin/herald-os-theme). */
function builtinThemeDirs(): string[] {
  const candidates = [
    process.env.HERALD_OS_THEMES,
    // Packaged builds carry linux/themes as a resource; a checkout reads the repository copy.
    process.resourcesPath ? path.join(process.resourcesPath, 'themes') : undefined,
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'resources', 'themes'),
    path.resolve(app.getAppPath(), '..', '..', 'linux', 'themes'),
    path.join(os.homedir(), 'Veritas-OS', 'linux', 'themes'),
    '/usr/local/share/herald-os-linux/themes',
    '/usr/share/herald-os/themes'
  ]

  return [...new Set(candidates.filter((dir): dir is string => Boolean(dir) && isDir(dir as string)))]
}

function isDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function readSpec(file: string): ThemeSpec | null {
  try {
    const spec = JSON.parse(fs.readFileSync(file, 'utf8')) as ThemeSpec

    return validateTheme(spec) === null ? spec : null
  } catch {
    return null
  }
}

interface FoundTheme {
  spec: ThemeSpec
  dir: string
  source: ThemeSummary['source']
}

function scan(): Map<string, FoundTheme> {
  const found = new Map<string, FoundTheme>()
  const user = userThemesDir()

  for (const base of [...builtinThemeDirs(), ...(isDir(user) ? [user] : [])]) {
    let entries: string[] = []

    try {
      entries = fs.readdirSync(base).sort()
    } catch {
      continue
    }

    for (const entry of entries) {
      const dir = path.join(base, entry)
      const spec = found.has(entry) ? null : readSpec(path.join(dir, 'theme.json'))

      if (spec) {
        found.set(entry, { spec: { ...spec, name: entry }, dir, source: base === user ? 'user' : 'builtin' })
      }
    }
  }

  return found
}

export function listThemes(): ThemeSummary[] {
  return [...scan().values()].map(({ spec, source }) => ({
    name: spec.name,
    label: spec.label || spec.name,
    description: spec.description ?? '',
    scheme: schemeOf(spec.colors, spec.shell?.scheme),
    colors: spec.colors,
    source
  }))
}

export function findTheme(name: string): FoundTheme | null {
  const themes = scan()

  return themes.get(name) ?? themes.get(`herald-${name}`) ?? null
}

/** The shell's part of a theme: a hand-tuned preset, or colours the shell derives its palette from. */
export function prefsForTheme(spec: ThemeSpec, dir: string): Partial<HeraldOSPrefs> {
  const wallpaper = !spec.wallpaper || spec.wallpaper === 'default' ? undefined : path.resolve(dir, spec.wallpaper)
  const preset = spec.shell?.theme

  if (preset === 'ocean' || preset === 'graphite') {
    return { themeName: spec.name, theme: preset, accent: spec.shell?.accent ?? 'blue', themeColors: undefined, themeScheme: undefined, wallpaper }
  }

  return { themeName: spec.name, theme: 'ocean', accent: 'blue', themeColors: spec.colors, themeScheme: schemeOf(spec.colors, spec.shell?.scheme), wallpaper }
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif'])
const MAX_IMAGE_BYTES = 25 * 1024 * 1024

/** Save a theme into the user's folder, with its wallpaper image copied beside it. */
export function saveTheme(spec: ThemeSpec, imagePath?: string): string {
  const problem = validateTheme(spec)

  if (problem) {
    throw new Error(problem)
  }

  const existing = scan().get(spec.name)

  if (existing && existing.source === 'builtin') {
    throw new Error(`"${spec.name}" is a built-in theme; choose another name`)
  }

  const dir = path.join(userThemesDir(), spec.name)
  fs.mkdirSync(dir, { recursive: true })
  const next: ThemeSpec = { ...spec }

  if (imagePath) {
    const extension = path.extname(imagePath).toLowerCase()

    if (!IMAGE_EXTENSIONS.has(extension)) {
      throw new Error(`${path.basename(imagePath)} is not a PNG, JPEG, WebP or AVIF image`)
    }

    fs.copyFileSync(imagePath, path.join(dir, `wallpaper${extension}`))
    next.wallpaper = `wallpaper${extension}`
  }

  fs.writeFileSync(path.join(dir, 'theme.json'), `${JSON.stringify(next, null, 2)}\n`)

  return spec.name
}

/**
 * Install themes from a git repository: the repository's own theme.json, or one per top-level
 * folder. Only colours and images are kept; scripts, configs and anything else in the repository
 * never reach the theme folder, so a theme cannot run code.
 */
export async function installTheme(url: string): Promise<string[]> {
  if (!/^https:\/\/[\w.-]+\/[\w./-]+$/i.test(url.trim())) {
    throw new Error('Give the https address of a git repository')
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'herald-theme-'))

  try {
    const clone = await run('git', ['clone', '--depth', '1', '--quiet', url.trim(), scratch], 120_000)

    if (clone.code !== 0) {
      throw new Error(clone.code === 127 ? 'git is not installed' : clone.stderr.trim() || 'git clone failed')
    }

    const folders = fs.existsSync(path.join(scratch, 'theme.json'))
      ? [scratch]
      : fs
          .readdirSync(scratch)
          .map(entry => path.join(scratch, entry))
          .filter(dir => !path.basename(dir).startsWith('.') && fs.existsSync(path.join(dir, 'theme.json')))

    if (folders.length === 0) {
      throw new Error('The repository has no theme.json')
    }

    const installed: string[] = []

    for (const folder of folders) {
      const spec = JSON.parse(fs.readFileSync(path.join(folder, 'theme.json'), 'utf8')) as ThemeSpec
      const problem = validateTheme(spec)

      if (problem) {
        throw new Error(`${path.basename(folder)}: ${problem}`)
      }

      const existing = scan().get(spec.name)

      if (existing?.source === 'builtin') {
        throw new Error(`"${spec.name}" is a built-in theme name`)
      }

      const target = path.join(userThemesDir(), spec.name)
      fs.rmSync(target, { recursive: true, force: true })
      fs.mkdirSync(target, { recursive: true })

      for (const entry of fs.readdirSync(folder)) {
        const source = path.join(folder, entry)
        const stat = fs.lstatSync(source)

        if (stat.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry).toLowerCase()) && stat.size <= MAX_IMAGE_BYTES) {
          fs.copyFileSync(source, path.join(target, entry))
        }
      }

      const wallpaper = spec.wallpaper && spec.wallpaper !== 'default' && fs.existsSync(path.join(target, path.basename(spec.wallpaper))) ? path.basename(spec.wallpaper) : 'default'
      const clean: ThemeSpec = { name: spec.name, label: spec.label, description: spec.description, shell: spec.shell?.scheme ? { scheme: spec.shell.scheme } : undefined, wallpaper, colors: spec.colors, gtk: spec.gtk, terminal: spec.terminal }
      fs.writeFileSync(path.join(target, 'theme.json'), `${JSON.stringify(clean, null, 2)}\n`)
      installed.push(spec.name)
    }

    return installed
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

/** Dress Hermes's own CLI and TUI in the theme: `~/.hermes/skins/herald-os.yaml`. */
export function writeHermesSkin(spec: ThemeSpec): void {
  try {
    const dir = path.join(hermesHome(), 'skins')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${HERALD_SKIN}.yaml`), hermesSkinYaml(spec.label || spec.name, spec.colors))
  } catch (error) {
    log('theme', `could not write the Hermes skin: ${(error as Error).message}`)
  }
}

let fontCache: string[] | null = null

/** Installed font families, for the font pickers (cached: macOS takes a few seconds to answer). */
export async function listFonts(): Promise<string[]> {
  if (fontCache) {
    return fontCache
  }

  const families = new Set<string>()

  if (process.platform === 'darwin') {
    const result = await run('system_profiler', ['SPFontsDataType', '-json'], 60_000)

    try {
      const data = JSON.parse(result.stdout) as { SPFontsDataType?: { typefaces?: { family?: string }[] }[] }

      for (const font of data.SPFontsDataType ?? []) {
        for (const face of font.typefaces ?? []) {
          if (face.family && !face.family.startsWith('.')) {
            families.add(face.family)
          }
        }
      }
    } catch {
      // No fonts listed; the pickers still accept a typed family.
    }
  } else {
    const result = await run('fc-list', [':', 'family'], 15_000)

    for (const line of result.stdout.split('\n')) {
      const family = line.split(',')[0]?.trim()

      if (family) {
        families.add(family)
      }
    }
  }

  fontCache = [...families].sort((a, b) => a.localeCompare(b))

  return fontCache
}
