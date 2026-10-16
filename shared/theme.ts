/*
 * Themes as data. A theme is the `theme.json` the Linux theme engine already reads
 * (linux/themes/<name>/theme.json): one set of `colors` recolours the shell, the compositor, GTK,
 * the lock screen, the terminal and Hermes's own skin. Everything here is pure so the renderer,
 * Electron main and the tests share one definition.
 */

export type ColorScheme = 'dark' | 'light'

/** The colour set every theme defines (the keys of `theme.json` `colors`). */
export interface ThemeColors {
  bg: string
  bg2: string
  surface: string
  fg: string
  fg_dim: string
  accent: string
  accent_strong: string
  border_active: string
  border_inactive: string
  urgent: string
  ok: string
  warn: string
}

export const THEME_COLOR_KEYS: readonly (keyof ThemeColors)[] = ['bg', 'bg2', 'surface', 'fg', 'fg_dim', 'accent', 'accent_strong', 'border_active', 'border_inactive', 'urgent', 'ok', 'warn']

/** A whole `theme.json`. */
export interface ThemeSpec {
  name: string
  label?: string
  description?: string
  /** `theme` names one of the shell's two hand-tuned presets; themes without one derive the shell from `colors`. */
  shell?: { theme?: 'ocean' | 'graphite'; accent?: 'blue' | 'ice' | 'violet'; scheme?: ColorScheme }
  /** "default" for the drawn wallpaper, or an image path relative to the theme folder. */
  wallpaper?: string
  colors: ThemeColors
  gtk?: { color_scheme?: string; theme?: string }
  terminal?: { background?: string; foreground?: string; cursor?: string; palette?: string[] }
}

/** What Settings lists for each installed theme. */
export interface ThemeSummary {
  name: string
  label: string
  description: string
  scheme: ColorScheme
  colors: ThemeColors
  source: 'builtin' | 'user'
}

// ---- Colour maths ------------------------------------------------------------------------------

export interface Rgb {
  r: number
  g: number
  b: number
}

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value))

export function parseHex(value: string): Rgb | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value ?? '').trim())

  if (!match) {
    return null
  }

  const hex = match[1].length === 3 ? [...match[1]].map(c => c + c).join('') : match[1]

  return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) }
}

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && parseHex(value) !== null
}

