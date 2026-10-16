import { ADJUSTMENT_KINDS, BLEND_MODES, HERALD_ADJUSTMENT_KINDS } from '../../shared/canvas/comp-format.ts'
import { MASK_ACTIONS } from '../features/canvas/mask-actions.ts'
import { messageOf } from '../features/canvas/errors.ts'
import { ok, type OsCommand } from '../store/os-commands.ts'

/*
 * Veritas Canvas for Hermes, voice, the command bar and `herald-os canvas`. A command works on the
 * `project` it names (a .comp folder) or on the image in front; edits are one undoable step each
 * and the person watches them land. The editor's code loads only when one of these runs.
 */

const canvas = () => import('../features/canvas/agent.ts')

const project = { name: 'project', type: 'string', description: 'The .comp project (full path or ~/…); the image in front when left out' } as const

const placement = [
  { name: 'x', type: 'number', description: 'Left edge in canvas pixels' },
  { name: 'y', type: 'number', description: 'Top edge in canvas pixels' },
  { name: 'width', type: 'number', description: 'Width in canvas pixels (alone, it keeps the proportions)' },
  { name: 'height', type: 'number', description: 'Height in canvas pixels (alone, it keeps the proportions)' }
] as const

/** A box in canvas pixels, where whatever is left out runs to the canvas's edge. */
const box = (what: string) =>
  [
    { name: 'x', type: 'number', description: `Left edge ${what}, in canvas pixels (0)` },
    { name: 'y', type: 'number', description: `Top edge ${what}, in canvas pixels (0)` },
    { name: 'width', type: 'number', description: `Width ${what} (to the right edge when left out)` },
    { name: 'height', type: 'number', description: `Height ${what} (to the bottom when left out)` }
  ] as const

const appearance = [
  { name: 'opacity', type: 'number', description: '0 to 1 (or a percentage)' },
  { name: 'blend', type: 'string', description: `Blend mode: ${BLEND_MODES.join(', ')}` }
] as const

const where = [
  { name: 'above', type: 'string', description: 'Put it right above this layer (id or name)' },
  { name: 'folder', type: 'string', description: 'Put it at the top of this folder (id or name)' },
  { name: 'clip', type: 'boolean', description: 'Clip it to the layer below, so it shows only where that layer has pixels' }
] as const

const done = async (work: Promise<{ summary: string; data?: Record<string, unknown> }>) => {
  try {
    const outcome = await work

    return ok(outcome.summary, { data: outcome.data })
  } catch (error) {
    // Errors from main come with Electron's prefix, which says nothing to Hermes or the person.
    throw new Error(messageOf(error))
  }
}

