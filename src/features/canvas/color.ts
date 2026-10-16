/*
 * Colour arithmetic for the colour picker: RGB (0 to 255) to and from hue, saturation and value,
 * and hex codes.
 */

export type RGB = [number, number, number]

/** Hue 0 to 360, saturation and value 0 to 1. */
export type HSV = [number, number, number]

export function rgbToHsv([r, g, b]: RGB): HSV {
  const red = r / 255
  const green = g / 255
  const blue = b / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const delta = max - min
  let hue = 0

  if (delta) {
    hue = max === red ? ((green - blue) / delta) % 6 : max === green ? (blue - red) / delta + 2 : (red - green) / delta + 4
    hue = (hue * 60 + 360) % 360
  }

  return [hue, max ? delta / max : 0, max]
}

export function hsvToRgb([hue, saturation, value]: HSV): RGB {
  const chroma = value * saturation
  const sector = (((hue % 360) + 360) % 360) / 60
  const x = chroma * (1 - Math.abs((sector % 2) - 1))
  const [r, g, b] = sector < 1 ? [chroma, x, 0] : sector < 2 ? [x, chroma, 0] : sector < 3 ? [0, chroma, x] : sector < 4 ? [0, x, chroma] : sector < 5 ? [x, 0, chroma] : [chroma, 0, x]
  const m = value - chroma

  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

export const hexOf = ([r, g, b]: RGB): string => `#${[r, g, b].map((value) => Math.round(value).toString(16).padStart(2, '0')).join('')}`

/** A hex code (#rgb or #rrggbb, the # optional) as RGB; null when it is not one. */
export function parseHex(text: string): RGB | null {
  const value = text.trim().replace(/^#/, '')

  if (/^[0-9a-f]{3}$/i.test(value)) {
    return [0, 1, 2].map((i) => parseInt(value[i] + value[i], 16)) as RGB
  }

  if (/^[0-9a-f]{6}$/i.test(value)) {
    return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16)) as RGB
  }

  return null
}

export const cssOf = ([r, g, b]: RGB): string => `rgb(${r} ${g} ${b})`