export function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map(v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('')}`
}

function rgb(color: string): Rgb {
  return parseHex(color) ?? { r: 0, g: 0, b: 0 }
}

/** `t` = 0 gives `a`, 1 gives `b`. */
export function mix(a: string, b: string, t: number): string {
  const x = rgb(a)
  const y = rgb(b)

  return toHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t })
}

export function withAlpha(color: string, alpha: number): string {
  const { r, g, b } = rgb(color)

  return `rgba(${r}, ${g}, ${b}, ${Math.round(clamp(alpha, 0, 1) * 1000) / 1000})`
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(color: string): number {
  const channel = (v: number) => {
    const s = v / 255

    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  const { r, g, b } = rgb(color)

  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)

  return (hi + 0.05) / (lo + 0.05)
}

export interface Hsl {
  h: number
  s: number
  l: number
}

export function toHsl(color: string): Hsl {
  const { r, g, b } = rgb(color)
  const [x, y, z] = [r / 255, g / 255, b / 255]
  const max = Math.max(x, y, z)
  const min = Math.min(x, y, z)
  const l = (max + min) / 2

  if (max === min) {
    return { h: 0, s: 0, l }
  }

  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === x ? ((y - z) / d + (y < z ? 6 : 0)) * 60 : max === y ? ((z - x) / d + 2) * 60 : ((x - y) / d + 4) * 60

  return { h, s, l }
}

export function fromHsl({ h, s, l }: Hsl): string {
  const hue = (((h % 360) + 360) % 360) / 360
  const sat = clamp(s, 0, 1)
  const light = clamp(l, 0, 1)

  if (sat === 0) {
    return toHex({ r: light * 255, g: light * 255, b: light * 255 })
  }

  const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat
  const p = 2 * light - q
  const channel = (t: number) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t

    return u < 1 / 6 ? p + (q - p) * 6 * u : u < 1 / 2 ? q : u < 2 / 3 ? p + (q - p) * (2 / 3 - u) * 6 : p
  }

  return toHex({ r: channel(hue + 1 / 3) * 255, g: channel(hue) * 255, b: channel(hue - 1 / 3) * 255 })
}

const withLightness = (color: string, l: number) => fromHsl({ ...toHsl(color), l })

/** Text colour for buttons on `color`: white while it keeps 3:1 (WCAG's bar for UI controls), else near-black. */
export function readableOn(color: string): string {
  return contrast(color, '#ffffff') >= 3 ? '#ffffff' : '#111318'
}

export function schemeOf(colors: Pick<ThemeColors, 'bg'>, declared?: ColorScheme): ColorScheme {
  return declared ?? (luminance(colors.bg) > 0.4 ? 'light' : 'dark')
}

// ---- Shell palette -----------------------------------------------------------------------------

/**
 * The shell's CSS custom properties for a theme (src/styles.css declares the defaults). Panels mode
 * wants near-opaque glass because one compositor window cannot blur another. A light scheme swaps
 * Tailwind's white and black, so the `bg-white/…` hover and fill overlays darken instead of lighten.
 */
export function paletteVars(colors: ThemeColors, options: { scheme?: ColorScheme; panels?: boolean } = {}): Record<string, string> {
  const scheme = schemeOf(colors, options.scheme)
  const light = scheme === 'light'
  const pick = (glass: number, panel: number) => (options.panels ? panel : glass)
  const line = mix(colors.fg_dim, colors.accent, 0.35)
  const glass2 = withAlpha(mix(colors.surface, colors.accent, 0.08), pick(light ? 0.6 : 0.42, 0.78))
  const glass3 = withAlpha(mix(colors.surface, colors.accent, 0.2), pick(light ? 0.68 : 0.5, 0.84))
  const tile = mix(colors.accent, colors.bg, 0.25)

  return {
    'color-scheme': scheme,
    '--color-bg': colors.bg,
    '--color-bg-elevated': withAlpha(colors.surface, pick(light ? 0.92 : 0.82, 0.97)),
    '--color-glass': withAlpha(mix(colors.bg, colors.bg2, 0.5), pick(light ? 0.8 : 0.74, 0.95)),
    '--color-glass-2': glass2,
    '--color-glass-3': glass3,
    '--color-surface': withAlpha(colors.surface, pick(0.6, 0.9)),
    '--color-surface-2': glass2,
    '--color-surface-3': glass3,
    '--color-line': withAlpha(line, light ? 0.24 : 0.26),
    '--color-line-strong': withAlpha(line, light ? 0.46 : 0.55),
    '--color-hairline': withAlpha(line, light ? 0.24 : 0.26),
    '--color-hairline-strong': withAlpha(line, light ? 0.46 : 0.55),
    '--color-fg': colors.fg,
    '--color-fg-2': withAlpha(colors.fg, light ? 0.84 : 0.84),
    '--color-fg-3': withAlpha(colors.fg_dim, light ? 0.94 : 0.82),
    '--color-fg-4': withAlpha(colors.fg_dim, light ? 0.7 : 0.56),
    '--color-accent': colors.accent,
    '--color-accent-strong': colors.accent_strong,
    '--color-accent-soft': withAlpha(colors.accent, light ? 0.18 : 0.24),
    '--color-accent-fg': readableOn(colors.accent),
    '--color-ok': colors.ok,
    '--color-warn': colors.warn,
    '--color-danger': colors.urgent,
    '--color-input': withAlpha(mix(colors.bg, light ? '#ffffff' : '#000000', 0.3), light ? 0.75 : 0.5),
    '--tile-from': withAlpha(colors.accent, 0.6),
    '--tile-to': withAlpha(mix(colors.accent, colors.bg, 0.45), 0.6),
    '--tile-border': withAlpha(colors.accent_strong, 0.4),
    '--tile-fg': readableOn(tile),
    '--scrollbar': withAlpha(colors.fg_dim, 0.3),
    '--color-page': light ? withAlpha(mix(colors.bg, '#ffffff', 0.4), 0.6) : withAlpha(mix(colors.bg, '#000000', 0.15), 0.42),
    '--menubar-from': light ? withAlpha(mix(colors.bg, colors.fg, 0.05), pick(0.72, 0.9)) : withAlpha(mix(colors.bg, '#000000', 0.3), pick(0.55, 0.72)),
    '--menubar-to': light ? withAlpha(colors.bg, pick(0.35, 0.7)) : withAlpha(mix(colors.bg, '#000000', 0.3), pick(0.15, 0.42)),
    ...(light ? { '--color-white': colors.fg, '--color-black': '#ffffff' } : {})
  }
}

/** Every property `paletteVars` may set, so a switch back to a preset can clear them all. */
export const PALETTE_PROPERTIES: readonly string[] = Object.keys(
  paletteVars({ bg: '#ffffff', bg2: '#ffffff', surface: '#ffffff', fg: '#000000', fg_dim: '#555555', accent: '#336699', accent_strong: '#3377aa', border_active: '#336699', border_inactive: '#cccccc', urgent: '#cc3333', ok: '#33aa66', warn: '#cc9933' }, { scheme: 'light' })
)

/** How the drawn wallpaper takes on a theme: gradient stops, the ribbons' hue and the vignette. */
export interface WallpaperTint {
  stops: [string, string, string]
  hue: number
  saturation: number
  light: boolean
  vignette: string
}

export function wallpaperTint(colors: ThemeColors | undefined | null, declared?: ColorScheme): WallpaperTint | null {
  if (!colors) {
    return null
  }

  const light = schemeOf(colors, declared) === 'light'
  const { h, s } = toHsl(colors.accent)

  return {
    stops: light ? [mix(colors.bg, colors.accent, 0.22), mix(colors.bg, colors.accent, 0.1), colors.bg] : [mix(colors.bg2, colors.accent, 0.4), colors.bg2, colors.bg],
    hue: h,
    saturation: clamp(s, 0.3, 1),
    light,
    vignette: light ? withAlpha(mix(colors.bg, colors.fg, 0.2), 0.22) : withAlpha(mix(colors.bg, '#000000', 0.5), 0.42)
  }
}

// ---- Themes from an image ------------------------------------------------------------------------

interface Cluster {
  color: Rgb
  weight: number
}

/** A few k-means rounds over the pixels, seeded at luminance quantiles so the result is repeatable. */
export function dominantColors(samples: readonly Rgb[], k = 6, rounds = 8): { color: string; weight: number }[] {
  if (samples.length === 0) {
    return []
  }

  const lum = (c: Rgb) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
  const sorted = [...samples].sort((a, b) => lum(a) - lum(b))
  const count = Math.min(k, sorted.length)
  let centers: Rgb[] = Array.from({ length: count }, (_, i) => ({ ...sorted[Math.floor(((i + 0.5) / count) * sorted.length)] }))
  let clusters: Cluster[] = []

  for (let round = 0; round < rounds; round++) {
    const sums = centers.map(() => ({ r: 0, g: 0, b: 0, n: 0 }))

    for (const s of samples) {
      let best = 0
      let bestDistance = Infinity

      centers.forEach((c, i) => {
        const distance = (s.r - c.r) ** 2 + (s.g - c.g) ** 2 + (s.b - c.b) ** 2

        if (distance < bestDistance) {
          bestDistance = distance
          best = i
        }
      })

      const sum = sums[best]
      sum.r += s.r
      sum.g += s.g
      sum.b += s.b
      sum.n += 1
    }

    clusters = sums.map((sum, i) => ({ color: sum.n ? { r: sum.r / sum.n, g: sum.g / sum.n, b: sum.b / sum.n } : centers[i], weight: sum.n / samples.length }))
    centers = clusters.map(c => c.color)
  }

  return clusters
    .filter(c => c.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .map(c => ({ color: toHex(c.color), weight: c.weight }))
}

const FALLBACK_ACCENT = '#4d92ff'

/** Standard terminal colours tuned to the theme's lightness, with its own black and white ends. */
export function terminalPalette(colors: ThemeColors, light: boolean): string[] {
  const hues = [0, 140, 45, 215, 290, 185]
  const normal = hues.map(h => fromHsl({ h, s: 0.62, l: light ? 0.4 : 0.64 }))
  const bright = hues.map(h => fromHsl({ h, s: 0.7, l: light ? 0.48 : 0.76 }))
  const black = light ? mix(colors.fg, colors.bg, 0.1) : mix(colors.bg, colors.fg, 0.18)
  const white = light ? mix(colors.bg, colors.fg, 0.25) : mix(colors.fg, colors.bg, 0.1)

  return [black, ...normal, white, light ? mix(colors.fg, colors.bg, 0.35) : mix(colors.bg, colors.fg, 0.38), ...bright, light ? mix(colors.bg, colors.fg, 0.06) : '#ffffff']
}

/**
 * Turn an image's pixels (RGBA, as a canvas gives them) into a complete theme: a background with the
 * image's own tone, its most colourful colour as the accent (adjusted until it reads on that
 * background), matching text, borders, status colours, a terminal palette and a GTK scheme.
 */
export function themeFromPixels(pixels: ArrayLike<number>, options: { name: string; label?: string; description?: string; scheme?: ColorScheme | 'auto' }): ThemeSpec {
  const samples: Rgb[] = []

  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] > 200) {
      samples.push({ r: pixels[i], g: pixels[i + 1], b: pixels[i + 2] })
    }
  }

  if (samples.length === 0) {
    throw new Error('The image has no visible pixels to take colours from.')
  }

  const clusters = dominantColors(samples)
  const averageLuminance = clusters.reduce((sum, c) => sum + luminance(c.color) * c.weight, 0)
  const scheme: ColorScheme = options.scheme && options.scheme !== 'auto' ? options.scheme : averageLuminance > 0.42 ? 'light' : 'dark'
  const light = scheme === 'light'
  const chroma = (color: string) => {
    const { s, l } = toHsl(color)

    return s * (1 - Math.abs(2 * l - 1))
  }
  const colourful = clusters.filter(c => c.weight >= 0.02).sort((a, b) => chroma(b.color) * Math.sqrt(b.weight) - chroma(a.color) * Math.sqrt(a.weight))[0]
  const baseSeed = [...clusters].sort((a, b) => (light ? luminance(b.color) - luminance(a.color) : luminance(a.color) - luminance(b.color)))[0]
  const baseHsl = toHsl(baseSeed.color)
  const bg = fromHsl({ h: baseHsl.h, s: Math.min(baseHsl.s, 0.45), l: light ? 0.95 : 0.075 })
  let accent = colourful && chroma(colourful.color) > 0.12 ? colourful.color : FALLBACK_ACCENT
  const accentHsl = toHsl(accent)
  accent = fromHsl({ h: accentHsl.h, s: Math.max(accentHsl.s, 0.5), l: clamp(accentHsl.l, light ? 0.34 : 0.55, light ? 0.48 : 0.7) })

  // Nudge the accent's lightness until it reads against the background.
  for (let step = 0; step < 12 && contrast(accent, bg) < 3; step++) {
    const hsl = toHsl(accent)
    accent = fromHsl({ ...hsl, l: clamp(hsl.l + (light ? -0.04 : 0.04), 0.05, 0.95) })
  }

  const fg = light ? mix('#12151c', accent, 0.12) : mix('#ffffff', accent, 0.06)
  const surface = light ? mix(bg, '#ffffff', 0.55) : mix(bg, mix(accent, '#ffffff', 0.15), 0.16)
  const accentL = toHsl(accent).l
  const colors: ThemeColors = {
    bg,
    bg2: mix(bg, accent, light ? 0.06 : 0.14),
    surface,
    fg,
    fg_dim: mix(fg, bg, 0.38),
    accent,
    accent_strong: withLightness(accent, light ? Math.max(0.2, accentL - 0.08) : Math.min(0.86, accentL + 0.08)),
    border_active: accent,
    border_inactive: mix(bg, fg, 0.14),
    urgent: light ? '#c93a3a' : '#ff6b6b',
    ok: light ? '#1d8f63' : '#36e6a6',
    warn: light ? '#a86c12' : '#f2c25e'
  }

  return {
    name: options.name,
    label: options.label ?? options.name,
    description: options.description ?? 'Made from an image.',
    shell: { scheme },
    wallpaper: 'default',
    colors,
    gtk: { color_scheme: light ? 'default' : 'prefer-dark', theme: light ? 'Adwaita' : 'Adwaita-dark' },
    terminal: { background: bg, foreground: fg, cursor: colors.accent_strong, palette: terminalPalette(colors, light) }
  }
}

const ANSI_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const

/** The in-shell terminal's colours (xterm's theme object) for a theme. */
export function terminalColors(colors: ThemeColors, declared?: ColorScheme): Record<string, string> {
  const light = schemeOf(colors, declared) === 'light'
  const palette = terminalPalette(colors, light)
  const background = light ? colors.bg : mix(colors.bg, '#000000', 0.2)

  return {
    background,
    foreground: colors.fg,
    cursor: colors.accent_strong,
    cursorAccent: background,
    selectionBackground: withAlpha(colors.accent, 0.3),
    ...Object.fromEntries(ANSI_NAMES.map((name, i) => [name, palette[i]]))
  }
}

/** A theme name people can type: lowercase words joined by dashes. */
export function themeSlug(value: string): string {
  return (
    String(value ?? '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'my-theme'
  )
}

/** Check a parsed `theme.json`; returns the problem, or null when it is usable. */
export function validateTheme(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return 'theme.json must be a JSON object'
  }

  const spec = value as Partial<ThemeSpec>

  if (typeof spec.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(spec.name)) {
    return 'theme.json needs a "name" of lowercase letters, digits and dashes'
  }

  if (!spec.colors || typeof spec.colors !== 'object') {
    return 'theme.json needs "colors"'
  }

  const missing = THEME_COLOR_KEYS.filter(key => !isHexColor((spec.colors as unknown as Record<string, unknown>)[key]))

  return missing.length ? `theme.json colours must be #rrggbb; check ${missing.join(', ')}` : null
}

