---
name: herald-canvas
description: Make and edit pictures in Herald Canvas, the layered image editor in Herald OS - posters, banners, thumbnails, collages and photo fixes through the canvas tool, with editable text and shape layers, layer effects (shadows, strokes, glows) copied between layers, masks, alignment and guides, auto tone and colour, filters (sharpen, denoise, blur), colour lookup tables, on-device background removal and content-aware fill, generated pictures placed where asked, Photoshop files opened and exported with their layers, how to plan an edit from a description, plus the .comp project format and every adjustment setting
metadata:
  hermes:
    tags: [herald-os, canvas, images, design, photo, poster, layers, text, typography, effects, masks, alignment, guides, filters, sharpen, lut, background removal, content-aware fill, generative fill, photoshop, psd]
---

# Herald Canvas

Herald Canvas is the image editor built into Herald OS: layers, folders, masks, blend modes,
adjustment layers, editable text and shapes, drawn on the GPU. The person has the usual tools too
(selections, brush, fill, gradient, transform, crop). Use it whenever the person wants a picture
made or changed:
"make a poster for Saturday's gig", "warm this photo up", "put our logo on these", "make a
YouTube thumbnail". They watch each change appear in the Canvas window, and every change is one
step they can undo there (⌘Z, or `canvas action=undo`).

## The workflow

1. **Start.** `canvas action=new name="Gig poster" width=1080 height=1350 background="#101014"`
   makes a project in `~/Pictures/Herald Canvas/` and opens it; it answers with the `path`. To
   work on something that exists, `canvas action=open path="~/Pictures/photo.jpg"`: an image
   becomes a new project there (the original file is never changed) and the answer gives its
   `path`; a `.comp` project opens as it is. A Photoshop document (`.psd`, `.psb`) keeps its layers,
   folders, masks, text and the adjustments Herald has, and the answer lists anything approximated
   (tell the person what changed). HEIC, TIFF and camera RAW open where the system can convert
   them; on Linux an error names the packages to install. A canvas is at most 30,000 pixels a side
   and 100 million in all. Without `project`, actions work on the image in front.
2. **Build it in layers**, bottom to top. Each `add_layer` lands above the active layer:
   - a picture: `source="~/Downloads/band.jpg"` or `source="https://…"`; it fits inside the canvas,
     centred (`fit=cover` fills it, `fit=none` keeps its own size, or give `x`, `y`, `width`).
   - a colour block: `color="#ff5a36" x=0 y=1100 width=1080 height=250`.
   - a gradient: `gradient="#00000000,#000000cc" angle=90 y=700 height=650` (a fade to dark at
     the bottom, under text). Colours run first to last, each with an optional position
     (`gradient="#1b1340 0%, #6b2d5c 55%, #ffb347"`; ones without share the space between), and
     transparent colours fade while keeping the colour beside them. `style` lays it out: linear
     (the default, along `angle`), radial (from the box's centre out to its corners, a vignette or
     a spotlight), angle (a sweep around the centre), reflected (mirrored from the centre line) or
     diamond.
   - an empty layer to group with others: no source, colour or gradient.
