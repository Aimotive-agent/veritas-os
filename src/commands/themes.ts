import { $env, $prefs, updatePrefs } from '../store/backend.ts'
import { fail, ok, type OsCommand } from '../store/os-commands.ts'
import { $themes, applyTheme, findTheme, generateTheme, installThemes, loadThemes } from '../store/themes.ts'

/* Themes and fonts: the whole environment's look, which Hermes can also make for you. */

async function themes() {
  return $themes.get().length > 0 ? $themes.get() : loadThemes()
}

export const themeCommands: readonly OsCommand[] = [
  {
    id: 'theme.list',
    title: 'List themes',
    description: 'List the installed themes (built in and your own) and say which is in use.',
    tier: 'read',
    args: [],
    phrases: ['what themes are there', 'list themes', 'show me the themes'],
    run: async () => {
      const list = await loadThemes()
      const current = $prefs.get().themeName ?? `herald-${$prefs.get().theme}`

      return ok(`${list.length} themes: ${list.map(theme => theme.label).join(', ')}`, {
        highlight: { kind: 'setting', id: 'appearance' },
        items: list.map(theme => ({ name: theme.name, label: theme.label, scheme: theme.scheme, source: theme.source, current: theme.name === current })),
        data: { current }
      })
    }
  },
  {
    id: 'theme.set',
    title: 'Set the theme',
    description: 'Switch to an installed theme by name; it restyles the shell, Hermes and, on Veritas OS Linux, the whole session.',
    tier: 'mutate',
    args: [{ name: 'theme', type: 'string', description: 'Theme name (see theme.list)', required: true }],
    phrases: ['set the theme to {theme}', 'switch to the {theme} theme', 'use the {theme} theme', 'change the theme to {theme}'],
    run: async ({ theme }) => {
      const match = findTheme(await themes(), String(theme))

      if (!match) {
        return fail(`No theme called "${String(theme)}". Installed: ${(await themes()).map(t => t.label).join(', ')}.`)
      }

      await applyTheme(match.name)

      return ok(`Theme set to ${match.label}`, { spoken: `Switched to ${match.label}.`, highlight: { kind: 'setting', id: 'appearance' }, data: { name: match.name } })
    }
  },
  {
    id: 'theme.generate',
    title: 'Make a theme from an image',
    description: 'Make a complete theme from an image (its colours, and the image as the wallpaper), save it with your themes and switch to it.',
    tier: 'mutate',
    args: [
      { name: 'image', type: 'string', description: 'Path of a PNG or JPEG (default: the current wallpaper)' },
      { name: 'name', type: 'string', description: 'What to call the theme' },
      { name: 'scheme', type: 'string', description: 'auto, dark or light', enum: ['auto', 'dark', 'light'] }
    ],
    phrases: ['make a theme from my wallpaper', 'make a theme from this wallpaper', 'theme from wallpaper'],
    run: async ({ image, name, scheme }) => {
      const source = image ? String(image) : $prefs.get().wallpaper

      if (!source) {
        return fail('Name an image to make the theme from (the drawn Veritas wallpaper is not an image file).')
      }

      const theme = await generateTheme({ image: source, name: name ? String(name) : undefined, scheme: scheme as 'auto' | 'dark' | 'light' | undefined })
      const label = $themes.get().find(entry => entry.name === theme)?.label ?? theme

      return ok(`Made and applied the ${label} theme`, { spoken: `Done: ${label} is your theme now.`, highlight: { kind: 'setting', id: 'appearance' }, data: { name: theme } })
    }
  },
  {
    id: 'theme.install',
    title: 'Install a theme from git',
    description: 'Install the themes in a git repository (https). Only their colours and images are kept; nothing in them can run.',
    tier: 'mutate',
    args: [{ name: 'url', type: 'string', description: 'https address of the repository', required: true }],
    run: async ({ url }) => {
      const names = await installThemes(String(url))

      return ok(`Installed ${names.join(', ')}`, { highlight: { kind: 'setting', id: 'appearance' }, items: names })
    }
  },
  {
    id: 'theme.followHermes',
    title: 'Follow Hermes skins',
    description: "Restyle Veritas OS whenever Hermes's skin changes (/skin in a chat).",
    tier: 'mutate',
    args: [{ name: 'enabled', type: 'boolean', description: 'true to follow the skin', required: true }],
    phrases: [
      { phrase: 'follow the hermes skin', args: { enabled: true } },
      { phrase: 'stop following the hermes skin', args: { enabled: false } }
    ],
    run: async ({ enabled }) => {
      await updatePrefs({ followHermesSkin: Boolean(enabled) })

      return ok(`Following Hermes skins ${enabled ? 'on' : 'off'}`, { highlight: { kind: 'setting', id: 'appearance' } })
    }
  },
  {
    id: 'wallpaper.set',
    title: 'Set the wallpaper',
    description: 'Use an image as the wallpaper, or "default" for the drawn Veritas wallpaper.',
    tier: 'mutate',
    args: [{ name: 'image', type: 'string', description: 'Image path, or "default"', required: true }],
    phrases: [{ phrase: 'use the default wallpaper', args: { image: 'default' } }],
    run: async ({ image }) => {
      const value = String(image).trim()
      const reset = /^(default|none|herald)$/i.test(value)
      await updatePrefs({ wallpaper: reset ? undefined : value.replace(/^~(?=\/)/, $env.get()?.homeDir ?? '~') })

      return ok(reset ? 'Back to the Veritas wallpaper' : 'Wallpaper updated', { highlight: { kind: 'setting', id: 'appearance' } })
    }
  },
  {
    id: 'font.list',
    title: 'List fonts',
    description: 'List the font families installed on this computer.',
    tier: 'read',
    args: [{ name: 'filter', type: 'string', description: 'Only families containing this' }],
    run: async ({ filter }) => {
      const needle = filter ? String(filter).toLowerCase() : ''
      const families = (await window.heraldOS.fonts.list()).filter(family => !needle || family.toLowerCase().includes(needle))

      return ok(`${families.length} font famil${families.length === 1 ? 'y' : 'ies'}`, { items: families.slice(0, 200) })
    }
  },
  {
    id: 'font.set',
    title: 'Set a font',
    description: 'Use a font family for the interface or for code (terminal, editors); "default" goes back to the built-in one.',
    tier: 'mutate',
    args: [
      { name: 'family', type: 'string', description: 'Font family name, or "default"', required: true },
      { name: 'kind', type: 'string', description: 'ui or mono', enum: ['ui', 'mono'] }
    ],
    phrases: ['use the font {family}', 'set the font to {family}', { phrase: 'set the code font to {family}', args: { kind: 'mono' } }],
    run: async ({ family, kind }) => {
      const value = String(family).trim()
      const reset = /^(default|system|reset)$/i.test(value)
      const which = kind === 'mono' ? 'mono' : 'ui'
      await updatePrefs({ fonts: { ...$prefs.get().fonts, [which]: reset ? undefined : value } })

      return ok(reset ? `Back to the default ${which === 'mono' ? 'code' : 'interface'} font` : `${which === 'mono' ? 'Code' : 'Interface'} font set to ${value}`, { highlight: { kind: 'setting', id: 'appearance' } })
    }
  }
]