export const canvasCommands: readonly OsCommand[] = [
  {
    id: 'canvas.open',
    title: 'Open Veritas Canvas',
    description:
      'Open Veritas Canvas, or open a .comp project in it so the person sees it. An image becomes a new project in ~/Pictures/Veritas Canvas (the original is never changed); a Photoshop document (.psd, .psb) keeps its layers, and the answer lists anything approximated. The answer gives the project path to work on.',
    tier: 'act',
    args: [{ name: 'path', type: 'string', description: 'An image or a .comp project (full path or ~/…)' }],
    phrases: ['open herald canvas', 'open canvas', 'open the image editor'],
    run: async ({ path }) => done((await canvas()).open(path))
  },
  {
    id: 'canvas.new',
    title: 'Start a new image',
    description: 'Make a new .comp project (in ~/Pictures/Veritas Canvas unless a folder is given; the name is never reused) and open it. Answers with its path, which later commands take as project.',
    tier: 'act',
    args: [
      { name: 'name', type: 'string', description: 'The project name, e.g. "Spring poster"' },
      { name: 'width', type: 'number', description: 'Pixels (1920 when left out)' },
      { name: 'height', type: 'number', description: 'Pixels (1080 when left out)' },
      { name: 'background', type: 'string', description: 'white, black, transparent, or any CSS colour' },
      { name: 'resolution', type: 'number', description: 'Pixels per inch, for print (72 when left out)' },
      { name: 'folder', type: 'string', description: 'Where the project goes' }
    ],
    phrases: ['new canvas', 'new image in canvas'],
    run: async (args) => done((await canvas()).create(args))
  },
  {
    id: 'canvas.status',
    title: 'What is open in Veritas Canvas',
    description: 'The images open in Veritas Canvas (path, size, unsaved edits) and which one is in front.',
    tier: 'read',
    args: [],
    run: async () => done((await canvas()).status())
  },
  {
    id: 'canvas.layers',
    title: 'List the layers of an image',
    description: 'The canvas size and every layer, top to bottom as the Layers panel shows them: id, name, kind, folder, visibility, opacity, blend mode, placement, clipping, mask and adjustment.',
    tier: 'read',
    args: [project],
    run: async ({ project: path }) => done((await canvas()).layers(path))
  },
  {
    id: 'canvas.addLayer',
    title: 'Add a layer',
    description:
      'Add a layer: a picture (source = a file path or an http(s) URL), a solid colour (color), a gradient (gradient = "colour, colour, …" first to last, each with an optional position like "#ff8800 30%"; transparent colours such as #00000000 fade; style and angle lay it out), or an empty layer. A picture fits inside the canvas, centred, unless fit or a box says otherwise.',
    tier: 'act',
    args: [
      project,
      { name: 'source', type: 'string', description: 'An image file or an http(s) address' },
      { name: 'color', type: 'string', description: 'A solid fill, any CSS colour' },
      { name: 'gradient', type: 'string', description: 'Comma-separated colours, first to last, each with an optional position: "#000 0%, #335 60%, #fff"' },
      { name: 'style', type: 'string', description: 'Gradient style: linear (the default), radial (from the centre out), angle (a sweep around the centre), reflected (mirrored from the centre line) or diamond' },
      { name: 'angle', type: 'number', description: 'Gradient direction in degrees: 0 left to right, 90 top to bottom' },
      { name: 'fit', type: 'string', description: 'For a picture: contain (inside the canvas, the default), cover (fill it), none (its own size) or stretch' },
      ...placement,
      { name: 'name', type: 'string', description: 'The layer name' },
      ...appearance,
      ...where
    ],
    run: async (args) => done((await canvas()).addLayer(args))
  },
  {
    id: 'canvas.setLayer',
    title: 'Change a layer',
    description:
      'Change a layer: rename, show or hide, opacity, blend mode, position and size (x, y, width, height; one side alone keeps the proportions), rotation in degrees clockwise, flips, clipping to the layer below, its order (up, down, top, bottom) or the folder it is in ("none" takes it out).',
    tier: 'act',
    args: [
      project,
      { name: 'layer', type: 'string', description: 'The layer (id or name)', required: true },
      { name: 'name', type: 'string', description: 'A new name' },
      { name: 'visible', type: 'boolean', description: 'Show or hide it' },
      ...appearance,
      ...placement,
      { name: 'rotation', type: 'number', description: 'Degrees, clockwise, around its centre' },
      { name: 'flipX', type: 'boolean', description: 'Mirror left to right' },
      { name: 'flipY', type: 'boolean', description: 'Mirror top to bottom' },
      { name: 'clip', type: 'boolean', description: 'Clip it to the layer below (false lets go)' },
      { name: 'order', type: 'string', description: 'Move it among its neighbours: up, down, top or bottom' },
      { name: 'folder', type: 'string', description: 'Move it into this folder (id or name), or "none"' }
    ],
    run: async (args) => done((await canvas()).setLayer(args))
  },
  {
    id: 'canvas.addText',
    title: 'Add text',
    description:
      'Add a text layer that stays editable. Point text: x is its left edge (its centre with align=center, its right edge with align=right) and y its top. Give width for a paragraph that wraps inside a box from x. Fonts are installed families, with a style after them if wanted ("Avenir Next Bold", "Georgia Italic"), or PostScript names ("HelveticaNeue-Bold"). size is the font size in pixels. A new line is \\n.',
    tier: 'act',
    args: [
      project,
      { name: 'content', type: 'string', description: 'The words', required: true },
      { name: 'x', type: 'number', description: 'Left edge (or centre or right edge, by align) in canvas pixels' },
      { name: 'y', type: 'number', description: 'Top edge in canvas pixels' },
      { name: 'width', type: 'number', description: 'A paragraph box this wide (the text wraps in it)' },
      { name: 'height', type: 'number', description: 'The paragraph box height (fits the text when left out)' },
      { name: 'font', type: 'string', description: 'Font family and style, e.g. "Helvetica Neue Bold"' },
      { name: 'size', type: 'number', description: 'Font size in pixels (72)' },
      { name: 'color', type: 'string', description: 'Any CSS colour (black)' },
      { name: 'align', type: 'string', description: 'left, center or right' },
      { name: 'tracking', type: 'number', description: 'Extra space between letters, in pixels (−100 to 1000)' },
      { name: 'leading', type: 'number', description: 'Line spacing from baseline to baseline, in pixels (0 to 5000; 0 is automatic, 120% of the size)' },
      { name: 'name', type: 'string', description: 'The layer name (the text when left out)' },
      ...appearance,
      ...where
    ],
    run: async (args) => done((await canvas()).addText(args))
  },
  {
    id: 'canvas.setText',
    title: 'Change text',
    description: 'Change a text layer’s words or style. It keeps its place, size and rotation; only what is given changes.',
    tier: 'act',
    args: [
      project,
      { name: 'layer', type: 'string', description: 'The text layer (id or name)', required: true },
      { name: 'content', type: 'string', description: 'New words' },
      { name: 'font', type: 'string', description: 'Font family and style, e.g. "Georgia Italic"' },
      { name: 'size', type: 'number', description: 'Font size in pixels' },
      { name: 'color', type: 'string', description: 'Any CSS colour' },
      { name: 'align', type: 'string', description: 'left, center or right' },
      { name: 'tracking', type: 'number', description: 'Extra space between letters, in pixels (−100 to 1000)' },
      { name: 'leading', type: 'number', description: 'Line spacing from baseline to baseline, in pixels (0 to 5000; 0 is automatic, 120% of the size)' }
    ],
    run: async (args) => done((await canvas()).setText(args))
  },
  {
    id: 'canvas.addShape',
    title: 'Add a shape',
    description:
      'Add a shape layer: a rectangle (radius rounds its corners; kind=rounded picks a radius), an ellipse (a circle when width equals height) or a line from (x, y) to (x + width, y + height), lineWidth thick. A box left out fills the rest of the canvas.',
    tier: 'act',
    args: [
      project,
      { name: 'kind', type: 'string', description: 'rectangle, rounded, ellipse or line', required: true },
      ...box('of the shape'),
      { name: 'color', type: 'string', description: 'Any CSS colour (black)' },
      { name: 'radius', type: 'number', description: 'Corner radius in pixels, for rectangles' },
      { name: 'lineWidth', type: 'number', description: 'Line thickness in pixels (4)' },
      { name: 'name', type: 'string', description: 'The layer name' },
      ...appearance,
      ...where
    ],
    run: async (args) => done((await canvas()).addShape(args))
  },
  {
    id: 'canvas.setShape',
    title: 'Change a shape',
    description:
      'Restyle a shape layer in place: its kind (rectangle, rounded, ellipse or line; a rectangle or ellipse becoming a line runs corner to corner in its box), its colour, a rectangle’s corner radius or a line’s width. It keeps its place, size and rotation; only what is given changes.',
    tier: 'act',
    args: [
      project,
      { name: 'layer', type: 'string', description: 'The shape layer (id or name)', required: true },
      { name: 'kind', type: 'string', description: 'rectangle, rounded, ellipse or line' },
      { name: 'color', type: 'string', description: 'Any CSS colour' },
      { name: 'radius', type: 'number', description: 'Corner radius in pixels, for rectangles (0 squares the corners)' },
      { name: 'lineWidth', type: 'number', description: 'Line thickness in pixels, for lines' }
    ],
    run: async (args) => done((await canvas()).setShape(args))
  },
  {
    id: 'canvas.resize',
    title: 'Resize an image',
    description:
      'Change the canvas size: width and height grow or cut the canvas around anchor (center by default; top-left, top, bottom-right and so on), and layers keep their pixels. To scale everything instead (Image Size), give scale (0.5 is half) or image=true with width and/or height (one side keeps the proportions).',
    tier: 'act',
    args: [
      project,
      { name: 'width', type: 'number', description: 'New width in pixels' },
      { name: 'height', type: 'number', description: 'New height in pixels' },
      { name: 'anchor', type: 'string', description: 'Where the canvas grows or shrinks from: center, top-left, top, top-right, left, right, bottom-left, bottom or bottom-right' },
      { name: 'scale', type: 'number', description: 'Scale everything by this much (Image Size)' },
      { name: 'image', type: 'boolean', description: 'Scale everything to width and height instead of changing the canvas' },
      { name: 'resample', type: 'boolean', description: 'When scaling, recalculate layer pixels too (true); false only stretches them' }
    ],
    run: async (args) => done((await canvas()).resize(args))
  },
  {
    id: 'canvas.align',
    title: 'Align or distribute layers',
    description:
      'Line layers up by an edge or their centres: edge is left, center, right, top, middle or bottom, and two align both ways ("bottom,right" for a corner, "center,middle" to centre). to is canvas (the default for one layer; margin keeps that many pixels from its edges), layers (each other, the default for several) or selection (what the person selected in the window). Or space three or more layers evenly with distribute: horizontal or vertical for equal gaps, or an edge or centre. Layers are measured by what they show, not their boxes. One undoable step.',
    tier: 'act',
    args: [
      project,
      { name: 'layers', type: 'string', description: 'Comma-separated layer ids or names (the layers picked in the open window when left out)' },
      { name: 'edge', type: 'string', description: 'left, center, right, top, middle or bottom; two separated by a comma align both ways' },
      { name: 'to', type: 'string', description: 'canvas, layers (each other) or selection' },
      { name: 'margin', type: 'number', description: 'With to=canvas: pixels to keep from the canvas edges' },
      { name: 'distribute', type: 'string', description: 'Instead of aligning: horizontal or vertical (equal gaps), or left, center, right, top, middle or bottom (even edges or centres)' }
    ],
    run: async (args) => done((await canvas()).align(args))
  },
  {
    id: 'canvas.guides',
    title: 'Add or remove guides',
    description:
      'Guides are lines over the canvas that layers, crops and selections snap to; they never show in exports. action=add puts one at a position (axis vertical for a line down the canvas at an x, horizontal for a line across at a y; position in pixels or a percentage like "50%"), or a layout: margins (pixels or a percentage of the short side; four guides that far in), columns (equal columns between the margins, with gutter pixels between them) and center=true (lines through the middle). action=remove takes axis and position; clear removes them all; list shows them.',
    tier: 'act',
    args: [
      project,
      { name: 'action', type: 'string', description: 'add, remove, clear or list', required: true, enum: ['add', 'remove', 'clear', 'list'] },
      { name: 'axis', type: 'string', description: 'vertical (a line down, at an x) or horizontal (a line across, at a y)' },
      { name: 'position', type: 'string', description: 'Pixels from the left (vertical) or top (horizontal), or a percentage like "50%"' },
      { name: 'margins', type: 'string', description: 'Guides this far in from each edge: pixels, or a percentage of the short side' },
      { name: 'columns', type: 'number', description: 'Equal columns between the margins' },
      { name: 'gutter', type: 'number', description: 'Pixels between columns' },
      { name: 'center', type: 'boolean', description: 'Guides through the middle of the canvas, both ways' }
    ],
    run: async (args) => done((await canvas()).guides(args))
  },
  {
    id: 'canvas.crop',
    title: 'Crop an image',
    description:
      'Crop the canvas to a box (canvas pixels from the top-left), or to a ratio: ratio=4:5 alone keeps the largest centred 4:5 box, and with a box it trims the box to that shape around its centre. angle turns the picture that many degrees clockwise first, to level a horizon (negative turns it counterclockwise), and then crops to the largest box the turned picture fills. Layers keep their pixels, so it can be undone without loss.',
    tier: 'act',
    args: [
      project,
      ...box('of the box to keep'),
      { name: 'ratio', type: 'string', description: 'Width:height to hold the box to: 1:1, 4:5, 3:2, 16:9, 9:16, original, or a number like 1.5' },
      { name: 'angle', type: 'number', description: 'Degrees to turn the picture clockwise before cropping, to straighten it (−180 to 180)' }
    ],
    run: async (args) => done((await canvas()).crop(args))
  },
  {
    id: 'canvas.removeLayer',
    title: 'Remove a layer',
    description: 'Delete a layer (a folder goes with everything in it). It can be undone in the Canvas window.',
    tier: 'act',
    args: [project, { name: 'layer', type: 'string', description: 'The layer (id or name)', required: true }],
    run: async (args) => done((await canvas()).removeLayer(args))
  },
  {
    id: 'canvas.group',
    title: 'Put layers in a folder',
    description: 'Put layers in a new folder where the topmost of them was, or add an empty folder. Folders pass their opacity and mask on to everything inside.',
    tier: 'act',
    args: [project, { name: 'layers', type: 'string', description: 'Comma-separated layer ids or names; none adds an empty folder' }, { name: 'name', type: 'string', description: 'The folder name' }, where[0], where[1]],
    run: async (args) => done((await canvas()).group(args))
  },
  {
    id: 'canvas.addAdjustment',
    title: 'Add an adjustment layer',
    description: `Add an adjustment layer, which changes everything below it (or only the layer below, with clip). Kinds: ${[...ADJUSTMENT_KINDS, ...HERALD_ADJUSTMENT_KINDS].join(', ')}. settings is JSON over the defaults, e.g. {"hue": 10, "saturation": 25} for Hue/Saturation, {"exposureSettings": {"exposure": 0.5}} for Exposure, {"brightness": 20, "contrast": 15} for Brightness/Contrast, {"vibrance": 30} for Vibrance, {"table": "~/LUTs/Film.cube"} for Color Lookup; the herald-canvas skill lists every field. The last eight are Veritas's own: Compositor shows Brightness/Contrast (and Vibrance without vibrance, a Photo Filter without preserveLuminosity) the same, and the others as no change.`,
    tier: 'act',
    args: [
      project,
      { name: 'kind', type: 'string', description: 'The adjustment', required: true, enum: [...ADJUSTMENT_KINDS, ...HERALD_ADJUSTMENT_KINDS] },
      { name: 'settings', type: 'string', description: 'JSON object of settings' },
      { name: 'name', type: 'string', description: 'The layer name' },
      ...appearance,
      ...where
    ],
    run: async (args) => done((await canvas()).addAdjustment(args))
  },
  {
    id: 'canvas.autoAdjust',
    title: 'Auto Tone, Auto Contrast or Auto Color',
    description:
      'Fix a photo’s tone or colour cast automatically from its histogram, as an editable Levels adjustment layer above the active layer (or where asked): kind=tone stretches each channel to the full range (the usual first step for a dull photo), contrast stretches the three together so colours keep their balance, color also neutralises a cast in the shadows, highlights and near-gray midtones. cutoff is the percentage of the darkest and lightest pixels ignored (0.1). Change the result later with canvas.setAdjustment.',
    tier: 'act',
    args: [
      project,
      { name: 'kind', type: 'string', description: 'tone (the default), contrast or color' },
      { name: 'cutoff', type: 'number', description: 'Percentage of the darkest and of the lightest pixels to ignore, 0 to 10 (0.1)' },
      { name: 'name', type: 'string', description: 'The layer name (Auto Tone, Auto Contrast or Auto Color)' },
      ...where
    ],
    run: async (args) => done((await canvas()).autoAdjust(args))
  },
  {
    id: 'canvas.setAdjustment',
    title: 'Change an adjustment layer',
    description:
      'Change an adjustment layer: settings is JSON merged over what it has now (nested settings merge too), e.g. {"saturation": -30}, {"exposureSettings": {"exposure": 0.5}} or {"reds": {"cyan": -20}} for Selective Color; a gradient map’s ends and a Photo Filter’s color take CSS colours, and a Color Lookup takes {"table": "<a .cube file>"}. canvas.layers shows each adjustment’s settings; the herald-canvas skill lists every field and range.',
    tier: 'act',
    args: [project, { name: 'layer', type: 'string', description: 'The adjustment layer (id or name)', required: true }, { name: 'settings', type: 'string', description: 'JSON object of the settings to change' }, ...appearance],
    run: async (args) => done((await canvas()).setAdjustment(args))
  },
  {
    id: 'canvas.setEffects',
    title: 'Change layer effects',
    description:
      'Add, change, hide or remove layer effects on a picture, text or shape layer: stroke, shadow (drop shadow), innerShadow, outerGlow, innerGlow, colorOverlay. effects is JSON: per effect an object merged over what it has (or over its defaults), false to remove it, {"enabled": false} to hide it and keep its settings. Sizes and distances are layer pixels, angle is where the light comes from (90 is above), color is any CSS colour, opacity 0 to 1. from copies another layer’s effects first (its layer style), replacing the layer’s own; effects then changes them further.',
    tier: 'act',
    args: [
      project,
      { name: 'layer', type: 'string', description: 'The layer (id or name)', required: true },
      { name: 'effects', type: 'string', description: 'JSON object, e.g. {"shadow": {"distance": 12, "blur": 24, "opacity": 0.4}, "stroke": false}' },
      { name: 'from', type: 'string', description: 'A layer (id or name) whose effects to copy onto this one' },
      { name: 'clear', type: 'boolean', description: 'Remove every effect first' }
    ],
    run: async (args) => done((await canvas()).setEffects(args))
  },
  {
    id: 'canvas.mask',
    title: 'Change a layer mask',
    description:
      'Work on a layer’s mask (folders and adjustment layers take masks too): reveal (a mask showing everything) or hide (one hiding everything), revealSelection or hideSelection (from the selection in the Canvas window), invert, apply (bake it into the pixels), enable, disable, remove, link (it moves with the layer) or unlink (it stays put when the layer moves).',
    tier: 'act',
    args: [project, { name: 'layer', type: 'string', description: 'The layer (id or name)', required: true }, { name: 'action', type: 'string', description: 'What to do', required: true, enum: MASK_ACTIONS }],
    run: async (args) => done((await canvas()).mask(args))
  },
  {
    id: 'canvas.placeImage',
    title: 'Place a picture in a box',
    description:
      'Place a picture (a file, or an http(s) address) as a new layer in a box in canvas pixels (the rest of the canvas for what is left out): fit=cover fills the box and cuts what overflows (the default), contain fits inside it, stretch fills it exactly. mask is a grayscale image spread over the same box (white shows, black hides) that becomes the layer’s mask: Veritas saves one for generative fill, so a generated picture is kept to the selection.',
    tier: 'act',
    args: [
      project,
      { name: 'source', type: 'string', description: 'The picture: a file path or an http(s) address', required: true },
      ...box('of the box'),
      { name: 'fit', type: 'string', description: 'cover (the default), contain or stretch' },
      { name: 'mask', type: 'string', description: 'A grayscale image file over the same box: white shows the picture, black hides it' },
      { name: 'name', type: 'string', description: 'The layer name' },
      ...appearance,
      ...where
    ],
    run: async (args) => done((await canvas()).placeImage(args))
  },
  {
    id: 'canvas.removeBackground',
    title: 'Remove the background of a layer',
    description:
      'Find a layer’s subject with the on-device model and hide everything else: mode=mask (the default) adds a layer mask, so nothing is erased; mode=cutout puts just the subject on a new layer above and hides the original. threshold (0 to 1, 0.5 by default) moves the edge in or out, feather softens it in pixels. Needs the ISNet model on this computer: when it is missing, the answer says so, and only the person can allow its download in Veritas Canvas.',
    tier: 'act',
    args: [
      project,
      { name: 'layer', type: 'string', description: 'The layer (id or name); the active layer when left out' },
      { name: 'mode', type: 'string', description: 'mask (the default) or cutout' },
      { name: 'threshold', type: 'number', description: 'Where the edge sits, 0 to 1 (0.5); lower keeps more' },
      { name: 'feather', type: 'number', description: 'Softens the edge, in pixels (0)' },
      { name: 'refine', type: 'boolean', description: 'Snap the edge to the picture’s own outlines, such as hair (true)' }
    ],
    run: async (args) => done((await canvas()).removeBackground(args))
  },
  {
    id: 'canvas.filter',
    title: 'Run a filter on a layer',
    description:
      'Run a Filter menu filter on a layer’s pixels as one undoable step: Unsharp Mask (sharpen: amount 1–500 %, radius 0.1–250 px, threshold 0–255 levels), Smart Sharpen (amount, radius 0.1–64, reduceNoise 0–100 %; sharpens brightness only, without halos), Reduce Noise (strength 0–10, preserveDetails 0–100 %, colorNoise 0–100 %), Gaussian Blur (radius), Motion Blur (angle −90–90, distance 1–2000), High Pass (radius), Add Noise (amount 0.1–400 %, gaussian, monochromatic, seed) or Median (radius 1–25). settings is JSON over the defaults. Text and shape layers are refused (filters would turn them into pixels). Adjustment layers already do blur and noise without changing pixels.',
    tier: 'act',
    args: [
      project,
      { name: 'kind', type: 'string', description: 'The filter: unsharp mask, smart sharpen, reduce noise, gaussian blur, motion blur, high pass, add noise or median', required: true },
      { name: 'settings', type: 'string', description: 'JSON object of settings, e.g. {"amount": 120, "radius": 1.2, "threshold": 2}' },
      { name: 'layer', type: 'string', description: 'The layer (id or name); the active layer when left out' },
      { name: 'inSelection', type: 'boolean', description: 'Only inside what the person selected in the open window' }
    ],
    run: async (args) => done((await canvas()).filter(args))
  },
  {
    id: 'canvas.contentFill',
    title: 'Content-aware fill',
    description:
      'Fill a box on a layer from the pixels around it, to remove something (a person, a wire, a logo) without leaving a hole. Give the box in canvas pixels (x, y, width, height), or leave it out to fill what the person has selected in the open Canvas window. newLayer=true puts the fill on a new layer above instead. It runs on this computer.',
    tier: 'act',
    args: [
      project,
      { name: 'layer', type: 'string', description: 'The layer (id or name); the active layer when left out' },
      ...placement.map((arg) => ({ ...arg, description: `${arg.description.replace(' (alone, it keeps the proportions)', '')} of the area to fill` })),
      { name: 'newLayer', type: 'boolean', description: 'Put the fill on a new layer above, leaving the layer as it is' },
      { name: 'sampling', type: 'string', description: 'around (copy from around the area, the default) or all (from anywhere in the layer)' }
    ],
    run: async (args) => done((await canvas()).contentFill(args))
  },
  {
    id: 'canvas.export',
    title: 'Export an image',
    description:
      'Write the image as a flattened PNG, JPEG or WebP, or as a layered Photoshop document (psd: layers, folders, masks, clipping, blend modes, text and the adjustments Photoshop has, plus the flattened image; the answer lists anything approximated). An existing file is replaced only with overwrite=true, which asks the person first.',
    tier: 'act',
    args: [
      project,
      { name: 'to', type: 'string', description: 'The file to write (full path or ~/…)', required: true },
      { name: 'format', type: 'string', description: 'png, jpeg, webp or psd (from the file name when left out)' },
      { name: 'quality', type: 'number', description: 'JPEG and WebP quality, 0 to 1 (0.9)' },
      { name: 'scale', type: 'number', description: 'Size relative to the canvas, e.g. 0.5 for half (not for psd)' },
      { name: 'overwrite', type: 'boolean', description: 'Replace an existing file' }
    ],
    run: async (args) => done((await canvas()).exportTo(args))
  },
  {
    id: 'canvas.save',
    title: 'Save an image',
    description: 'Save the image in front (or project) as a .comp project: to its own file, or to a new one with to. Projects save themselves after each edit, so this matters mostly for unsaved images.',
    tier: 'mutate',
    args: [project, { name: 'to', type: 'string', description: 'A new project path (full path or ~/…)' }, { name: 'overwrite', type: 'boolean', description: 'Replace an existing project' }],
    run: async (args) => done((await canvas()).save(args))
  },
  {
    id: 'canvas.preview',
    title: 'Look at an image',
    description: 'Render the image flattened to a PNG (at most size pixels on its long side, 1024 by default) and answer with the file, so you can look at what you made.',
    tier: 'read',
    args: [project, { name: 'size', type: 'number', description: 'Longest side in pixels' }],
    run: async (args) => done((await canvas()).preview(args))
  },
  {
    id: 'canvas.undo',
    title: 'Undo in Veritas Canvas',
    description: 'Undo the last change to the image in front (or project), whoever made it; steps undoes several. canvas.history lists the steps.',
    tier: 'act',
    args: [project, { name: 'steps', type: 'number', description: 'How many steps to undo (1)' }],
    phrases: ['undo in canvas'],
    run: async (args) => done((await canvas()).step('undo', args))
  },
  {
    id: 'canvas.redo',
    title: 'Redo in Veritas Canvas',
    description: 'Redo what was last undone in the image in front (or project); steps redoes several.',
    tier: 'act',
    args: [project, { name: 'steps', type: 'number', description: 'How many steps to redo (1)' }],
    run: async (args) => done((await canvas()).step('redo', args))
  },
  {
    id: 'canvas.history',
    title: 'List the history of an image',
    description: 'The steps in the open image’s history (the History panel), oldest first: their names, which ones Hermes or a command made, how many are applied and which are undone. Undo or redo with steps to move through them.',
    tier: 'read',
    args: [project],
    run: async (args) => done((await canvas()).history(args))
  }
]