3. **Words.** `add_text content="NIGHT\nMARKET" x=72 y=420 font="Helvetica Neue Bold" size=180
   color="#ffffff"` makes a text layer the person can edit later (double-click it with the Type
   tool). Point text: `x` is its left edge, or its centre with `align=center`, or its right edge
   with `align=right`; `y` is its top. Give `width` for a paragraph that wraps inside a box from
   `x` (at least 16 pixels). `size` is pixels, 1…2000; `tracking` adds pixels between letters
   (−100…1000; a little negative tightens a big headline); `leading` is the line spacing from
   baseline to baseline in pixels (0…5000; 0, the default, is automatic: 120% of the size, and
   about the size itself sets a headline tight). Fonts are installed families with an optional style ("Avenir Next
   Demi Bold", "Georgia Italic"); a missing font falls back to the system font, so check the
   preview. `set_text layer="Headline" content=… color=…` changes it in place and keeps its size,
   turn and position. Text from Compositor or Photoshop may carry per-letter colour and font runs:
   they stay through edits where the edited range allows, and a new `color` or `font` for the
   whole text replaces them.
4. **Shapes.** `add_shape kind=rounded x=72 y=900 width=936 height=300 color="#ff5a36"` (a
   rectangle with `radius`, or `kind=rectangle`, `kind=ellipse` for circles and ovals, `kind=line`
   from `x, y` by `width` across and `height` down, `lineWidth` thick). Panels behind text, rules,
   badges and dots are shapes, not filled boxes: they stay crisp and editable.
   `set_shape layer="Date panel" kind=ellipse color="#ffb347"` restyles one in place: `kind`
   (rectangle, rounded, ellipse, line; a shape becoming a line runs corner to corner in its box),
   `color`, `radius` (rectangles) or `lineWidth` (lines).
5. **Arrange.** `set_layer layer="band" x=… y=… width=…` (one side alone keeps the proportions),
   `rotation=-8`, `opacity=0.8`, `blend="Multiply"`, `order=top`, `visible=false`,
   `folder="Background"`. `group layers="band,glow" name="Hero"` makes a folder. Line layers up
   exactly with `align layers="Logo,Badge" edge=bottom` (each other; one layer, or `to=canvas`,
   lines up with the canvas, `margin=72` keeping that far from its edges; `to=selection` with what
   the person selected; two edges at once, `edge="center,middle"`), and space three or more evenly
   with `align layers="A,B,C" distribute=horizontal` (equal gaps; `vertical`, or by an edge:
   `left`, `center`, …). Layers line up by what they show, not by transparent margins.
   **Guides** lay out the page and everything snaps to them in the window:
   `guides guide=add margins=64 columns=12 gutter=24` (margins as pixels or `"6%"` of the short
   side, columns between them), `guides guide=add axis=vertical position="50%"`, `guides
   guide=add center=true`, `guides guide=remove axis=horizontal position=900`, `guides guide=clear`
   and `guides guide=list`. They never export.
6. **Grade.** For a photo, start with `auto_adjust` (`kind=tone`, the usual first step for a dull
   photo, `contrast`, or `color` to take out a colour cast too): it adds an editable Levels layer
   worked out from the picture. Then `add_adjustment kind="Hue/Saturation" settings={"saturation":
   20}` and the like (every kind and field is under Adjustment settings below). An adjustment
   changes everything below it; with `clip=true` only the layer right below. Change it later with
   `set_adjustment layer="Hue/Saturation" settings={"saturation": 35}` (merged over what it has;
   `canvas action=layers` shows each adjustment's `settings`).
7. **Polish.** `set_effects layer="Headline" effects={"shadow": {"distance": 8, "blur": 16,
   "opacity": 0.45}}` adds a drop shadow; strokes, glows, inner shadows and colour overlays work the
   same way (see Layer effects below), and `set_effects layer="Subtitle" from="Headline"` copies
   one layer's effects onto another. `mask layer="Photo" mask=hide` and friends show or hide parts
   of a layer without erasing anything. `filter` sharpens, denoises or blurs a layer's pixels (see
   Filters below).
8. **The canvas.** `resize width=1080 height=1920 anchor=top` grows or cuts the canvas around an
   anchor (layers keep their pixels, so nothing is lost); `resize scale=0.5`, or `image=true` with
   a width, scales everything instead. `crop x=0 y=135 width=1080 height=1080` keeps a box;
   `crop ratio=4:5` keeps the largest centred box of that shape (`1:1`, `3:2`, `16:9`, `9:16`,
   `original`, or with a box, holds it to the ratio); `crop angle=-1.5` first turns the picture
   that many degrees clockwise (negative is counterclockwise) to level a tilted horizon, then keeps
   the largest box with no empty corners.
9. **Look before you say it is done.** `canvas action=preview` answers with a PNG `file`; view it,
   then fix what is off. Do this after every few steps on anything that matters.
10. **Deliver.** `canvas action=export to="~/Desktop/gig-poster.png"` (or `.jpg` with
   `quality=0.9`, `.webp` up to 16,383 pixels a side; `scale=0.5` for half size). For a printer
   or a designer, `.psd` (or `format=psd`) keeps the layers, folders, masks, clipping, blend modes,
   text and the adjustments Photoshop has (Herald's own eight among them), at full size; Grain, the
   blurs and Add Noise show only in its flattened image, and shapes become pixels; the answer lists
   what was approximated. Replacing
   a file needs `overwrite=true`, and the person is asked first. Projects save themselves after
   every change.

`canvas action=layers` lists everything with ids, kinds, placement and clipping: use it to find
names and to check what is where. Ids are stable; names are friendlier (the topmost layer with a
name wins). `canvas action=history` lists every step, the person's and yours, with the current one
marked; `undo steps=3` (or `redo`) moves through several at once.

## Good design habits

- Ask one question when the brief is thin (size, words, colours); otherwise choose and say what
  you chose. Common sizes: Instagram post 1080×1350, story 1080×1920, YouTube thumbnail
  1280×720, A4 print 2480×3508 at 300 ppi, slide 1920×1080.
- Keep a clear hierarchy: one focal image, at most two type sizes, generous margins (about 6% of
  the short side), and a limited palette pulled from the photo.
- Put text on calm areas, over a gradient fade or on a shape panel, and check contrast in the
  preview. Big headlines read best bold with tight tracking; body text wants a paragraph `width`
  of about 60 characters and 1.2 to 1.4 line spacing.
- Prefer adjustment layers to changing pixels: they stay editable, and the person can switch them
  off.
- Name layers for what they are ("Headline", "Sky"), and folder related pieces.
- Never use pictures the person has not given you or asked you to find; mention sources.

## A poster, start to finish

```
canvas action=new name="Night market" width=1080 height=1350 background="#0d0d12"
canvas action=guides guide=add margins=72
canvas action=add_layer source="~/Pictures/market.jpg" fit=cover name="Photo"
canvas action=auto_adjust kind=color clip=true
canvas action=add_adjustment kind="Color Balance" clip=true settings={"midCyanRed": 12, "midYellowBlue": -14, "highlightYellowBlue": -8}
canvas action=add_layer gradient="#0d0d1200,#0d0d12f0" angle=90 y=650 height=700 name="Fade"
canvas action=add_text content="NIGHT\nMARKET" x=72 y=700 font="Helvetica Neue Bold" size=168 leading=150 tracking=2 color="#fff4e6" name="Headline"
canvas action=set_effects layer="Headline" effects={"shadow": {"distance": 6, "blur": 18, "opacity": 0.5}}
canvas action=add_shape kind=line x=72 y=1100 width=240 lineWidth=8 color="#ffb347" name="Accent rule"
canvas action=add_shape kind=rounded x=72 y=1140 width=600 height=120 radius=24 color="#ffb347" name="Date panel"
canvas action=add_text content="Saturday 9 November · 6 pm till late" x=104 y=1172 width=540 font="Helvetica Neue Medium" size=40 color="#0d0d12" name="Date"
canvas action=align layers="Date panel,Date" edge=middle
canvas action=preview
canvas action=set_text layer="Headline" size=180
canvas action=export to="~/Desktop/night-market.png"
```

## Blend modes

Normal; Darken, Multiply, Color Burn, Linear Burn; Lighten, Screen, Color Dodge, Linear Dodge
(Add); Overlay, Soft Light, Hard Light, Vivid Light, Linear Light, Pin Light, Hard Mix;
Difference, Exclusion, Subtract, Divide; Hue, Saturation, Color, Luminosity. Multiply darkens
(shadows, paper texture), Screen lightens (glows, light leaks), Overlay and Soft Light add
contrast, Color tints while keeping the detail. Folders are pass-through: their own mode is always
Normal, and their opacity and mask apply to everything inside.

## Adjustment settings

Pass only what you change; the rest keeps its default. These are the exact ranges the format
allows (Compositor refuses a whole project over one value outside them, so Herald Canvas refuses
the change and says which field and range): when a command answers with a range error, fix that
value and try again.

- **Hue/Saturation**: `hue` −360…360, `saturation` −100…100, `lightness` −100…100, `colorize`
  true/false (with colorize, hue picks the tint).
- **Levels**: `levels.channel` RGB, Red, Green or Blue, and `levels.ranges`, four ranges (RGB,
  red, green, blue), each `black` 0…254, `gamma` 0.1…9.99, `white` 1…255 (above `black`),
  `outputBlack` 0…255, `outputWhite` 0…255. Give all four ranges when you set them.
- **Curves**: `curves.channels`, four point lists (RGB, red, green, blue) of 2…32
  `{"x": 0…255, "y": 0…255}` in increasing x, the first at x 0 and the last at x 255. A gentle
  S for contrast: `[{"x":0,"y":0},{"x":64,"y":52},{"x":192,"y":204},{"x":255,"y":255}]`.
- **Exposure**: `exposureSettings.exposure` −20…20 stops, `offset` −0.5…0.5, `gamma` 0.01…9.99
  (worked in linear light).
- **Gradient Map**: `gradientMapSettings.shadows` and `highlights` as `{"red", "green", "blue"}`
  0…1 or any CSS colour (`"#1b1340"`), `reversed`.
- **Grain**: `grainSettings.amount` 0…100, `size` 0.5…20 pixels, `roughness` 0…100, `seed`.
- **Invert**: no settings.
- **Black & White**: `blackWhiteSettings.reds`, `yellows`, `greens`, `cyans`, `blues`,
  `magentas` −200…300 (how light each colour turns), `tint`, `tintHue` 0…360, `tintSaturation`
  0…100.
- **Color Balance**: `colorBalanceSettings` with `shadowCyanRed`, `shadowMagentaGreen`,
  `shadowYellowBlue`, the same three for `mid…` and `highlight…`, each −100…100 (positive is
  towards red, green, blue), and `preserveLuminosity`.
- **Gaussian Blur**: `blurRadius` 0.1…250 pixels.
- **Motion Blur**: `motionAngle` −90…90 (counterclockwise from horizontal), `motionDistance`
  1…2000 pixels.
- **Add Noise**: `noiseAmount` 0.1…400 (percent), `noiseGaussian`, `noiseMonochromatic`,
  `noiseSeed`.

Eight more are Herald Canvas's own; their settings are flat (no nested record of their own):

- **Brightness/Contrast**: `brightness` −150…150 (lifts or lowers the midtones; black and white
  stay), `contrast` −50…100.
- **Vibrance**: `vibrance` −100…100 (strengthens dull colours most and spares skin tones),
  `saturation` −100…100 (as Hue/Saturation saturates).
- **Photo Filter**: `color` any CSS colour or `{"red", "green", "blue"}` 0…1 (a warming orange to
  start), `density` 0…100 (percent), `preserveLuminosity` (true keeps the brightness).
- **Channel Mixer**: `red`, `green` and `blue`, each output channel as
  `{"red", "green", "blue", "constant"}` percentages of the inputs, with `constant` −200…200
  (all four take −200…200); `monochrome` true makes one gray from the `gray` row (default 40, 40,
  20).
- **Selective Color**: per range `reds`, `yellows`, `greens`, `cyans`, `blues`, `magentas`,
  `whites`, `neutrals`, `blacks`, an object of `cyan`, `magenta`, `yellow` and `black` −100…100
  (percent of ink to add or take away), and `absolute` (false, the default, changes each ink by that
  share of what is there).
- **Posterize**: `levels` 2…255 (bands a channel).
- **Threshold**: `level` 1…255 (brighter is white, darker black).
- **Color Lookup**: `table`, a `.cube` file (`settings={"table": "~/LUTs/Portra.cube"}`): a 3D
  colour table from a grading tool, 2…65 entries a side. Its name and size show in `layers`.

Compositor (the Mac app that shares the format) shows Brightness/Contrast exactly, Vibrance only
with `vibrance` 0, a Photo Filter only with `preserveLuminosity` false, and the rest as no change;
mention that when the person says they will open the project in Compositor.

An adjustment never adds opacity: over transparency it shows nothing, and a blur softens colour
but keeps the edges of what is below it. A mask on an adjustment layer limits where it applies.

Quick recipes: warmer, `Color Balance` with `midCyanRed` +10 and `midYellowBlue` −15 (or a
`Photo Filter` at density 20); moodier, `Curves` with a lowered midpoint plus
`Hue/Saturation saturation=-25`; brighter, `Exposure exposure=0.4`, or `Brightness/Contrast` with
`brightness` 30 to lift the midtones; punchier colour without garish skin, `Vibrance vibrance=35`;
vintage, `Gradient Map` from deep blue to cream at opacity 0.35 with blend Soft Light, plus
`Grain amount=20`; a film look, `Color Lookup` with the person's `.cube` at opacity 0.6 to 1;
dramatic black and white, `Channel Mixer` with `monochrome` true and `gray` {"red": 60,
"green": 50, "blue": -10}; a screen-print poster, `Posterize levels=5`; dreamy,
`Gaussian Blur blurRadius=12` at opacity 0.4 with blend Screen.

## Filters

`filter layer="Photo" kind=… settings={…}` changes a layer's pixels for good, as one step the
person can undo (with `inSelection=true`, only inside what they selected in the window). Prefer an
adjustment layer when there is one for the job (the Gaussian Blur, Motion Blur and Add Noise
adjustments stay editable). Not for text or shape layers.

- **unsharp mask**: `amount` 1…500 (percent, 100), `radius` 0.1…250 pixels (1), `threshold` 0…255
  (0; raise it to leave skin and sky alone). Gentle: 80, 1, 3; crisp detail: 150, 0.8, 2.
- **smart sharpen**: `amount` 1…500 (150), `radius` 0.1…64 (1), `reduceNoise` 0…100 (10). Sharpens
  brightness only and holds back halos: the better choice for portraits and noisy photos.
- **reduce noise**: `strength` 0…10 (6), `preserveDetails` 0…100 (60), `colorNoise` 0…100 (45).
- **gaussian blur**: `radius` 0.1…250 (4). **motion blur**: `angle` −90…90, `distance` 1…2000.
- **high pass**: `radius` 0.1…250 (10): fine detail on gray; on a copy of the photo set to Overlay
  or Soft Light, it sharpens.
- **add noise**: `amount` 0.1…400 (10), `gaussian`, `monochromatic`, `seed`. **median**: `radius`
  1…25 (2): takes out specks and dust.

## Layer effects

`set_effects layer=… effects={…}` puts effects on a picture, text or shape layer (not on folders
or adjustment layers). Per effect, an object merged over what the layer has (or over the effect's
defaults when it has none), `true` to add it with its defaults, `false` to remove it, and
`{"enabled": false}` to hide it while keeping its settings. `clear=true` removes them all first.
Sizes and distances are layer pixels; `color` is any CSS colour (or `red`, `green`, `blue` 0…1);
`opacity` is 0…1. The effects follow the layer's own mask, and the layer's opacity and blend mode
apply to the layer and its effects together.

- **shadow** (drop shadow, under the layer): `angle` −360…360, where the light comes from (90 is
  straight above, so the shadow falls straight down; 120 drops it down and to the right),
  `distance` 0…5000, `blur` 0…500 (how soft), `color`, `opacity`. Defaults 90, 20, 20, black, 0.5.
- **innerShadow** (inside the edges, as if cut out): the same fields; defaults 90, 10, 10, black,
  0.5.
- **outerGlow**: `size` 0…500, `color`, `opacity`; defaults 20, white, 0.75.
- **innerGlow**: `size` 0…500, `color`, `opacity`; defaults 10, white, 0.75.
- **stroke**: `size` 0…500, `inside` (false puts it outside the edge, with round corners),
  `color`, `opacity`; defaults 4, black, 1, outside.
- **colorOverlay** (tints the layer, keeping its shape): `color`, `opacity`; defaults red, 1.

Recipes:

- A soft drop shadow for a cut-out photo or a card:
  `effects={"shadow": {"angle": 120, "distance": 18, "blur": 40, "opacity": 0.35}}`.
- A glow on a headline over a dark picture:
  `effects={"outerGlow": {"size": 28, "color": "#ffd27a", "opacity": 0.8}}`.
- Legible white text on a busy photo: `effects={"stroke": {"size": 3, "color": "#111"},
  "shadow": {"distance": 4, "blur": 10, "opacity": 0.6}}`.
- A sticker look: `effects={"stroke": {"size": 14, "color": "#fff"}, "shadow": {"distance": 6,
  "blur": 12, "opacity": 0.3}}`.
- Hide the stroke but keep it for later: `effects={"stroke": {"enabled": false}}`.

## Masks

A mask shows (white) or hides (black) parts of a layer without erasing anything; folders and
adjustment layers take masks too. `mask layer=… mask=<action>`:

- `reveal` or `hide`: a mask showing or hiding everything (replacing one the layer has).
- `revealSelection` or `hideSelection`: from what the person has selected in the Canvas window.
- `invert`, `enable`, `disable` (kept but not used), `remove`.
- `apply`: bake the mask into the pixels and drop it (not for folders or adjustments).
- `unlink`: the mask stays where it is when the layer moves; `link` ties it to the layer again.

Typical use: a vignette is a `Curves` or `Exposure` layer that darkens, with a mask hiding its
centre; a two-tone grade is two adjustments, each masked to its half.

## On-device AI tools

These run on the person's computer (nothing is uploaded) with models they download once, when
they first use the tool in the Canvas window. A command never downloads a model: when one is
missing, the answer says which, and you ask the person to allow it in Herald Canvas (Layer >
Remove Background, or the Object Select tool), then try again.

- **Remove a background**: `canvas action=remove_background layer="Photo"` hides everything but the
  subject with a layer mask, so nothing is erased (`mask layer="Photo" mask=invert` keeps the
  background instead). `mode=cutout` puts just the subject on a new layer above and hides the original.
  `threshold` (0…1, 0.5) moves the edge in (higher) or out (lower), `feather` softens it in pixels,
  and `refine=false` keeps the model's own edge. Good for product shots, portraits and stickers.
- **Remove something / fill a hole**: `canvas action=content_fill layer="Photo" x=… y=… width=…
  height=…` fills that box from the pixels around it (a passer-by, a wire, a logo on a wall). Give a
  box a little larger than the thing; `newLayer=true` keeps the fill on its own layer so it can be
  masked or undone separately. Without a box it fills what the person selected in the open window.
- **Place a picture exactly**: `canvas action=place_image source=… x=… y=… width=… height=…`
  (`fit=cover` fills the box and cuts the overflow, `contain` fits inside, `stretch`), with
  `mask_image=…` a grayscale picture over the same box (white shows). This is how generated
  pictures land where the person asked.

The person also has Select > Subject, Select > Select and Mask (refining an edge for hair and fur),
Edit > Content-Aware Fill, the Spot Healing and Healing brushes (J), the Clone Stamp (S) and the
Object Select tool (W, with the Magic Wand) in the window; point them there when a job needs a
hand on the picture.

## Generated pictures

When the person asks the Canvas window for Generative Fill or a New Generated Layer, Herald sends
you a request naming the project, the box, the files it saved (a picture of the area and its mask)
and the file to save your picture to. Make the picture with your image generation tool (pick its
aspect ratio from the box; if it can edit an image, give it the area's picture), save it there,
place it with `place_image` exactly as the request says, check it with `preview`, and say what you
made. If you have no image generation tool, or it fails, say so in a sentence and place nothing.

## Planning an edit from a description

Requests like "make it moodier", "warmer and brighter", "put the logo bottom right" or "make the sky
dramatic" come from the window's Ask Hermes field with the project, its layers and a preview.

1. Look first: `canvas action=preview` and `canvas action=layers`. Decide what the request means
   for this picture (moodier: darker midtones, less saturation, cooler shadows, a vignette).
2. Prefer adjustment layers over changing pixels: `auto_adjust` as a first pass on a dull or
   tinted photo, Curves, Levels or Brightness/Contrast for tone, Hue/Saturation or Vibrance for
   colour strength, Color Balance, a Photo Filter or a Gradient Map for colour casts, Exposure for
   brightness, Color Lookup for a look the person has as a `.cube` file.
   Clip an adjustment to one layer (`clip=true`) when only that layer should change, and mask an
   adjustment (a vignette is a darkening Curves layer with its centre masked out) to limit it.
3. Keep it editable and tidy: name what you add ("Moody grade", "Vignette"), group related layers,
   use layer effects for shadows and glows, and `place_image` or `add_layer` for new pictures,
   placed with an explicit box ("bottom right" is a box a margin of about 4% in from the corner).
4. Look again with `preview`, adjust what is too strong (lower an adjustment layer's opacity
   rather than redoing it), and finish by telling the person in a sentence or two what you changed
   and why, so they can tweak it or undo it.

## The .comp format (for writing projects directly)

For many layers at once it can be faster to write a project yourself; Herald Canvas reloads an
open project the moment its files change. A project is a folder `Name.comp` holding
`manifest.json` and `images/`:

```json
{
  "format": "com.compositor.project",
  "version": 11,
  "colorSpace": "sRGB",
  "resolution": 72,
  "documentID": "<UUID>",
  "width": 1080,
  "height": 1350,
  "activeLayerID": "<UUID of a layer>",
  "guides": [],
  "layers": [
    {
      "id": "6F1D…",
      "name": "Photo",
      "isVisible": true,
      "isGroup": false,
      "opacity": 1,
      "blendMode": "Normal",
      "imageFile": "6F1D….png",
      "transform": { "origin": [0, 0], "size": [1080, 1350], "rotation": 0, "flipX": false, "flipY": false, "sampling": "High quality" }
    }
  ]
}
```

Rules that matter (break one and the whole file is refused):

- `layers` run bottom to top. A folder has `"isGroup": true` and no `imageFile`; its children
  carry `"parentID"` and come right after it.
- Ids are uppercase UUIDs, unique. A layer's picture is `images/<ID>.png` (8-bit RGBA PNG) and
  its mask `images/<ID>.mask.png` (8-bit grayscale, white shows), named after the layer exactly.
- Every layer has a `name` that is not blank.
- `transform.origin` is the top-left corner in canvas pixels (−1000000…1000000), `size` the drawn
  size (1…300000 a side; the PNG is stretched to it), `rotation` degrees clockwise around the
  centre, `sampling` "High quality", "Smooth" or "Nearest".
- Write every image first, then `manifest.json` last, through a temporary file and a rename, so
  the editor never reads half a project.
- `maskSourceID` clips a layer to another (never a folder, and never to a folder or an adjustment
  layer); `adjustment` makes an adjustment layer (no
  `imageFile`; its record needs `kind`, `hue`, `saturation`, `lightness`, `colorize`, plus full
  `levels` and `curves`). `effects` holds the layer effects, one record per effect as listed under
  Layer effects (a missing record means no such effect). An unlinked mask has `"maskLinked": false`
  and its own `maskPlacement` transform. Keep fields you do not understand exactly as they were.
- A text or shape layer is a normal pixel layer (its PNG shows it) with a `text` record
  (`content`, `fontName` as a PostScript name, `fontSize` in pixels 1…2000, `red`/`green`/`blue`
  0…1, `alignment` Left, Center or Right, `tracking` −100…1000, `leading` 0…5000 (baseline to
  baseline; 0 is automatic), `boxSize` [width, height] for paragraph text, each 16…30000, and
  optional `colorRuns` (`location`, `length`, `red`, `green`, `blue`) and `fontRuns` (`location`,
  `length`, `fontName`), sorted, apart and inside the text, counted in UTF-16 units)
  or a `shape` record (`kind` Rectangle, Ellipse or Line, `red`/`green`/`blue`,
  `cornerRadius`, and for lines `lineWidth` with `start` and `end` as fractions of the box). The
  PNG must match the record, so prefer `add_text` and `add_shape`, which draw it; painting on such
  a layer turns it into plain pixels.
- `guides` is a list of `{"id": "<UUID>", "axis": "vertical" or "horizontal", "position": <px>}`.
- Herald's own adjustments (Brightness/Contrast and the others above) go in `heraldAdjustment`,
  never in `adjustment.kind`: `{"kind": "Vibrance", "vibrance": 30, "saturation": 0}`, with the
  fields listed under Adjustment settings. The layer still needs a complete `adjustment` record
  (Compositor reads that one); Herald makes it again from `heraldAdjustment` when it opens the
  project, so a Levels record with its defaults will do. A Color Lookup's table is the file
  `images/<ID>.cube`, with `"name"` and `"size"` (its LUT_3D_SIZE) in the record. Prefer
  `add_adjustment`, which writes all of it.

The same files open in Compositor on a Mac.