// ---- Hermes skins ------------------------------------------------------------------------------

export const HERALD_SKIN = 'herald-os'

/** The Hermes skin (`~/.hermes/skins/herald-os.yaml`) that dresses Hermes's own CLI and TUI in the theme. */
export function hermesSkinColors(colors: ThemeColors): Record<string, string> {
  return {
    banner_border: colors.accent,
    banner_title: colors.accent_strong,
    banner_accent: colors.accent,
    banner_dim: colors.fg_dim,
    banner_text: colors.fg,
    ui_accent: colors.accent,
    ui_label: colors.accent_strong,
    ui_ok: colors.ok,
    ui_error: colors.urgent,
    ui_warn: colors.warn,
    prompt: colors.fg,
    input_rule: colors.border_inactive,
    response_border: colors.accent,
    status_bar_bg: colors.bg2,
    status_bar_text: colors.fg_dim,
    status_bar_strong: colors.accent_strong,
    status_bar_dim: colors.fg_dim,
    status_bar_good: colors.ok,
    status_bar_warn: colors.warn,
    status_bar_bad: colors.urgent,
    status_bar_critical: colors.urgent,
    session_label: colors.accent,
    session_border: colors.border_inactive,
    completion_menu_bg: colors.bg2,
    completion_menu_current_bg: colors.surface,
    selection_bg: colors.surface,
    shell_dollar: colors.accent,
    voice_status_bg: colors.bg2
  }
}

