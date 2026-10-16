/*
 * What Hermes (and the command bar, voice and the CLI) does in Veritas Canvas. A command works on a
 * project: the one it names, or the image in front. When that project is open in this window the
 * change lands in the open document (one undoable step, saved right after); otherwise it is read
 * from disk, changed and written back, and any window showing it reloads.
 */

import {
  ADJUSTMENT_KINDS,
  defaultAdjustment,
  defaultHeraldAdjustment,
  defaultTransform,
  HERALD_ADJUSTMENT_KINDS,
  type HeraldAdjustment,
  isHeraldKind,
  LIMITS,
  RANGES,
  type ShapeStyle,
  type TextStyle
} from '../../../shared/canvas/comp-format.ts'
import { baseName, CANVAS_IMAGE_EXTENSIONS, isLayeredImage, isProjectPath, PROJECT_EXTENSION } from '../../../shared/canvas/files.ts'
import { $env } from '../../store/backend.ts'
import { isPanels } from '../../store/shell.ts'
import {
  adjustmentWith,
  alignEdgesFrom,
  alignFrom,
  alignToFrom,
  autoModeFrom,
  backgroundModeFrom,
  blendFrom,
  cropPlan,
  describeHistory,
  describeLayer,
  describeLayers,
  distributeFrom,
  effectKindFrom,
  effectsWith,
  fillBox,
  filterKindFrom,
  findByRef,
  finite,
  fitPicture,
  fontNameFrom,
  fractionFrom,
  gradientStopsFrom,
  gradientStyleFrom,
  guideAxisFrom,
  heraldWith,
  holeBox,
  jsonObject,
  lineEnds,
  maskActionFrom,
  maskPart,
  opacityFrom,
  pictureFitFrom,
  placementOf,
  rangedArg,
  resizePlan,
  resolvePath,
  shapeKindFrom,
  shapeWith,
  stepCount,
  stepThrough
} from './agent-model.ts'
import { autoAdjustState } from './auto-adjust.ts'
import { ALIGN_LABELS, alignState, DISTRIBUTE_LABELS, distributeState, movableLayers } from './engine/align.ts'
import { AUTO_LABELS } from './engine/auto-levels.ts'
import { type ColorTable, parseCube } from './engine/color-table.ts'
import { paintGradient } from './engine/fill.ts'
import { checkFilter, FILTER_NAMES } from './engine/filters.ts'
import { pixelToDocument } from './engine/geometry.ts'
import { type ColourStop, type Gradient, type GradientStyle, gradientTable, lineAcross } from './engine/gradient.ts'
import { guideNear, layoutGuides, onCanvas, positionFrom, withGuides, withoutGuides } from './engine/guides.ts'
import { heraldLayer, heraldOf, withVeritas } from './engine/herald-adjust.ts'
import { coverageReader } from './engine/sampling.ts'
import { filterArea, filterTargetArea, mixInto } from './filter-run.ts'
import { anchorOffset, cropCanvas, resizeCanvas, rotateLayers, scaleImage } from './engine/canvas-size.ts'
import {
  adjustmentLayer,
  blankLayer,
  type CanvasDocument,
  type CanvasLayer,
  childrenOf,
  type DocState,
  findLayer,
  folderLayer,
  groupLayers,
  insertLayer,
  moveLayer,
  nextName,
  pixelLayer,
  type Placement,
  removeLayers,
  setClipped,
  withLayer
} from './engine/document.ts'
import { EFFECT_NAMES, knownEffects, withEffectsFrom, withoutKnownEffects } from './engine/layer-effects.ts'
import { MASK_LABELS, withMaskAction } from './engine/masks.ts'
import { documentFromImage, type ExportKind, exportImage, flatten, newDocument, openProject, readPicture, saveProject, toRaster } from './engine/project.ts'
import { Raster, type Rect, resample } from './engine/raster.ts'
import { shapeBox, shapeName } from './engine/shapes.ts'
import { textStyle } from './engine/text.ts'
import { openInCanvas } from './open.ts'
import { renderLayers } from './tools/screen.ts'
import { makeShapeLayer, makeTextLayer, restyleShape, restyleText } from './text-layers.ts'

export interface Target {
  doc: CanvasDocument
  /** Open in this window (edits go into it), rather than read from disk for this command. */
  live: boolean
}

const store = () => import('./store.ts')

/** A file's name with its extension, for what Hermes says back. */
const fileName = (file: string): string => file.split('/').pop() || file

// --- Paths and projects ------------------------------------------------------------------------

/** A full path from what Hermes or the person typed (`~/…` works). */
const resolve = (input: string): string => resolvePath(input, $env.get()?.homeDir ?? '')

/** The project in front of the person: the active document of the Canvas window used last. */
export async function currentProject(): Promise<string | null> {
  const windows = await window.heraldOS.canvas.presence()

  for (const entry of windows) {
    const active = entry.documents.find((doc) => doc.key === entry.active) ?? entry.documents[0]

    if (active?.path) {
      return active.path
    }
  }

  return null
}

export async function target(project?: unknown): Promise<Target> {
  const { $documents, activeDocument } = await store()
  const named = typeof project === 'string' && project.trim() ? resolve(project) : null

  if (named) {
    if (!isProjectPath(named)) {
      throw new Error(`${baseName(named)} is not a Veritas Canvas project (a folder ending in ${PROJECT_EXTENSION}); open it with canvas.open first`)
    }

    const open = $documents.get().find((doc) => doc.path === named)

    if (open) {
      return { doc: open, live: true }
    }

    if (!(await window.heraldOS.canvas.exists(named))) {
      throw new Error(`There is no project at ${named}`)
    }

    return { doc: await openProject(named), live: false }
  }

  const active = activeDocument()

  if (active) {
    return { doc: active, live: true }
  }

  const current = await currentProject()

  if (current) {
    return target(current)
  }

  throw new Error('No image is open in Veritas Canvas: open one (canvas.open) or start one (canvas.new)')
}

/** Record a change as one undoable step (marked as a command's in the History panel), and save it where it lives. */
export async function apply(on: Target, label: string, next: DocState): Promise<void> {
  const before = on.doc.history.position
  on.doc.commit(label, next)

  if (on.doc.history.position !== before) {
    on.doc.history.tagLast('command')
  }

  if (!on.doc.path) {
    return
  }

  if (on.live) {
    const { $autosave, save } = await store()

    // The person turned saving off: the change waits in the window like their own edits.
    if ($autosave.get()) {
      await save(on.doc)
    }
  } else {
    await saveProject(on.doc)
  }
}

/** A name for a new project that is not taken yet in a folder ("Poster", "Poster 2", …). */
export async function freeProjectPath(folder: string, name: string): Promise<string> {
  const clean = name.replace(/[/\\:]/g, '-').replace(/\.comp$/i, '').trim() || 'Untitled'

  for (let n = 1; n < 1000; n++) {
    const candidate = `${folder}/${n === 1 ? clean : `${clean} ${n}`}${PROJECT_EXTENSION}`

    if (!(await window.heraldOS.canvas.exists(candidate))) {
      return candidate
    }
  }

  throw new Error(`Too many projects called ${clean} in ${folder}`)
}

// --- Making pixels -----------------------------------------------------------------------------

let colorContext: OffscreenCanvasRenderingContext2D | null = null

