/*
 * Text layers for Veritas Canvas. A text layer is a pixel layer whose PNG shows the text, plus the
 * text and its style in the manifest, so it can be edited again (and Compositor reads the same
 * record). Fonts are kept by PostScript-style name ("HelveticaNeue-Bold"); lines are laid out here
 * from a measuring function, and drawn with a 2D canvas. Point text grows from where it was
 * clicked; paragraph text wraps inside its box.
 */

import { type RGB, type TextAlignment, type TextStyle, type Vec2 } from '../../../../shared/canvas/comp-format.ts'
import { Raster } from './raster.ts'

// Fonts.

export interface FontFace {
  family: string
  weight: number
  italic: boolean
}

/** Style words in PostScript names and the weights they stand for, longest first so "SemiBold" wins over "Bold". */
const WEIGHT_WORDS: [string, number][] = [
  ['ExtraLight', 200],
  ['UltraLight', 200],
  ['ExtraBold', 800],
  ['UltraBold', 800],
  ['SemiBold', 600],
  ['DemiBold', 600],
  ['Semibold', 600],
  ['Hairline', 100],
  ['Regular', 400],
  ['Medium', 500],
  ['Normal', 400],
  ['Light', 300],
  ['Heavy', 900],
  ['Black', 900],
  ['Roman', 400],
  ['Thin', 100],
  ['Bold', 700],
  ['Book', 400]
]

const WEIGHT_NAMES: Record<number, string> = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' }

/** "HelveticaNeue" to "Helvetica Neue", "SFProDisplay" to "SF Pro Display"; "PSMT" and "MT" endings go. */
export function spacedFamily(name: string): string {
  return name
    .replace(/(PS)?MT$/, '')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
}

/** The faces on this computer, by PostScript name and by family, once the window has listed them. */
const knownFaces = new Map<string, FontFace>()
const familyFaces = new Map<string, { postscriptName: string; face: FontFace }[]>()

/** Weight and slant from a face's style name ("Bold Italic", "SemiBold", "Light Oblique"). */
export function styleOf(style: string): { weight: number; italic: boolean } {
  const compact = style.replace(/\s+/g, '').toLowerCase()

  return { weight: WEIGHT_WORDS.find(([word]) => compact.includes(word.toLowerCase()))?.[1] ?? 400, italic: /italic|oblique/i.test(style) }
}

/** Take in the computer's faces (from Chromium's Local Font Access API), so font names are read and made exactly. */
export function registerFaces(fonts: readonly { postscriptName: string; family: string; style: string }[]): void {
  knownFaces.clear()
  familyFaces.clear()

  for (const font of fonts) {
    if (!font.postscriptName || !font.family) {
      continue
    }

    const face = { family: font.family, ...styleOf(font.style) }
    const key = font.family.toLowerCase()
    knownFaces.set(font.postscriptName, face)
    familyFaces.set(key, [...(familyFaces.get(key) ?? []), { postscriptName: font.postscriptName, face }])
  }
}

/** The family, weight and slant a PostScript-style name stands for. */
export function fontFace(fontName: string): FontFace {
  const known = knownFaces.get(fontName)

  if (known) {
    return known
  }

  const dash = fontName.indexOf('-')
  const base = dash < 0 ? fontName : fontName.slice(0, dash)
  let style = dash < 0 ? '' : fontName.slice(dash + 1)
  const italic = /(Italic|Oblique|It)$/.test(style)
  style = style.replace(/(Italic|Oblique|It)$/, '')
  const weight = WEIGHT_WORDS.find(([word]) => style.includes(word))?.[1] ?? 400
  // A name with spaces is a family name already.
  const family = /\s/.test(base) ? base.trim() : spacedFamily(base)

  return { family: family || 'Helvetica', weight, italic }
}

/**
 * A PostScript name for a face: the real one of the family's face nearest the weight (upright or
 * italic as asked, at most a step of 100 away) when the computer's faces are known, else one put
 * together the way most are ("Helvetica Neue" bold is "HelveticaNeue-Bold", a plain face just the
 * family), which keeps what was asked for where the computer lacks it.
 */
export function postScriptName(face: FontFace): string {
  const candidates = (familyFaces.get(face.family.toLowerCase()) ?? []).filter((entry) => entry.face.italic === face.italic && Math.abs(entry.face.weight - face.weight) <= 100)

  if (candidates.length) {
    return candidates.reduce((best, entry) => (Math.abs(entry.face.weight - face.weight) < Math.abs(best.face.weight - face.weight) ? entry : best)).postscriptName
  }

  const base = face.family.replace(/\s+/g, '')
  const weight = WEIGHT_NAMES[Math.round(Math.max(100, Math.min(900, face.weight)) / 100) * 100] ?? 'Regular'
  const style = weight === 'Regular' ? (face.italic ? 'Italic' : '') : `${weight}${face.italic ? 'Italic' : ''}`

  return style ? `${base}-${style}` : base
}

