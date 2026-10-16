/*
 * What Veritas Canvas asks Hermes for: generative fill, a generated layer, and an edit planned from
 * a description. Hermes works through its own tools (its image generation tool, the canvas tool),
 * so each request says exactly which project, box and files to use, how to place the result, and
 * what to do when it has no image generation tool. Pure, so the wording is tested.
 */

import type { Rect } from '../engine/raster.ts'

export type Aspect = 'landscape' | 'square' | 'portrait'

/** The image tool's aspect nearest a box: landscape is 16:9, portrait 9:16. */
export function aspectFor(width: number, height: number): Aspect {
  const ratio = width / Math.max(1, height)

  return ratio >= 1.33 ? 'landscape' : ratio <= 0.75 ? 'portrait' : 'square'
}

/** The box generative fill works in: the selection with room around it (a quarter of its size each way, at least 32 pixels), cut to the canvas. */
export function generationBox(bounds: Rect, width: number, height: number): Rect {
  const marginX = Math.max(32, Math.round(bounds.width / 4))
  const marginY = Math.max(32, Math.round(bounds.height / 4))
  const x = Math.max(0, bounds.x - marginX)
  const y = Math.max(0, bounds.y - marginY)

  return { x, y, width: Math.min(width, bounds.x + bounds.width + marginX) - x, height: Math.min(height, bounds.y + bounds.height + marginY) - y }
}

export interface ImageContext {
  /** The .comp project, or null when the image has not been saved (then it is the one in front). */
  project: string | null
  name: string
  width: number
  height: number
}

const quoted = (text: string): string => JSON.stringify(text)

/** Where commands find the image: its project, or the one in front. */
const projectArg = (image: ImageContext): string => (image.project ? ` project=${quoted(image.project)}` : '')

const describeImage = (image: ImageContext): string => `${quoted(image.name)} (${image.project ? `project ${image.project}` : 'not saved yet: the image in front, so leave project out'}, ${image.width}×${image.height} pixels)`

/** A short name for a layer made from a prompt. */
export function promptName(prompt: string, fallback: string): string {
  const words = prompt.trim().replace(/\s+/g, ' ')

  return words ? (words.length > 40 ? `${words.slice(0, 39)}…` : words) : fallback
}

const NO_IMAGE_TOOL =
  'If you have no image generation tool, or it fails, say so plainly in one sentence and place nothing; do not draw the picture another way. To remove something instead, the person can use Edit > Content-Aware Fill, which works on this computer.'

export interface GenerativeFill {
  image: ImageContext
  prompt: string
  /** The area to generate, in canvas pixels: the selection with some room around it. */
  box: Rect
  /** A picture of that area as it is now, and its mask (white is to be filled), saved for Hermes. */
  context: string
  mask: string
  /** Where Hermes saves what it makes. */
  result: string
}

export function generativeFillRequest(request: GenerativeFill): string {
  const { image, box } = request
  const what = request.prompt.trim()
  const name = `Generative Fill: ${promptName(what, 'fill')}`

  return [
    `In Veritas Canvas the person selected part of ${describeImage(image)} and asked for generative fill: ${what ? quoted(what) : 'nothing in particular, so carry on what is around the selection'}.`,
    '',
    `1. Look at ${request.context}: the area as it is now (${box.width}×${box.height} pixels from x ${box.x}, y ${box.y}), and ${request.mask}, white where the new picture goes.`,
    `2. Make the picture with your image generation tool, aspect_ratio "${aspectFor(box.width, box.height)}". If the tool can edit an image (it takes an image_url), give it ${request.context} and describe the change; otherwise describe the whole area so it matches the surroundings (light, perspective, colour, grain).`,
    `3. Save the picture as a PNG at ${request.result} (download it first if the tool answers with an address).`,
    `4. Place it, masked to the selection: canvas action=place_image${projectArg(image)} source=${quoted(request.result)} x=${box.x} y=${box.y} width=${box.width} height=${box.height} fit=cover mask_image=${quoted(request.mask)} name=${quoted(name)}`,
    '5. Check it with canvas action=preview, then tell the person in a sentence or two what you made. It is one layer they can hide, mask or undo.',
    '',
    NO_IMAGE_TOOL
  ].join('\n')
}