/** Any CSS colour ("#ff8800", "tomato", "rgb(10 20 30 / 50%)") as RGBA bytes. */
export function parseColor(input: unknown): [number, number, number, number] {
  const text = String(input ?? '').trim()

  if (!text) {
    throw new Error('Give a colour, like #ff8800 or "tomato"')
  }

  colorContext ??= new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })!
  colorContext.clearRect(0, 0, 1, 1)
  colorContext.fillStyle = '#010203'
  colorContext.fillStyle = text

  // An unknown colour leaves the marker in place.
  if (colorContext.fillStyle === '#010203' && !/^#?010203$/i.test(text)) {
    throw new Error(`“${text}” is not a colour`)
  }

  colorContext.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = colorContext.getImageData(0, 0, 1, 1).data

  return [r, g, b, a]
}

/**
 * A gradient filling a box: colours with optional positions as text ("#000 0%, #fff 70%"), in a
 * style, at an angle in degrees (0 runs left to right, 90 top to bottom).
 */
export function gradientRaster(width: number, height: number, text: string, style: GradientStyle = 'linear', angle = 90): Raster {
  const stops = gradientStopsFrom(text).map((entry) => ({ at: entry.at, rgba: parseColor(entry.colour) }))
  const shows = (entry: (typeof stops)[number]) => entry.rgba[3] > 0
  const rgb = (entry: (typeof stops)[number]): [number, number, number] => [entry.rgba[0], entry.rgba[1], entry.rgba[2]]
  const colours: ColourStop[] = []

  // A clear stop mixes towards the colours either side of it, as CSS mixes, so a fade keeps its colour.
  stops.forEach((entry, i) => {
    if (shows(entry)) {
      colours.push({ at: entry.at, colour: rgb(entry), mid: 0.5 })

      return
    }

    const before = stops.slice(0, i).reverse().find(shows) ?? stops.slice(i + 1).find(shows) ?? entry
    const after = stops.slice(i + 1).find(shows) ?? before
    colours.push({ at: entry.at, colour: rgb(before), mid: 0.5 }, { at: entry.at, colour: rgb(after), mid: 0.5 })
  })

  const gradient: Gradient = { name: 'Gradient', colours, opacities: stops.map((entry) => ({ at: entry.at, opacity: entry.rgba[3] / 255, mid: 0.5 })) }
  const raster = new Raster(width, height)
  const line = lineAcross(style, { x: 0, y: 0, width, height }, angle)
  paintGradient(raster, raster.bounds, pixelToDocument(defaultTransform(width, height), width, height), { ...line, table: gradientTable(gradient, [0, 0, 0], [255, 255, 255]) }, () => 1)

  return raster
}

/** An image for a layer: a file, an http(s) address, or a data: URL. */
export async function loadImage(source: string): Promise<Raster> {
  if (/^https?:\/\//i.test(source)) {
    const fetched = await window.heraldOS.canvas.fetchImage(source)

    return toRaster(fetched.image, 4, fetched.svg)
  }

  if (source.startsWith('data:')) {
    const response = await fetch(source)

    return toRaster(new Uint8Array(await response.arrayBuffer()), 4, source.startsWith('data:image/svg'))
  }

  const file = resolve(source)
  const extension = /(\.[^./]+)$/.exec(file)?.[1]?.toLowerCase() ?? ''

  if (!CANVAS_IMAGE_EXTENSIONS.has(extension)) {
    throw new Error(`Veritas Canvas does not read ${extension || 'that kind of file'}`)
  }

  return readPicture(file)
}

// --- Commands ----------------------------------------------------------------------------------

export interface Outcome {
  summary: string
  data?: Record<string, unknown>
}

/** Where a new layer goes: above a layer, into a folder, or above the active one. */
function placementFrom(state: DocState, args: Record<string, unknown>): Placement {
  if (args.above !== undefined && args.above !== '') {
    return { above: findByRef(state, args.above).id }
  }

  if (args.folder !== undefined && args.folder !== '') {
    const folder = findByRef(state, args.folder)

    if (!folder.isGroup) {
      throw new Error(`${folder.name} is not a folder`)
    }

    return { parentID: folder.id }
  }

  const active = findLayer(state, state.activeLayerId)

  return active ? (active.isGroup ? { parentID: active.id } : { above: active.id }) : {}
}

/** Show a project in Canvas. In this window, wait until it is open, so the next command edits it there. */
async function show(file: string): Promise<void> {
  if (isPanels) {
    openInCanvas(file)

    return
  }

  const { openPath } = await store()
  await openPath(file)
  openInCanvas()
}

/** Show the project (or Canvas itself) to the person. */
export async function open(path: unknown): Promise<Outcome> {
  if (typeof path !== 'string' || !path.trim()) {
    openInCanvas()

    return { summary: 'Opened Veritas Canvas' }
  }

  const file = resolve(path)

  if (!(await window.heraldOS.canvas.exists(file))) {
    throw new Error(`Nothing at ${file}`)
  }

  if (isProjectPath(file)) {
    await show(file)

    return { summary: `Opened ${baseName(file)} in Veritas Canvas`, data: { path: file } }
  }

  // An image becomes a project beside the others, so edits never touch the original; a Photoshop document keeps its layers.
  const { doc, notes } = isLayeredImage(file) ? await (await import('./psd/psd.ts')).documentFromPsd(file) : { doc: await documentFromImage(file), notes: [] as string[] }
  const project = await freeProjectPath(resolve('~/Pictures/Veritas Canvas'), baseName(file))
  await saveProject(doc, project)
  await show(project)

  return {
    summary: `Opened ${fileName(file)} in Veritas Canvas as ${baseName(project)} (the original is untouched)${notes.length ? `. Approximated: ${notes.join('; ')}` : ''}`,
    data: { path: project, source: file, width: doc.state.width, height: doc.state.height, layers: doc.state.layers.length, ...(notes.length ? { notes } : {}) }
  }
}

export async function create(args: Record<string, unknown>): Promise<Outcome> {
  const width = Math.round(finite(args.width) ?? 1920)
  const height = Math.round(finite(args.height) ?? 1080)

  if (width < 1 || height < 1 || width > LIMITS.side || height > LIMITS.side || width * height > LIMITS.sourcePixels) {
    throw new Error(`A canvas is 1 to ${LIMITS.side.toLocaleString()} pixels a side, ${(LIMITS.sourcePixels / 1e6).toLocaleString()} million in all`)
  }

  const background = (['white', 'black', 'transparent'] as const).find((kind) => kind === args.background) ?? 'white'
  const folder = resolve(typeof args.folder === 'string' && args.folder.trim() ? args.folder : '~/Pictures/Veritas Canvas')
  const file = await freeProjectPath(folder, typeof args.name === 'string' ? args.name : 'Untitled')
  const doc = newDocument(width, height, background, Math.round(finite(args.resolution) ?? 72))

  // A colour other than the three plain backgrounds fills the first layer.
  if (typeof args.background === 'string' && !['white', 'black', 'transparent'].includes(args.background)) {
    const layer = pixelLayer('Background', Raster.filled(width, height, parseColor(args.background)))
    doc.state = { ...doc.state, layers: [layer], activeLayerId: layer.id }
  }

  await saveProject(doc, file)
  await show(file)

  return { summary: `Made ${baseName(file)} (${width}×${height}) and opened it`, data: { path: file, width, height } }
}

