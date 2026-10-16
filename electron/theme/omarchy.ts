import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isHexColor, mix, schemeOf, type ThemeColors, type ThemeSpec, themeSlug } from '../../shared/theme.ts'

/*
 * Veritas inside Omarchy follows Omarchy's theme: the active one is linked as current/theme (in
 * ~/.local/state/omarchy on Omarchy 4, ~/.config/omarchy on Omarchy 3), and its colors.toml (or,
 * in older themes, alacritty.toml) holds the palette. Omarchy runs `herald-os theme omarchy` from
 * its theme-set hook when the theme changes.
 */

export function omarchyDir(home = os.homedir()): string {
  return path.join(home, '.config', 'omarchy')
}

/** Where Omarchy links the active theme and background: Omarchy 4 first, then Omarchy 3. */
export function omarchyCurrentDirs(home = os.homedir()): string[] {
  return [path.join(home, '.local', 'state', 'omarchy', 'current'), path.join(omarchyDir(home), 'current')]
}

export function isOmarchy(home = os.homedir(), env: NodeJS.ProcessEnv = process.env): boolean {
  const roots = [env.OMARCHY_PATH, '/usr/share/omarchy', path.join(home, '.local', 'share', 'omarchy')].filter((root): root is string => Boolean(root))

  return roots.some(root => fs.existsSync(path.join(root, 'themes'))) || omarchyCurrentDirs(home).some(dir => fs.existsSync(path.join(dir, 'theme')))
}

/** `key = "value"` pairs from a TOML file, keyed both plainly and by section (`colors.primary.background`). */
export function parseTomlStrings(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  let section = ''

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim()
    const header = /^\[([^\]]+)\]$/.exec(line)

    if (header) {
      section = (header[1] ?? '').trim()

      continue
    }

    const pair = /^([A-Za-z0-9_.-]+)\s*=\s*["']([^"']*)["']/.exec(line)

    if (pair) {
      const key = pair[1] as string
      const value = (pair[2] as string).trim().replace(/^0x/i, '#')
      out[section ? `${section}.${key}` : key] = value
      out[key] ??= value
    }
  }

  return out
}

/** Veritas's colours from Omarchy's (or alacritty's) palette; null without a background and foreground. */
export function themeColorsFromOmarchy(values: Record<string, string>): ThemeColors | null {
  const get = (...keys: string[]) => keys.map(key => values[key]).find(isHexColor)
  const bg = get('background', 'colors.primary.background', 'base00', 'color0')
  const fg = get('foreground', 'colors.primary.foreground', 'base05', 'color7')

  if (!bg || !fg) {
    return null
  }

  const accent = get('accent', 'colors.normal.blue', 'color4', 'base0D', 'cursor', 'colors.cursor.cursor') ?? mix(fg, bg, 0.3)

  return {
    bg,
    bg2: mix(bg, accent, 0.1),
    surface: get('selection_background', 'colors.selection.background', 'base02') ?? mix(bg, fg, 0.12),
    fg,
    fg_dim: get('colors.dim.foreground', 'base04') ?? mix(fg, bg, 0.4),
    accent,
    accent_strong: get('colors.bright.blue', 'color12', 'base0C') ?? accent,
    border_active: accent,
    border_inactive: mix(bg, fg, 0.15),
    urgent: get('colors.normal.red', 'color1', 'base08', 'red') ?? '#ff6b6b',
    ok: get('colors.normal.green', 'color2', 'base0B', 'green') ?? '#36e6a6',
    warn: get('colors.normal.yellow', 'color3', 'base0A', 'yellow') ?? '#f2c25e'
  }
}

/** Omarchy 4 stages a copy of the theme as current/theme and writes its name beside it; Omarchy 3 links the theme's own folder. */
function themeName(current: string, dir: string): string {
  try {
    const name = fs.readFileSync(path.join(current, 'theme.name'), 'utf8').trim()

    if (name) {
      return name
    }
  } catch {
    // Omarchy 3.
  }

  return path.basename(dir)
}

/** The active Omarchy theme as a Veritas theme, with Omarchy's background as the wallpaper. */
export function readOmarchyTheme(home = os.homedir()): { spec: ThemeSpec; dir: string } | null {
  const current = omarchyCurrentDirs(home).find(base => fs.existsSync(path.join(base, 'theme')))
  let dir: string

  try {
    dir = fs.realpathSync(path.join(current ?? '', 'theme'))
  } catch {
    return null
  }

  for (const file of ['colors.toml', 'alacritty.toml']) {
    let text: string

    try {
      text = fs.readFileSync(path.join(dir, file), 'utf8')
    } catch {
      continue
    }

    const colors = themeColorsFromOmarchy(parseTomlStrings(text))

    if (!colors) {
      continue
    }

    const name = themeName(current ?? '', dir)
    let wallpaper: string | undefined

    try {
      wallpaper = fs.realpathSync(path.join(current ?? '', 'background'))
    } catch {
      wallpaper = undefined
    }

    return {
      dir,
      spec: {
        name: `omarchy-${themeSlug(name)}`,
        label: `Omarchy: ${name.replace(/[-_]+/g, ' ')}`,
        description: "Follows Omarchy's theme",
        shell: { scheme: schemeOf(colors) },
        colors,
        ...(wallpaper ? { wallpaper } : {})
      }
    }
  }

  return null
}