export interface GeneratedLayer {
  image: ImageContext
  prompt: string
  /** Where it goes (the selection's box), or null for the whole canvas. */
  box: Rect | null
  result: string
}

export function generatedLayerRequest(request: GeneratedLayer): string {
  const { image, box } = request
  const area = box ?? { x: 0, y: 0, width: image.width, height: image.height }
  const placement = box ? ` x=${box.x} y=${box.y} width=${box.width} height=${box.height} fit=contain` : ' fit=contain'

  return [
    `In Veritas Canvas the person asked for a new generated layer in ${describeImage(image)}: ${quoted(request.prompt.trim())}.`,
    '',
    `1. Make the picture with your image generation tool, aspect_ratio "${aspectFor(area.width, area.height)}" (${box ? `it goes in a ${box.width}×${box.height} box at x ${box.x}, y ${box.y}` : 'it fills the canvas'}). If the picture should stand on its own (a logo, an object, a sticker), ask for a plain background the person can remove with Layer > Remove Background.`,
    `2. Save it as a PNG at ${request.result} (download it first if the tool answers with an address).`,
    `3. Place it: canvas action=place_image${projectArg(image)} source=${quoted(request.result)}${placement} name=${quoted(promptName(request.prompt, 'Generated layer'))}`,
    '4. Check it with canvas action=preview, then tell the person in a sentence or two what you made.',
    '',
    NO_IMAGE_TOOL
  ].join('\n')
}

export interface EditRequest {
  image: ImageContext
  request: string
  /** The layers, top to bottom, one line each. */
  layers: string[]
  selection: Rect | null
  /** A flattened picture of the image as it is now. */
  preview: string | null
}

export function editRequest(edit: EditRequest): string {
  const { image } = edit
  const shown = edit.layers.slice(0, 30)

  return [
    `In Veritas Canvas the person is working on ${describeImage(image)} and asks: ${quoted(edit.request.trim())}.`,
    '',
    'Layers, top to bottom:',
    ...shown.map((line) => `- ${line}`),
    ...(edit.layers.length > shown.length ? [`- …and ${edit.layers.length - shown.length} more (canvas action=layers lists them all)`] : []),
    ...(edit.selection ? [`The person has selected ${edit.selection.width}×${edit.selection.height} pixels from x ${edit.selection.x}, y ${edit.selection.y}.`] : []),
    ...(edit.preview ? [`The image as it is now: ${edit.preview}`] : []),
    '',
    `Plan the edit, then make it with the canvas tool${image.project ? ` on project=${quoted(image.project)}` : ''} (read skill_view name="herald-os-bridge:herald-canvas" first if you have not yet):`,
    '- Prefer adjustment layers, masks and layer effects to changing pixels, so every step stays editable; clip an adjustment to one layer when only that layer should change.',
    '- Look at the image with canvas action=preview before you start and again when you are done, and fix what is off.',
    '- Name new layers for what they are. Each change is one step the person can undo.',
    '- When you are done, tell the person briefly what you changed and why.'
  ].join('\n')
}

/** One layer the way the edit request lists it: "Headline: text, 80%, Multiply". */
export function layerLine(layer: Record<string, unknown>): string {
  const marks: string[] = [String(layer.kind)]

  if (layer.adjustment) marks.push(String(layer.adjustment))
  if (layer.visible === false) marks.push('hidden')
  if (typeof layer.opacity === 'number' && layer.opacity < 1) marks.push(`${Math.round(layer.opacity * 100)}%`)
  if (layer.blend && layer.blend !== 'Normal' && layer.blend !== 'Pass Through') marks.push(String(layer.blend))
  if (layer.clippedTo) marks.push(`clipped to ${String(layer.clippedTo)}`)
  if (layer.mask) marks.push(`mask ${String(layer.mask)}`)
  if (layer.folder) marks.push(`in ${String(layer.folder)}`)

  return `${String(layer.name)}: ${marks.join(', ')}`
}