export async function status(): Promise<Outcome> {
  const windows = await window.heraldOS.canvas.presence()
  const { $documents, activeDocument } = await store()
  // Desktop mode: this window holds the Canvas documents (even while the window is closed), and
  // knows them better than its last report; other windows' reports fill in the rest.
  const documents = $documents.get().map((doc) => ({ key: doc.key, path: doc.path, name: doc.name, width: doc.state.width, height: doc.state.height, modified: doc.modified, layers: doc.state.layers.length, active: doc === activeDocument() }))

  for (const entry of windows) {
    for (const doc of entry.documents) {
      if (!documents.some((known) => known.key === doc.key)) {
        documents.push({ ...doc, active: doc.key === entry.active && !documents.some((known) => known.active) })
      }
    }
  }

  const current = documents.find((doc) => doc.active) ?? documents[0]

  return {
    summary: documents.length ? `${documents.length} image${documents.length === 1 ? '' : 's'} open${current ? `; in front: ${current.name}` : ''}` : 'Nothing is open in Veritas Canvas',
    data: { documents: documents.map(({ key: _key, ...doc }) => doc), current: current?.path ?? null }
  }
}

export async function layers(project: unknown): Promise<Outcome> {
  const on = await target(project)
  const { state } = on.doc

  return {
    summary: `${on.doc.name}: ${state.width}×${state.height}, ${state.layers.length} layer${state.layers.length === 1 ? '' : 's'}`,
    data: {
      path: on.doc.path,
      name: on.doc.name,
      width: state.width,
      height: state.height,
      resolution: state.resolution,
      active: findLayer(state, state.activeLayerId)?.name ?? null,
      layers: describeLayers(state)
    }
  }
}

export async function addLayer(args: Record<string, unknown>): Promise<Outcome> {
  const on = await target(args.project)
  const { state } = on.doc
  const canvas = { width: state.width, height: state.height }
  let layer: CanvasLayer

  if (typeof args.source === 'string' && args.source.trim()) {
    const raster = await loadImage(args.source.trim())
    const box = placementOf(raster.width, raster.height, canvas, args)
    const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : /^https?:|^data:/.test(args.source) ? nextName(state, 'Image') : baseName(args.source)
    layer = pixelLayer(name, raster, defaultTransform(box.width, box.height, box.x, box.y))
  } else if (typeof args.gradient === 'string' && args.gradient.trim()) {
    const box = fillBox(canvas, args)
    const raster = gradientRaster(box.width, box.height, args.gradient, gradientStyleFrom(args.style), finite(args.angle) ?? 90)
    layer = pixelLayer(typeof args.name === 'string' && args.name.trim() ? args.name.trim() : nextName(state, 'Gradient'), raster, defaultTransform(box.width, box.height, box.x, box.y))
  } else if (args.color !== undefined && args.color !== '') {
    const box = fillBox(canvas, args)
    layer = pixelLayer(typeof args.name === 'string' && args.name.trim() ? args.name.trim() : nextName(state, 'Fill'), Raster.filled(box.width, box.height, parseColor(args.color)), defaultTransform(box.width, box.height, box.x, box.y))
  } else {
    layer = blankLayer(typeof args.name === 'string' && args.name.trim() ? args.name.trim() : nextName(state), state.width, state.height)
  }

  layer = { ...layer, opacity: opacityFrom(args.opacity) ?? 1, blendMode: blendFrom(args.blend) ?? 'Normal' }
  let next = insertLayer(state, layer, placementFrom(state, args))

  if (args.clip === true) {
    next = setClipped(next, layer.id, true)
  }

  await apply(on, 'Add Layer', next)

  return { summary: `Added “${layer.name}” to ${on.doc.name}`, data: { layer: describeLayer(on.doc.state, findLayer(on.doc.state, layer.id)!) } }
}

export async function setLayer(args: Record<string, unknown>): Promise<Outcome> {
  const on = await target(args.project)
  const layer = findByRef(on.doc.state, args.layer)
  const patch: Partial<CanvasLayer> = {}
  const changes: string[] = []

  if (typeof args.name === 'string' && args.name.trim()) {
    patch.name = args.name.trim()
    changes.push('renamed')
  }

  if (typeof args.visible === 'boolean') {
    patch.isVisible = args.visible
    changes.push(args.visible ? 'shown' : 'hidden')
  }

  const opacity = opacityFrom(args.opacity)

  if (opacity !== undefined) {
    patch.opacity = opacity
    changes.push(`opacity ${Math.round(opacity * 100)}%`)
  }

  const blend = blendFrom(args.blend)

  if (blend && !layer.isGroup) {
    patch.blendMode = blend
    changes.push(blend)
  }

  const transform = { ...layer.transform }
  const [x, y, width, height, rotation] = [rangedArg(args.x, 'x', 'position'), rangedArg(args.y, 'y', 'position'), rangedArg(args.width, 'width', 'layerSize', ' pixels'), rangedArg(args.height, 'height', 'layerSize', ' pixels'), finite(args.rotation)]

  if (x !== undefined || y !== undefined || width !== undefined || height !== undefined || rotation !== undefined || typeof args.flipX === 'boolean' || typeof args.flipY === 'boolean') {
    // A size given on one side keeps the proportions.
    const ratio = transform.size[0] / Math.max(1e-6, transform.size[1])
    const newWidth = width ?? (height !== undefined ? height * ratio : transform.size[0])
    const newHeight = height ?? (width !== undefined ? width / ratio : transform.size[1])
    const [least, most] = RANGES.layerSize
    transform.origin = [x ?? transform.origin[0], y ?? transform.origin[1]]
    transform.size = [Math.min(most, Math.max(least, newWidth)), Math.min(most, Math.max(least, newHeight))]
    transform.rotation = rotation ?? transform.rotation
    transform.flipX = typeof args.flipX === 'boolean' ? args.flipX : transform.flipX
    transform.flipY = typeof args.flipY === 'boolean' ? args.flipY : transform.flipY
    patch.transform = transform
    changes.push('placed')
  }

  let next = Object.keys(patch).length ? withLayer(on.doc.state, layer.id, patch) : on.doc.state

  if (typeof args.clip === 'boolean') {
    next = setClipped(next, layer.id, args.clip)
    changes.push(args.clip ? 'clipped to the layer below' : 'unclipped')
  }

  if (typeof args.order === 'string' && args.order) {
    const current = findLayer(next, layer.id)!
    const siblings = childrenOf(next, current.parentID)
    const index = siblings.indexOf(current)
    const to = { up: index + 1, down: index - 1, top: siblings.length - 1, bottom: 0 }[args.order]

    if (to === undefined) {
      throw new Error('order is up, down, top or bottom')
    }

    next = moveLayer(next, layer.id, current.parentID, Math.max(0, Math.min(siblings.length - 1, to)))
    changes.push(`moved ${args.order}`)
  }

  if (typeof args.folder === 'string' && args.folder) {
    const into = args.folder.toLowerCase() === 'none' || args.folder.toLowerCase() === 'root' ? undefined : findByRef(next, args.folder)

    if (into && !into.isGroup) {
      throw new Error(`${into.name} is not a folder`)
    }

    next = moveLayer(next, layer.id, into?.id, childrenOf(next, into?.id).filter((entry) => entry.id !== layer.id).length)
    changes.push(into ? `into ${into.name}` : 'out of its folder')
  }

  if (!changes.length) {
    throw new Error('Nothing to change: give name, visible, opacity, blend, x, y, width, height, rotation, flipX, flipY, clip, order or folder')
  }

  await apply(on, 'Layer Change', next)

  return { summary: `${layer.name}: ${changes.join(', ')}`, data: { layer: describeLayer(on.doc.state, findLayer(on.doc.state, layer.id)!) } }
}

export async function removeLayer(args: Record<string, unknown>): Promise<Outcome> {
  const on = await target(args.project)
  const layer = findByRef(on.doc.state, args.layer)
  await apply(on, 'Delete Layer', removeLayers(on.doc.state, [layer.id]))

  return { summary: `Removed “${layer.name}”${layer.isGroup ? ' and what was in it' : ''}` }
}