export function hermesSkinYaml(label: string, colors: ThemeColors): string {
  const lines = [`# Written by Veritas OS from its "${label.replace(/"/g, "'")}" theme; Veritas OS rewrites it when the theme changes.`, `name: ${HERALD_SKIN}`, `description: "Veritas OS: ${label.replace(/"/g, "'")}"`, 'colors:']

  for (const [key, value] of Object.entries(hermesSkinColors(colors))) {
    lines.push(`  ${key}: "${value}"`)
  }

  return `${lines.join('\n')}\n`
}

/** Veritas colours from a Hermes skin the person picked with /skin; null when it lacks the basics. */
export function themeColorsFromSkin(skin: { colors?: Record<string, string> } | null | undefined): ThemeColors | null {
  const c = skin?.colors ?? {}
  const get = (...keys: string[]) => keys.map(key => c[key]).find(isHexColor)
  const accent = get('ui_accent', 'banner_accent', 'banner_title')
  const fg = get('banner_text', 'prompt')
  const base = get('status_bar_bg', 'completion_menu_bg')

  if (!accent || !fg || !base) {
    return null
  }

  const light = luminance(base) > 0.4
  const bg = light ? base : mix(base, '#000000', 0.25)

  return {
    bg,
    bg2: mix(bg, accent, 0.1),
    surface: get('completion_menu_current_bg', 'selection_bg') ?? mix(bg, fg, 0.12),
    fg,
    fg_dim: get('status_bar_text', 'banner_dim') ?? mix(fg, bg, 0.4),
    accent,
    accent_strong: get('banner_title', 'status_bar_strong') ?? accent,
    border_active: accent,
    border_inactive: get('session_border', 'input_rule') ?? mix(bg, fg, 0.15),
    urgent: get('ui_error', 'status_bar_bad') ?? '#ff6b6b',
    ok: get('ui_ok', 'status_bar_good') ?? '#36e6a6',
    warn: get('ui_warn', 'status_bar_warn') ?? '#f2c25e'
  }
}