/** A CSS font for a 2D canvas or a text field. */
export function fontCss(fontName: string, size: number): string {
  const face = fontFace(fontName)
  const family = face.family.replace(/["\\]/g, '')

  return `${face.italic ? 'italic ' : ''}${face.weight} ${size}px "${family}", system-ui, sans-serif`
}

// Layout.

/** Measures text with the style's tracking: `start` is where the text sits in the content, so runs of other faces measure in theirs. */
export interface TextMeasure {
  width(text: string, start?: number): number
  ascent: number
  descent: number
}

export interface TextLine {
  text: string
  /** Where the line starts in the content (UTF-16 units), for the runs it falls in. */
  start: number
  width: number
  /** Where the line starts and its baseline, in the layer's own pixels. */
  x: number
  baseline: number
}

export interface TextLayout {
  /** The layer's box, in its own pixels. */
  width: number
  height: number
  lines: TextLine[]
  lineHeight: number
  /** Room around point text for glyphs that reach past their advance (italics, swashes). */
  pad: number
  /** The point the text hangs from: the first baseline at the alignment edge for point text, the box's top-left for paragraphs. */
  anchor: Vec2
}

export const isParagraph = (style: TextStyle): boolean => Boolean(style.boxSize && style.boxSize[0] > 0)

/** Baseline to baseline: the leading when one is set, 120% of the font size when it is 0 (automatic), as Compositor reads it. */
export const lineHeightOf = (style: TextStyle): number => Math.max(1, style.leading > 0 ? style.leading : style.fontSize * 1.2)

/** Lines broken to fit a width, with where each starts: at spaces where it can, inside a word too long for a line alone. */
export function wrapSegments(text: string, width: number, measure: (text: string, start: number) => number): { text: string; start: number }[] {
  const lines: { text: string; start: number }[] = []
  let at = 0

  for (const paragraph of text.split('\n')) {
    let line = ''
    let lineStart = at
    let offset = at

    for (const word of paragraph.split(/(?<=\s)/)) {
      const candidate = line + word

      if (!line || measure(candidate.trimEnd(), lineStart) <= width) {
        line = candidate
      } else {
        lines.push({ text: line.trimEnd(), start: lineStart })
        line = word
        lineStart = offset
      }

      offset += word.length

      // A word wider than the box breaks between letters.
      while (measure(line.trimEnd(), lineStart) > width && line.trimEnd().length > 1) {
        let cut = line.length - 1

        while (cut > 1 && measure(line.slice(0, cut), lineStart) > width) {
          cut--
        }

        lines.push({ text: line.slice(0, cut), start: lineStart })
        line = line.slice(cut)
        lineStart += cut
      }
    }

    lines.push({ text: line.trimEnd(), start: lineStart })
    at += paragraph.length + 1
  }

  return lines
}

/** Lines broken to fit a width (just their text). */
export const wrapLines = (text: string, width: number, measure: (text: string) => number): string[] => wrapSegments(text, width, (line) => measure(line)).map((line) => line.text)

/** Lay text out: its lines, where each goes, and the layer's box. */
export function layoutText(style: TextStyle, measure: TextMeasure): TextLayout {
  const lineHeight = lineHeightOf(style)
  const paragraph = isParagraph(style)

  if (paragraph) {
    const [boxWidth, boxHeight] = style.boxSize!
    const segments = wrapSegments(style.content, boxWidth, (text, start) => measure.width(text, start))
    const lines = segments.map(({ text, start }, i) => {
      const width = measure.width(text, start)

      return { text, start, width, x: alignedX(style.alignment, boxWidth, width, 0), baseline: measure.ascent + i * lineHeight }
    })
    const fitted = measure.ascent + measure.descent + Math.max(0, lines.length - 1) * lineHeight

    return { width: Math.max(1, Math.round(boxWidth)), height: Math.max(1, Math.round(boxHeight > 0 ? boxHeight : fitted)), lines, lineHeight, pad: 0, anchor: [0, 0] }
  }

  const pad = Math.ceil(style.fontSize * 0.15) + 2
  const texts = style.content.split('\n')
  const starts = texts.map((_, i) => texts.slice(0, i).reduce((sum, line) => sum + line.length + 1, 0))
  const widths = texts.map((text, i) => measure.width(text, starts[i]))
  const textWidth = Math.max(0, ...widths)
  const lines = texts.map((text, i) => ({ text, start: starts[i], width: widths[i], x: pad + alignedX(style.alignment, textWidth, widths[i], 0), baseline: pad + measure.ascent + i * lineHeight }))
  const height = pad * 2 + measure.ascent + measure.descent + (texts.length - 1) * lineHeight

  return {
    width: Math.max(1, Math.ceil(textWidth + pad * 2)),
    height: Math.max(1, Math.ceil(height)),
    lines,
    lineHeight,
    pad,
    anchor: [pad + alignedX(style.alignment, textWidth, 0, 0), pad + measure.ascent]
  }
}

/** Where a line starts in a span of `span` pixels, by alignment (for a zero-width line: the alignment edge). */
function alignedX(alignment: TextAlignment, span: number, width: number, start: number): number {
  return alignment === 'Center' ? start + (span - width) / 2 : alignment === 'Right' ? start + span - width : start
}

/** The layer's top-left when its anchor goes at a document point (a click with the Type tool puts the first baseline there). */
export const originForAnchor = (layout: TextLayout, x: number, y: number): Vec2 => [x - layout.anchor[0], y - layout.anchor[1]]

/** The layer's top-left so its text's top edge sits at `y`, and its alignment edge (left, centre or right) at `x`. */
export const originForTop = (layout: TextLayout, x: number, y: number): Vec2 => [x - layout.anchor[0], y - layout.pad]

// Runs.

/** A piece of a line in one face and one colour. */
export interface TextPiece {
  text: string
  fontName: string
  colour: RGB
}

/** A stretch of content (from `start`) cut where its face or colour changes, by the style's runs. */
export function pieces(style: TextStyle, text: string, start: number): TextPiece[] {
  const end = start + text.length
  const cuts = new Set([start, end])

  for (const run of [...(style.colorRuns ?? []), ...(style.fontRuns ?? [])]) {
    for (const at of [run.location, run.location + run.length]) {
      if (at > start && at < end) {
        cuts.add(at)
      }
    }
  }

  const sorted = [...cuts].sort((a, b) => a - b)
  const inRun = <T extends { location: number; length: number }>(runs: T[] | undefined, at: number) => runs?.find((run) => at >= run.location && at < run.location + run.length)

  return sorted.slice(0, -1).flatMap((from, i) => {
    const to = sorted[i + 1]
    const colour = inRun(style.colorRuns, from) ?? style
    const font = inRun(style.fontRuns, from)

    return to > from ? [{ text: text.slice(from - start, to - start), fontName: font?.fontName ?? style.fontName, colour: { red: colour.red, green: colour.green, blue: colour.blue } }] : []
  })
}

/** Runs kept within the content: sorted, apart, inside it, none empty (what the format accepts). */
function cleanRuns<T extends { location: number; length: number }>(runs: T[] | undefined, length: number): T[] | undefined {
  const out: T[] = []
  let end = 0

  for (const run of [...(runs ?? [])].sort((a, b) => a.location - b.location)) {
    const from = Math.max(run.location, end)
    const to = Math.min(run.location + run.length, length)

    if (to > from) {
      out.push({ ...run, location: from, length: to - from })
      end = to
    }
  }

  return out.length ? out : undefined
}

/**
 * The runs after a text was edited from `before` to `after`: kept where the edit allows. Inserted
 * letters take the run of the letter before them, removed ones take their part of a run with them;
 * a new colour for the whole text lets go of the colour runs, a new font of the font runs.
 */
export function editedRuns(before: TextStyle, after: TextStyle): TextStyle {
  const old = before.content
  const now = after.content
  let prefix = 0

  while (prefix < old.length && prefix < now.length && old[prefix] === now[prefix]) {
    prefix++
  }

  let suffix = 0

  while (suffix < old.length - prefix && suffix < now.length - prefix && old[old.length - 1 - suffix] === now[now.length - 1 - suffix]) {
    suffix++
  }

  const removedEnd = old.length - suffix
  const inserted = now.length - prefix - suffix
  const delta = now.length - old.length
  const startAt = (at: number) => (at < prefix ? at : at >= removedEnd ? at + delta : prefix + inserted)
  const endAt = (at: number) => (at < prefix ? at : at >= removedEnd ? at + delta : prefix)
  const shift = <T extends { location: number; length: number }>(runs: T[] | undefined): T[] | undefined =>
    cleanRuns(
      runs?.map((run) => {
        const location = startAt(run.location)

        return { ...run, location, length: endAt(run.location + run.length) - location }
      }),
      now.length
    )
  const recoloured = after.red !== before.red || after.green !== before.green || after.blue !== before.blue
  const refaced = after.fontName !== before.fontName
  const colorRuns = recoloured ? undefined : shift(after.colorRuns ?? before.colorRuns)
  const fontRuns = refaced ? undefined : shift(after.fontRuns ?? before.fontRuns)
  const out: TextStyle = { ...after }
  delete out.colorRuns
  delete out.fontRuns

  return { ...out, ...(colorRuns ? { colorRuns } : {}), ...(fontRuns ? { fontRuns } : {}) }
}

// Drawing.

/** A measure for a style, from a 2D context (an offscreen canvas in the window); font runs measure in their own faces. */
export function canvasMeasure(context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, style: TextStyle): TextMeasure {
  const base = fontCss(style.fontName, style.fontSize)
  context.font = base
  context.letterSpacing = `${style.tracking}px`
  const metrics = context.measureText('Hgjy')
  const ascent = metrics.fontBoundingBoxAscent || style.fontSize * 0.8
  const descent = metrics.fontBoundingBoxDescent || style.fontSize * 0.25

  return {
    width: (text, start = 0) => {
      if (!text) {
        return 0
      }

      if (!style.fontRuns?.length) {
        context.font = base

        return context.measureText(text).width
      }

      return pieces(style, text, start).reduce((sum, piece) => {
        context.font = fontCss(piece.fontName, style.fontSize)

        return sum + context.measureText(piece.text).width
      }, 0)
    },
    ascent,
    descent
  }
}

let measuring: OffscreenCanvasRenderingContext2D | null = null

/** Measure with a shared offscreen canvas (the window only). */
export function measureFor(style: TextStyle): TextMeasure {
  measuring ??= new OffscreenCanvas(1, 1).getContext('2d')!

  return canvasMeasure(measuring, style)
}

/** Make sure a face is loaded before drawing with it (system fonts are; web fonts may not be yet), its runs' faces too. */
export async function loadFont(style: TextStyle): Promise<void> {
  const faces = new Set([style.fontName, ...(style.fontRuns ?? []).map((run) => run.fontName)])
  await Promise.all([...faces].map((face) => globalThis.document?.fonts?.load(fontCss(face, style.fontSize)).catch(() => [])))
}

/** How many colours a text may have and still have each one restored exactly at its glyphs' soft edges. */
const SNAPPED_COLOURS = 32

/**
 * The text drawn at `scale` (pixels per layer pixel: a layer scaled up draws its text larger, so
 * it stays sharp). Each piece of a line in its own face and colour; every pixel then takes the
 * nearest of the text's colours exactly, so colour stays true where antialiasing thins the alpha.
 */
export function renderText(style: TextStyle, layout: TextLayout, scale: Vec2 = [1, 1]): Raster {
  const width = Math.max(1, Math.round(layout.width * scale[0]))
  const height = Math.max(1, Math.round(layout.height * scale[1]))
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  context.scale(width / layout.width, height / layout.height)
  context.letterSpacing = `${style.tracking}px`
  context.textBaseline = 'alphabetic'
  const palette = new Map<string, RGB>()

  for (const line of layout.lines) {
    let x = line.x

    for (const piece of pieces(style, line.text, line.start)) {
      const [r, g, b] = [piece.colour.red, piece.colour.green, piece.colour.blue].map((value) => Math.round(value * 255))
      palette.set(`${r},${g},${b}`, { red: r, green: g, blue: b })
      context.font = fontCss(piece.fontName, style.fontSize)
      context.fillStyle = `rgb(${r} ${g} ${b})`
      context.fillText(piece.text, x, line.baseline)
      x += context.measureText(piece.text).width
    }
  }

  const raster = new Raster(width, height, 4, context.getImageData(0, 0, width, height).data)
  const colours = [...palette.values()]

  if (colours.length === 1 || !colours.length) {
    const only = colours[0] ?? { red: Math.round(style.red * 255), green: Math.round(style.green * 255), blue: Math.round(style.blue * 255) }
    tint(raster, only.red, only.green, only.blue)
  } else if (colours.length <= SNAPPED_COLOURS) {
    snapColours(raster, colours)
  }

  return raster
}

/** Every pixel's colour set to the nearest of a few colours, its alpha kept. */
function snapColours(raster: Raster, colours: RGB[]): void {
  const { data } = raster

  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) {
      continue
    }

    let best = colours[0]
    let bestDistance = Infinity

    for (const colour of colours) {
      const distance = (data[i] - colour.red) ** 2 + (data[i + 1] - colour.green) ** 2 + (data[i + 2] - colour.blue) ** 2

      if (distance < bestDistance) {
        bestDistance = distance
        best = colour
      }
    }

    data[i] = best.red
    data[i + 1] = best.green
    data[i + 2] = best.blue
  }
}

/** One colour over a raster's alpha. */
export function tint(raster: Raster, r: number, g: number, b: number): void {
  const { data } = raster

  for (let i = 0; i < data.length; i += 4) {
    data[i] = r
    data[i + 1] = g
    data[i + 2] = b
  }
}

/** A text style with what is not given filled in. */
export function textStyle(patch: Partial<TextStyle> & { content: string }): TextStyle {
  return { fontName: 'Helvetica', fontSize: 72, red: 0, green: 0, blue: 0, alignment: 'Left', tracking: 0, leading: 0, ...patch }
}