export async function group(args: Record<string, unknown>): Promise<Outcome> {
  const on = await target(args.project)
  const { state } = on.doc
  const refs = String(args.layers ?? '')
    .split(',')
    .map((ref) => ref.trim())
    .filter(Boolean)
  const folder = folderLayer(typeof args.name === 'string' && args.name.trim() ? args.name.trim() : nextName(state, 'Folder'), state.width, state.height)
  const next = refs.length ? groupLayers(state, refs.map((ref) => findByRef(state, ref).id), folder) : insertLayer(state, folder, placementFrom(state, args))
  await apply(on, refs.length ? 'Group Layers' : 'New Folder', next)

  return { summary: refs.length ? `Put ${refs.length} layer${refs.length === 1 ? '' : 's'} in “${folder.name}”` : `Added the folder “${folder.name}”`, data: { folder: folder.id } }
}

/** A Color Lookup's table from a `.cube` file Hermes named, with the settings it gives (its name and size). */
async function tableFrom(file: unknown): Promise<{ table: ColorTable; name: string; size: number }> {
  const path = resolve(String(file))
  const table = parseCube(await window.heraldOS.canvas.readTable(path))

  return { table, name: fileName(path), size: table.size }
}

/** Veritas-only settings changed by what Hermes gave, with the table its `table` file holds. */
async function heraldChanged(current: HeraldAdjustment, settings: Record<string, unknown>): Promise<{ settings: HeraldAdjustment; table?: ColorTable }> {
  const next = heraldWith(current, settings, readColour)

  if (settings.table === undefined || settings.table === '') {
    return { settings: next }
  }

  if (next.kind !== 'Color Lookup') {
    throw new Error(`table is a Color Lookup's .cube file; ${next.kind} has no table`)
  }

  const { table, name, size } = await tableFrom(settings.table)

  return { settings: { ...next, name, size }, table }
}

export async function addAdjustment(args: Record<string, unknown>): Promise<Outcome> {
  const on = await target(args.project)
  const { state } = on.doc
  const asked = String(args.kind ?? '').toLowerCase()
  const kind = [...ADJUSTMENT_KINDS, ...HERALD_ADJUSTMENT_KINDS].find((entry) => entry.toLowerCase() === asked)

  if (!kind) {
    throw new Error(`Adjustments: ${[...ADJUSTMENT_KINDS, ...HERALD_ADJUSTMENT_KINDS].join(', ')}`)
  }

  const settings = jsonObject(args.settings, 'settings', '{"saturation": 20}')
  const appearance = { ...(typeof args.name === 'string' && args.name.trim() ? { name: args.name.trim() } : {}), opacity: opacityFrom(args.opacity) ?? 1, blendMode: blendFrom(args.blend) ?? 'Normal' }
  let layer: CanvasLayer

  if (isHeraldKind(kind)) {
    const changed = await heraldChanged(defaultHeraldAdjustment(kind), settings)
    layer = { ...heraldLayer(kind, state.width, state.height), ...appearance, ...withVeritas(changed.settings), ...(changed.table ? { table: changed.table } : {}) }
  } else {
    layer = { ...adjustmentLayer(kind, state.width, state.height), ...appearance, adjustment: adjustmentWith(defaultAdjustment(kind), settings, readColour) }
  }
  let next = insertLayer(state, layer, placementFrom(state, args))

  if (args.clip === true) {
    next = setClipped(next, layer.id, true)
  }

  await apply(on, `${kind} Layer`, next)

  return { summary: `Added ${/^[AEIOU]/.test(kind) ? 'an' : 'a'} ${kind} adjustment${args.clip === true ? ' clipped to the layer below' : ''}`, data: { layer: describeLayer(on.doc.state, findLayer(on.doc.state, layer.id)!) } }
}

const layerName = (args: Record<string, unknown>): string | undefined => (typeof args.name === 'string' && args.name.trim() ? args.name.trim() : undefined)

/** Auto Tone, Auto Contrast or Auto Color as an editable Levels layer, worked out from the picture under it. */
export async function autoAdjust(args: Record<string, unknown>): Promise<Outcome> {
  const on = await target(args.project)
  const mode = autoModeFrom(args.kind)
  const cutoff = finite(args.cutoff)

  if (cutoff !== undefined && (cutoff < 0 || cutoff > 10)) {
    throw new Error(`cutoff is the percentage of the darkest and lightest pixels to ignore, from 0 to 10 (it was ${cutoff})`)
  }

  const render = on.live ? renderLayers : (state: DocState, only: ReadonlySet<string>, scale: number) => flatten(state, scale, null, { only })
  const result = autoAdjustState(on.doc.state, mode, { place: placementFrom(on.doc.state, args), clip: cutoff === undefined ? undefined : cutoff / 100, name: layerName(args), render })

  if (!result) {
    return { summary: `${AUTO_LABELS[mode]} found nothing to change: the picture already spans the whole range` }
  }

  const next = args.clip === true ? setClipped(result.state, result.layer.id, true) : result.state
  await apply(on, AUTO_LABELS[mode], next)

  return { summary: `Added ${AUTO_LABELS[mode]} as a Levels layer, “${result.layer.name}” (change it with canvas.setAdjustment)`, data: { layer: describeLayer(on.doc.state, findLayer(on.doc.state, result.layer.id)!) } }
}

/** A colour argument as the format's red, green and blue (0 to 1). */
const unitColour = (value: unknown, fallback: string) => {
  const [r, g, b] = parseColor(value === undefined || value === '' ? fallback : value)

  return { red: r / 255, green: g / 255, blue: b / 255 }
}

const readColour = (value: unknown) => unitColour(value, '#000')

/** Change an adjustment layer: settings merged over what it has, and its opacity or blend mode. */
export async function setAdjustment(args: Record<string, unknown>): Promise<Outcome> {
  const on = await target(args.project)
  const layer = findByRef(on.doc.state, args.layer)

  if (!layer.adjustment) {
    throw new Error(`${layer.name} is not an adjustment layer (add one with canvas.addAdjustment)`)
  }

  const settings = jsonObject(args.settings, 'settings', '{"saturation": -30}')
  const patch: Partial<CanvasLayer> = {}
  const changes: string[] = []
  const herald = heraldOf(layer)

  if (layer.heraldAdjustment && !herald) {
    throw new Error(`${layer.name} is a ${String(layer.heraldAdjustment.kind)} adjustment from a newer Veritas Canvas: this version cannot change it`)
  }

  if (Object.keys(settings).length) {
    if (herald) {
      const changed = await heraldChanged(herald, settings)
      Object.assign(patch, withVeritas(changed.settings), changed.table ? { table: changed.table } : {})
    } else {
      patch.adjustment = adjustmentWith(layer.adjustment, settings, readColour)
    }

    changes.push(`${Object.keys(settings).join(', ')} set`)
  }

  const opacity = opacityFrom(args.opacity)

  if (opacity !== undefined) {
    patch.opacity = opacity
    changes.push(`opacity ${Math.round(opacity * 100)}%`)
  }

  const blend = blendFrom(args.blend)

  if (blend) {
    patch.blendMode = blend
    changes.push(blend)
  }

  if (!changes.length) {
    throw new Error('Nothing to change: give settings (a JSON object), opacity or blend')
  }

  await apply(on, herald?.kind ?? layer.adjustment.kind, withLayer(on.doc.state, layer.id, patch))

  return { summary: `${layer.name}: ${changes.join(', ')}`, data: { layer: describeLayer(on.doc.state, findLayer(on.doc.state, layer.id)!) } }
}

