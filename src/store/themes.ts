import { atom } from 'nanostores'
import type { HeraldOSPrefs } from '../../shared/ipc.ts'
import { type ColorScheme, HERALD_SKIN, schemeOf, themeColorsFromSkin, themeFromPixels, themeSlug, type ThemeSummary } from '../../shared/theme.ts'
import { $prefs, applyPrefsToDocument, updatePrefs } from './backend.ts'
import { $gatewayReady, onGatewayEvent } from './gateway.ts'
import { isMainSurface } from './shell.ts'

/** Installed themes (built in first, then the person's own), as main lists them. */
export const $themes = atom<ThemeSummary[]>([])

export async function loadThemes(): Promise<ThemeSummary[]> {
  const themes = (await window.heraldOS.theme?.list().catch(() => [])) ?? []
  $themes.set(themes)

  return themes
}

/** A theme by name, by its built-in short name ("ocean" for herald-ocean), or by its label. */
export function findTheme(themes: readonly ThemeSummary[], query: string): ThemeSummary | undefined {
  const needle = query.trim().toLowerCase()
  const slug = themeSlug(needle)

  return (
    themes.find(theme => theme.name === needle || theme.name === slug) ??
    themes.find(theme => theme.name === `herald-${slug}`) ??
    themes.find(theme => theme.label.toLowerCase() === needle) ??
    themes.find(theme => theme.label.toLowerCase().includes(needle) || theme.name.includes(slug))
  )
}

export async function applyTheme(name: string): Promise<HeraldOSPrefs> {
  const next = await window.heraldOS.theme.apply(name)
  $prefs.set(next)
  applyPrefsToDocument(next)

  return next
}

/** RGBA pixels of an image, through a small PNG main makes of it. */
async function imagePixels(imagePath: string): Promise<Uint8ClampedArray> {
  const dataUrl = await window.heraldOS.theme.sample(imagePath)

  if (!dataUrl) {
    throw new Error(`${imagePath.split('/').pop() || imagePath} is not an image Veritas OS can read (PNG or JPEG).`)
  }

  const image = new Image()
  image.src = dataUrl
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, image.naturalWidth)
  canvas.height = Math.max(1, image.naturalHeight)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })

  if (!ctx) {
    throw new Error('Could not read the image.')
  }

  ctx.drawImage(image, 0, 0)

  return ctx.getImageData(0, 0, canvas.width, canvas.height).data
}

const fileLabel = (file: string) =>
  (file.split('/').pop() ?? file)
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Make a theme from an image (it also becomes the wallpaper), save it and apply it. */
export async function generateTheme(options: { image: string; name?: string; scheme?: ColorScheme | 'auto' }): Promise<string> {
  const file = decodeURIComponent(options.image.replace(/^file:\/\//, ''))
  const pixels = await imagePixels(file)
  const label = options.name?.trim() || fileLabel(file) || 'My theme'
  const spec = themeFromPixels(pixels, { name: themeSlug(label), label, description: `Made from ${file.split('/').pop() ?? 'an image'}.`, scheme: options.scheme })
  const name = await window.heraldOS.theme.save(spec, file)
  await loadThemes()
  await applyTheme(name)

  return name
}

export async function installThemes(url: string): Promise<string[]> {
  const names = await window.heraldOS.theme.install(url)
  await loadThemes()

  return names
}

let lastSkinSignature = ''

/** Hermes's skin changed (or the gateway reconnected): restyle Veritas OS when the person asked for that. */
async function followSkin(skin: { name?: string; colors?: Record<string, string> } | null | undefined): Promise<void> {
  if (!skin || !$prefs.get().followHermesSkin || !skin.name || skin.name === HERALD_SKIN) {
    return
  }

  const colors = themeColorsFromSkin(skin)
  const signature = JSON.stringify([skin.name, colors])

  if (!colors || signature === lastSkinSignature) {
    return
  }

  lastSkinSignature = signature
  await updatePrefs({ themeName: `hermes-${skin.name}`, theme: 'ocean', accent: 'blue', themeColors: colors, themeScheme: schemeOf(colors), wallpaper: undefined })
}

let bound = false

export function bindThemes(): () => void {
  if (bound || !isMainSurface) {
    return () => undefined
  }

  bound = true
  const offReady = $gatewayReady.subscribe(ready => void followSkin(ready?.skin as Parameters<typeof followSkin>[0]).catch(() => undefined))
  const offChanged = onGatewayEvent('skin.changed', event => void followSkin(event.payload as Parameters<typeof followSkin>[0]).catch(() => undefined))

  return () => {
    offReady()
    offChanged()
    bound = false
  }
}