/** Add, change, hide or remove a layer's effects. */
export async function setEffects(args: Record<string, unknown>): Promise<Outcome> {
  const on = await target(args.project)
  const layer = findByRef(on.doc.state, args.layer)

  if (layer.isGroup || layer.adjustment) {
    throw new Error(`${layer.name} is ${layer.isGroup ? 'a folder' : 'an adjustment layer'}: effects go on layers with pixels (pictures, text, shapes)`)
  }

  const patch = jsonObject(args.effects, 'effects', '{"shadow": {"distance": 12, "blur": 24, "opacity": 0.4}, "stroke": false}')
  const clear = args.clear === true
  const source = args.from === undefined || args.from === null || args.from === '' ? null : findByRef(on.doc.state, args.from)

  if (source && !knownEffects(source.effects)) {
    throw new Error(`${source.name} has no effects to copy`)
  }

  if (!Object.keys(patch).length && !clear && !source) {
    throw new Error('Say which effects: effects={"shadow": {...}}, from=a layer whose effects to copy, or clear=true to remove them all')
  }

  // Copied effects replace the layer's own; effects= then changes them further.
  const base = source ? withEffectsFrom(layer.effects, source.effects) : clear ? withoutKnownEffects(layer.effects) : layer.effects
  const effects = effectsWith(base, patch, readColour)
  await apply(on, source ? 'Paste Layer Style' : 'Layer Effects', withLayer(on.doc.state, layer.id, { effects }))
  const what = (value: unknown): string => {
    if (value === false || value === null) {
      return 'removed'
    }

    const settings = value && typeof value === 'object' ? Object.keys(value) : []

    return settings.length === 1 && settings[0] === 'enabled' ? ((value as { enabled: unknown }).enabled === false ? 'hidden' : 'shown') : 'set'
  }
  const changed = Object.keys(patch).map((name) => `${EFFECT_NAMES[effectKindFrom(name)]} ${what(patch[name])}`)

  return {
    summary: `${layer.name}: ${[...(source ? [`effects copied from ${source.name}`] : clear ? ['effects cleared'] : []), ...changed].join(', ')}`,
    data: { layer: describeLayer(on.doc.state, findLayer(on.doc.state, layer.id)!) }
  }
}

/** One step on a layer's mask (making the mask where the action does). */
export async function mask(args: Record<string, unknown>): Promise<Outcome> {
  const on = await target(args.project)
  const layer = findByRef(on.doc.state, args.layer)
  const action = maskActionFrom(args.action)
  await apply(on, MASK_LABELS[action], withMaskAction(on.doc.state, layer.id, action))

  return { summary: `${layer.name}: ${MASK_LABELS[action]}`, data: { layer: describeLayer(on.doc.state, findLayer(on.doc.state, layer.id)!) } }
}

/** The text style a command asks for, over a style there was (or the defaults). */
function textStyleFrom(args: Record<string, unknown>, base?: TextStyle): TextStyle {
  return textStyle({
    ...base,
    content: typeof args.content === 'string' ? args.content.replace(/\\n/g, '\n') : (base?.content ?? ''),
    fontName: args.font !== undefined && args.font !== '' ? fontNameFrom(args.font) : (base?.fontName ?? 'Helvetica'),
    fontSize: rangedArg(args.size, 'size (the font size)', 'fontSize', ' pixels') ?? base?.fontSize ?? 72,
    ...(args.color !== undefined && args.color !== '' ? unitColour(args.color, '#000') : base ? {} : unitColour(undefined, '#000')),
    alignment: alignFrom(args.align) ?? base?.alignment ?? 'Left',
    tracking: rangedArg(args.tracking, 'tracking', 'tracking', ' pixels') ?? base?.tracking ?? 0,
    leading: rangedArg(args.leading, 'leading (baseline to baseline; 0 is automatic)', 'leading', ' pixels') ?? base?.leading ?? 0
  })
}

/** Text as a new layer: point text with its alignment edge at x and its top at y, or a paragraph wrapping in a box `width` wide. */
export async function addText(args: Record<string, unknown>): Promise<Outcome> {
  const on = await target(args.project)
  const { state } = on.doc

  if (typeof args.content !== 'string' || !args.content.trim()) {
    throw new Error('Give the words to write: content="Night market"')
  }

  const width = rangedArg(args.width, 'width (the paragraph box)', 'textBox', ' pixels')
  const height = args.height === 0 ? undefined : rangedArg(args.height, 'height (the paragraph box)', 'textBox', ' pixels')
  let style = textStyleFrom(args)

  if (width !== undefined) {
    style = { ...style, boxSize: [Math.round(width), Math.round(height ?? 0)] }
  }

  // Left out, the text sits a margin in from the edge its alignment is on.
  const margin = Math.round(Math.min(state.width, state.height) * 0.06)
  const x = finite(args.x) ?? (width !== undefined ? margin : style.alignment === 'Center' ? state.width / 2 : style.alignment === 'Right' ? state.width - margin : margin)
  const y = finite(args.y) ?? margin
  let layer = await makeTextLayer(style, [x, y], { from: 'top', name: layerName(args) })
  layer = { ...layer, opacity: opacityFrom(args.opacity) ?? 1, blendMode: blendFrom(args.blend) ?? 'Normal' }
  let next = insertLayer(state, layer, placementFrom(state, args))

  if (args.clip === true) {
    next = setClipped(next, layer.id, true)
  }

  await apply(on, 'Type Tool', next)

  return { summary: `Added the text “${layer.name}” to ${on.doc.name}`, data: { layer: describeLayer(on.doc.state, findLayer(on.doc.state, layer.id)!) } }
}

/** Change a text layer's words or style; it keeps its place (its anchor), size and turn. */
export async function setText(args: Record<string, unknown>): Promise<Outcome> {
  const on = await target(args.project)
  const layer = findByRef(on.doc.state, args.layer)

  if (!layer.text) {
    throw new Error(`${layer.name} is not a text layer`)
  }

  const style = textStyleFrom(args, layer.text)

  if (!style.content.trim()) {
    throw new Error('A text layer needs some text; remove the layer instead')
  }

  await apply(on, 'Edit Type', withLayer(on.doc.state, layer.id, await restyleText(layer, style)))

  return { summary: `${layer.name}: text changed`, data: { layer: describeLayer(on.doc.state, findLayer(on.doc.state, layer.id)!) } }
}

/** A rectangle (corners rounded with radius), an ellipse or a line, as a new shape layer. */
export async function addShape(args: Record<string, unknown>): Promise<Outcome> {
  const on = await target(args.project)
  const { state } = on.doc
  const { kind, rounded } = shapeKindFrom(args.kind)
  const colour = unitColour(args.color, '#000')
  let style: ShapeStyle
  let box: Rect

  if (kind === 'Line') {
    const lineWidth = Math.max(1, finite(args.lineWidth) ?? 4)
    const [from, to] = lineEnds(args, state)
    const placed = shapeBox('Line', from, to, lineWidth)
    style = { ...colour, kind, cornerRadius: 0, lineWidth, start: placed.start, end: placed.end }
    box = placed.box
  } else {
    box = fillBox(state, args)
    const radius = finite(args.radius) ?? (rounded ? Math.round(Math.min(box.width, box.height) * 0.15) : 0)
    style = { ...colour, kind, cornerRadius: Math.max(0, radius) }
  }

  let layer = makeShapeLayer(style, box, layerName(args) ?? nextName(state, shapeName(style)))
  layer = { ...layer, opacity: opacityFrom(args.opacity) ?? 1, blendMode: blendFrom(args.blend) ?? 'Normal' }
  let next = insertLayer(state, layer, placementFrom(state, args))

  if (args.clip === true) {
    next = setClipped(next, layer.id, true)
  }

  await apply(on, shapeName(style), next)

  return { summary: `Added “${layer.name}” to ${on.doc.name}`, data: { layer: describeLayer(on.doc.state, findLayer(on.doc.state, layer.id)!) } }
}

/** Restyle a shape layer: its kind, colour, corner radius or line width. It keeps its box and turn. */
export async function setShape(args: Record<string, unknown>): Promise<Outcome> {
  const on = await target(args.project)
  const layer = findByRef(on.doc.state, args.layer)

  if (!layer.shape) {
    throw new Error(`${layer.name} is not a shape layer (add one with canvas.addShape)`)
  }

  const box = { width: Math.abs(layer.transform.size[0]), height: Math.abs(layer.transform.size[1]) }
  const { style, changes } = shapeWith(layer.shape, args, box, readColour)
  await apply(on, 'Shape', withLayer(on.doc.state, layer.id, restyleShape(layer, style)))

  return { summary: `${layer.name}: ${changes.join(', ')}`, data: { layer: describeLayer(on.doc.state, findLayer(on.doc.state, layer.id)!) } }
}

/** Canvas Size (grow or cut around an anchor; layers untouched) or Image Size (everything scaled). */
export async function resize(args: Record<string, unknown>): Promise<Outcome> {
  const on = await target(args.project)
  const { state } = on.doc
  const plan = resizePlan(state, args)

  if (plan.width > LIMITS.side || plan.height > LIMITS.side || plan.width * plan.height > LIMITS.sourcePixels) {
    throw new Error(`A canvas is 1 to ${LIMITS.side.toLocaleString()} pixels a side, ${(LIMITS.sourcePixels / 1e6).toLocaleString()} million in all`)
  }

  if (plan.kind === 'canvas') {
    await apply(on, 'Canvas Size', resizeCanvas(state, plan.width, plan.height, anchorOffset(state, plan, plan.anchor)))
  } else {
    await apply(on, 'Image Size', scaleImage(state, plan.width, plan.height, plan.resample))
  }

  return {
    summary: `${on.doc.name} is ${plan.width}×${plan.height} now (${plan.kind === 'canvas' ? `canvas around the ${plan.anchor}; layers keep their pixels` : 'everything scaled'})`,
    data: { width: plan.width, height: plan.height, kind: plan.kind }
  }
}

/** Line layers up by an edge or their centres (to the canvas, each other or the selection), or spread three or more evenly. */
export async function align(args: Record<string, unknown>): Promise<Outcome> {
  const on = await target(args.project)
  const { state } = on.doc
  const refs = String(args.layers ?? '')
    .split(',')
    .map((ref) => ref.trim())
    .filter(Boolean)
  const ids = refs.length ? refs.map((ref) => findByRef(state, ref).id) : on.live ? on.doc.picked.map((layer) => layer.id) : []

  if (!ids.length) {
    throw new Error('Say which layers: layers="Logo", or layers="Title,Date,Button" to line several up')
  }

  const names = ids.map((id) => findLayer(state, id)!.name).join(', ')
  const described = () => ({ layers: ids.map((id) => describeLayer(on.doc.state, findLayer(on.doc.state, id)!)) })

  if (args.distribute !== undefined && args.distribute !== '') {
    const mode = distributeFrom(args.distribute)
    const { state: next, moved } = distributeState(state, ids, mode)
    await apply(on, DISTRIBUTE_LABELS[mode], next)

    return { summary: `${DISTRIBUTE_LABELS[mode]}: ${names}${moved ? '' : ' (they were even already)'}`, data: described() }
  }

  const edges = alignEdgesFrom(args.edge)
  const to = alignToFrom(args.to, movableLayers(state, ids).length)
  const selection = to === 'selection' && on.live ? (state.selection?.opaqueBounds() ?? null) : null

  if (to === 'selection' && !selection) {
    throw new Error('Nothing is selected in the open Canvas window to align to: use to=canvas or to=layers')
  }

  const margin = finite(args.margin)
  const { state: next, moved } = alignState(state, ids, { edges, to, margin, selection })
  const label = edges.length === 1 ? ALIGN_LABELS[edges[0]] : 'Align'
  await apply(on, label, next)
  const where = to === 'canvas' ? `the canvas${margin ? ` (${margin} pixels in)` : ''}` : to === 'selection' ? 'the selection' : 'each other'

  return { summary: `${names}: ${edges.map((edge) => (edge === 'center' ? 'centred across' : edge === 'middle' ? 'centred down' : edge)).join(' and ')} on ${where}${moved ? '' : ' (already there)'}`, data: described() }
}

/** Add, remove, clear or list guides: one at a position, or margins, columns and centre lines. */
export async function guides(args: Record<string, unknown>): Promise<Outcome> {
  const on = await target(args.project)
  const { state } = on.doc
  const action = String(args.action ?? 'list').toLowerCase()
  const listed = () => ({ guides: on.doc.state.guides.map((guide) => ({ id: guide.id, axis: guide.axis, position: guide.position })) })

  if (action === 'list') {
    return { summary: `${on.doc.name} has ${state.guides.length || 'no'} guide${state.guides.length === 1 ? '' : 's'}`, data: listed() }
  }

  if (action === 'clear') {
    if (!state.guides.length) {
      return { summary: 'There are no guides to clear', data: listed() }
    }

    await apply(on, 'Clear Guides', { ...state, guides: [] })

    return { summary: `Cleared ${state.guides.length} guide${state.guides.length === 1 ? '' : 's'}`, data: listed() }
  }

  const axis = args.axis !== undefined && args.axis !== '' ? guideAxisFrom(args.axis) : undefined
  const position = axis ? positionFrom(args.position, axis === 'vertical' ? state.width : state.height) : undefined

  if (action === 'remove') {
    if (!axis || position === undefined) {
      throw new Error('Say which guide to remove: axis (vertical or horizontal) and position')
    }

    const guide = guideNear(state, axis, position, 1)

    if (!guide) {
      throw new Error(`There is no ${axis} guide at ${position}; the guides: ${state.guides.map((entry) => `${entry.axis} ${entry.position}`).join(', ') || 'none'}`)
    }

    await apply(on, 'Delete Guide', withoutGuides(state, [guide.id]))

    return { summary: `Removed the ${axis} guide at ${guide.position}`, data: listed() }
  }

  if (action !== 'add') {
    throw new Error('action is add, remove, clear or list')
  }

  if (args.position !== undefined && args.position !== '' && !axis) {
    throw new Error('Say which way the guide runs: axis=vertical (a line down, at an x) or axis=horizontal (a line across, at a y)')
  }

  const margins = positionFrom(args.margins, Math.min(state.width, state.height), 'margins')
  const layout = layoutGuides(state, { margins, columns: finite(args.columns), gutter: finite(args.gutter), center: args.center === true })
  const wanted = [...(axis && position !== undefined ? [{ axis, position }] : []), ...layout]

  if (!wanted.length) {
    throw new Error('Say where: axis and position, or margins, columns (with margins and gutter) or center=true')
  }

  if (wanted.some((guide) => !onCanvas(state, guide.axis, guide.position))) {
    throw new Error(`Guides go on the canvas: from 0 to ${state.width} across and 0 to ${state.height} down`)
  }

  const { state: next, added } = withGuides(state, wanted)

  if (!added.length) {
    return { summary: 'Those guides are there already', data: listed() }
  }

  await apply(on, added.length === 1 ? 'New Guide' : 'New Guides', next)

  return { summary: `Added ${added.length} guide${added.length === 1 ? '' : 's'}: ${added.map((guide) => `${guide.axis} at ${guide.position}`).join(', ')}`, data: listed() }
}

/** Crop the canvas to a box (held to a ratio, after turning the picture level when asked); layers keep their pixels. */
export async function crop(args: Record<string, unknown>): Promise<Outcome> {
  const on = await target(args.project)
  const { box, angle } = cropPlan(on.doc.state, args)
  await apply(on, angle ? 'Straighten' : 'Crop', cropCanvas(rotateLayers(on.doc.state, angle), box))

  return { summary: `${angle ? `Turned ${on.doc.name} ${angle}° and cropped it` : `Cropped ${on.doc.name}`} to ${box.width}×${box.height} from (${box.x}, ${box.y})`, data: { ...box, ...(angle ? { angle } : {}) } }
}

const exportKind = (file: string, format: unknown): ExportKind | 'psd' => {
  const named = String(format ?? '').toLowerCase()

  if (named === 'png' || named === 'jpeg' || named === 'webp' || named === 'psd') {
    return named
  }

  if (named === 'jpg') {
    return 'jpeg'
  }

  return /\.jpe?g$/i.test(file) ? 'jpeg' : /\.webp$/i.test(file) ? 'webp' : /\.psd$/i.test(file) ? 'psd' : 'png'
}

export async function exportTo(args: Record<string, unknown>): Promise<Outcome> {
  const on = await target(args.project)

  if (typeof args.to !== 'string' || !args.to.trim()) {
    throw new Error('Say where to write it: to=~/Pictures/poster.png')
  }

  const kind = exportKind(args.to, args.format)
  let file = resolve(args.to)

  if (!/\.(png|jpe?g|webp|psd)$/i.test(file)) {
    file = `${file}.${kind === 'jpeg' ? 'jpg' : kind}`
  }

  if ((await window.heraldOS.canvas.exists(file)) && args.overwrite !== true) {
    throw new Error(`${fileName(file)} already exists: pass overwrite=true to replace it`)
  }

  const scale = finite(args.scale)
  const quality = finite(args.quality)

  if (kind === 'psd') {
    if (scale !== undefined && scale !== 1) {
      throw new Error('A PSD keeps the layers at their own size: leave scale out (or export a PNG or JPEG at a scale)')
    }

    const { exportPsd } = await import('./psd/psd.ts')
    const { file: written, notes } = await exportPsd(on.doc.state, file)

    return { summary: `Exported ${fileName(written)} with its layers${notes.length ? `. Approximated: ${notes.join('; ')}` : ''}`, data: { file: written, ...(notes.length ? { notes } : {}) } }
  }

  const written = await exportImage(on.doc.state, file, kind, { scale: scale && scale > 0 ? Math.min(scale, 4) : 1, quality: quality !== undefined ? Math.max(0.05, Math.min(1, quality > 1 ? quality / 100 : quality)) : undefined })

  return { summary: `Exported ${fileName(written)}`, data: { file: written } }
}

export async function save(args: Record<string, unknown>): Promise<Outcome> {
  const on = await target(args.project)
  const to = typeof args.to === 'string' && args.to.trim() ? resolve(args.to) : null
  const file = to ? (isProjectPath(to) ? to : `${to}${PROJECT_EXTENSION}`) : on.doc.path

  if (!file) {
    throw new Error('This image has never been saved: say where, with to=~/Pictures/Name.comp')
  }

  if (to && file !== on.doc.path && (await window.heraldOS.canvas.exists(file)) && args.overwrite !== true) {
    throw new Error(`${baseName(file)} already exists: pass overwrite=true to replace it`)
  }

  if (on.live) {
    const { save: saveDocument } = await store()
    await saveDocument(on.doc, { to: file })
  } else {
    await saveProject(on.doc, file)
  }

  return { summary: `Saved ${baseName(file)}`, data: { path: file } }
}

const PREVIEW_FOLDER = '/tmp/herald-canvas-previews'

/** A flattened PNG of the image for Hermes to look at, at most `size` pixels on its long side. */
export async function preview(args: Record<string, unknown>): Promise<Outcome> {
  const on = await target(args.project)
  const { state } = on.doc
  const side = Math.max(64, Math.min(4096, Math.round(finite(args.size) ?? 1024)))
  const scale = Math.min(1, side / Math.max(state.width, state.height))
  const raster = flatten(state, scale)
  const name = (on.doc.path ? baseName(on.doc.path) : on.doc.name).replace(/[^\w.-]+/g, '-') || 'canvas'
  const file = await window.heraldOS.canvas.writeFile(`${PREVIEW_FOLDER}/${name}.png`, { width: raster.width, height: raster.height, channels: 4, data: new Uint8Array(raster.data.buffer, raster.data.byteOffset, raster.data.byteLength) })

  return {
    summary: `Preview of ${on.doc.name} (${raster.width}×${raster.height}): ${file}`,
    data: { file, width: raster.width, height: raster.height, canvas: { width: state.width, height: state.height }, layers: state.layers.length }
  }
}

/** A mask from an image file (white shows, black hides; transparency hides too). */
async function loadMask(source: string): Promise<Raster> {
  return readPicture(resolve(source), 1)
}

/** The layer a command names, or the active one; it has to have pixels. */
function pixelsLayer(state: DocState, ref: unknown, what: string): CanvasLayer {
  const layer = ref !== undefined && ref !== '' ? findByRef(state, ref) : findLayer(state, state.activeLayerId)

  if (!layer) {
    throw new Error(`Say which layer to ${what}: layer=…`)
  }

  if (!layer.pixels || layer.isGroup || layer.adjustment) {
    throw new Error(`${layer.name} ${layer.isGroup ? 'is a folder' : layer.adjustment ? 'is an adjustment layer' : 'is empty'}: ${what} works on a layer with a picture`)
  }

  return layer
}

/**
 * A picture (a file or an http(s) address) as a new layer in an explicit box (the rest of the
 * canvas for what is not given): covering it (the default), inside it, or stretched over it. With
 * `mask`, an image spread over the same box becomes the layer's mask, so a generated picture can be
 * kept to a selection whatever window the command runs in.
 */
export async function placeImage(args: Record<string, unknown>): Promise<Outcome> {
  const on = await target(args.project)
  const { state } = on.doc

  if (typeof args.source !== 'string' || !args.source.trim()) {
    throw new Error('Give the picture to place: source=/path/to/picture.png (or an https address)')
  }

  const source = args.source.trim()
  const raster = await loadImage(source)
  const box = fillBox(state, args)
  const fitted = fitPicture(raster.width, raster.height, box, pictureFitFrom(args.fit))
  const whole = fitted.crop.width === raster.width && fitted.crop.height === raster.height
  const pixels = whole ? raster : raster.crop(fitted.crop)
  const name = layerName(args) ?? (/^https?:|^data:/.test(source) ? nextName(state, 'Image') : baseName(source))
  let layer: CanvasLayer = { ...pixelLayer(name, pixels, defaultTransform(fitted.box.width, fitted.box.height, fitted.box.x, fitted.box.y)), opacity: opacityFrom(args.opacity) ?? 1, blendMode: blendFrom(args.blend) ?? 'Normal' }

  if (typeof args.mask === 'string' && args.mask.trim()) {
    const mask = await loadMask(args.mask.trim())
    const part = maskPart(mask.width, mask.height, box, fitted.box)
    layer = { ...layer, mask: resample(mask.crop(part), pixels.width, pixels.height), maskEnabled: true, maskLinked: true }
  }

  let next = insertLayer(state, layer, placementFrom(state, args))

  if (args.clip === true) {
    next = setClipped(next, layer.id, true)
  }

  await apply(on, 'Place Image', next)

  return { summary: `Placed “${layer.name}” in ${on.doc.name}${layer.mask ? ', masked' : ''}`, data: { layer: describeLayer(on.doc.state, findLayer(on.doc.state, layer.id)!) } }
}

/** Remove Background on a layer with the on-device model: as its mask (the default) or as a cut-out layer. */
export async function removeBackground(args: Record<string, unknown>): Promise<Outcome> {
  const on = await target(args.project)
  const layer = pixelsLayer(on.doc.state, args.layer, 'remove the background')
  const mode = backgroundModeFrom(args.mode)
  const { requireModel } = await import('./ai/models.ts')
  await requireModel('isnet', 'Remove Background')
  const ai = await import('./ai/remove-background.ts')
  const feather = finite(args.feather)
  const next = await ai.removeBackground(on.doc, layer.id, { output: mode, threshold: fractionFrom(args.threshold, 'threshold'), feather: feather === undefined ? undefined : Math.max(0, Math.min(250, feather)), refine: args.refine !== false })
  await apply(on, 'Remove Background', next)
  // A cut-out is the new active layer.
  const result = findLayer(on.doc.state, mode === 'cutout' ? on.doc.state.activeLayerId : layer.id)

  return { summary: mode === 'cutout' ? `Cut ${layer.name}'s subject out onto a new layer and hid the original` : `${layer.name}: its background is hidden by a mask (nothing erased)`, data: result ? { layer: describeLayer(on.doc.state, result) } : undefined }
}

/** A Filter menu filter on a layer's pixels (inside the window's selection when asked), as one step. */
export async function filter(args: Record<string, unknown>): Promise<Outcome> {
  const on = await target(args.project)
  const kind = filterKindFrom(args.kind)
  const spec = checkFilter(kind, jsonObject(args.settings, 'settings', '{"radius": 2}'))
  const layer = pixelsLayer(on.doc.state, args.layer, 'filter')

  if (layer.text || layer.shape) {
    throw new Error(`${layer.name} is a ${layer.text ? 'text' : 'shape'} layer that stays editable: filters change pixels, so rasterize it first or filter a copy`)
  }

  const selection = args.inSelection === true && on.live ? on.doc.state.selection : null

  if (args.inSelection === true && !selection) {
    throw new Error('Nothing is selected in the open Canvas window: leave inSelection out to filter the whole layer')
  }

  // A new raster, so the step undoes by putting the old one back.
  const pixels = layer.pixels!.clone()
  const toDocument = pixelToDocument(layer.transform, pixels.width, pixels.height)
  const area = filterTargetArea(pixels, toDocument, selection)

  if (!area) {
    throw new Error(`The selection misses ${layer.name}`)
  }

  const filtered = await filterArea(pixels, area, spec)
  const covered = coverageReader(selection, toDocument)
  mixInto(pixels, area, filtered, (x, y) => covered(x, y) / 255)
  await apply(on, FILTER_NAMES[kind], withLayer(on.doc.state, layer.id, { pixels }))
  const settings = Object.entries(spec).filter(([key]) => key !== 'kind' && key !== 'seed')

  return {
    summary: `${layer.name}: ${FILTER_NAMES[kind]}${settings.length ? ` (${settings.map(([key, value]) => `${key} ${value}`).join(', ')})` : ''}${selection ? ', inside the selection' : ''}`,
    data: { layer: describeLayer(on.doc.state, findLayer(on.doc.state, layer.id)!), settings: Object.fromEntries(settings) }
  }
}

/** Content-aware fill: a box (or the open window's selection) on a layer filled from the pixels around it, in place or on a new layer. */
export async function contentFill(args: Record<string, unknown>): Promise<Outcome> {
  const on = await target(args.project)
  const { state } = on.doc
  const layer = pixelsLayer(state, args.layer, 'fill')
  const box = holeBox(state, args)
  const ai = await import('./ai/content-fill.ts')
  let mask: Raster | null = box ? ai.boxMask(state.width, state.height, box) : null

  if (!mask) {
    if (!on.live || !state.selection) {
      throw new Error('Give the box to fill (x, y, width and height in canvas pixels), or have the person select it in the Canvas window')
    }

    mask = state.selection
  }

  const pixels = layer.pixels!
  const hole = ai.holeFromMask(mask, ai.placementOf(layer), pixels.width, pixels.height)

  if (!hole) {
    throw new Error(`That area misses ${layer.name}`)
  }

  const filled = await ai.fillRaster(pixels, hole, { sampling: args.sampling === 'all' ? 'all' : 'around' }).done
  const onNew = args.newLayer === true
  const next = onNew ? ai.withFillLayer(state, filled, { transform: layer.transform, width: pixels.width, height: pixels.height }, layer.id) : ai.withFillInLayer(state, layer.id, filled)
  await apply(on, 'Content-Aware Fill', next)
  const area = box ?? mask.opaqueBounds()!

  return { summary: `Filled ${area.width}×${area.height} at (${area.x}, ${area.y}) ${onNew ? 'on a new layer above' : 'in'} ${layer.name}, from the pixels around it`, data: { box: area } }
}

/** Undo or redo `steps` steps (one by default) in the image in front (it has to be open in a Canvas window). */
export async function step(direction: 'undo' | 'redo', args: Record<string, unknown>): Promise<Outcome> {
  const on = await target(args.project)
  const count = stepCount(args.steps)

  if (!on.live) {
    if (isPanels) {
      // The Canvas window is its own process there: it takes the request as its payload.
      await window.heraldOS.shell.open('window:canvas', { type: 'payload', payload: { command: direction, path: on.doc.path, steps: count, at: Date.now() } })

      return { summary: `Asked Veritas Canvas to ${direction} ${count === 1 ? 'a step' : `${count} steps`} in ${on.doc.name}` }
    }

    throw new Error('Undo works in the open Canvas window: open the project first')
  }

  const labels = stepThrough(on.doc, direction, count)

  if (!labels.length) {
    throw new Error(direction === 'undo' ? 'Nothing to undo' : 'Nothing to redo')
  }

  const { $autosave, save: saveDocument } = await store()

  if (on.doc.path && $autosave.get()) {
    await saveDocument(on.doc)
  }

  return { summary: `${direction === 'undo' ? 'Undid' : 'Redid'} ${labels.join(', ')}`, data: { applied: on.doc.history.applied, steps: on.doc.history.steps.length } }
}

/** The steps in the open image's history, oldest first: which are applied, and which a command made. */
export async function history(args: Record<string, unknown>): Promise<Outcome> {
  const on = await target(args.project)

  if (!on.live) {
    throw new Error('The history lives in the open Canvas window: open the project there first (canvas.open)')
  }

  const { history: kept } = on.doc
  const steps = describeHistory(kept.steps, kept.applied)

  return {
    summary: `${on.doc.name}: ${kept.applied} of ${steps.length} step${steps.length === 1 ? '' : 's'} applied${kept.dropped ? ` (the ${kept.dropped} oldest were let go of to save memory)` : ''}`,
    data: { applied: kept.applied, steps, ...(kept.dropped ? { dropped: kept.dropped } : {}) }
  }
}
