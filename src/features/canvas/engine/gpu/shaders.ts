/*
 * GLSL for the Veritas Canvas compositor (WebGL2). Targets hold premultiplied colour with row 0 at
 * the top of the document, so a texture coordinate is a document position divided by its size.
 * Blend modes follow the W3C Compositing and Blending formulas, plus the photo-editing modes
 * that list leaves out (linear and vivid light, pin light, hard mix, subtract, divide).
 */

import { BLEND_MODES, type BlendMode } from '../../../../../shared/canvas/comp-format.ts'

/** The number each blend mode has in the shaders: its place in the format's list. */
export const blendModeIndex = (mode: BlendMode | undefined): number => Math.max(0, BLEND_MODES.indexOf(mode ?? 'Normal'))

/**
 * A unit square placed by `u_place` (unit to target pixels) in a target of `u_size` pixels; only
 * the part `u_unitRect` names is drawn (all of it is 0, 0, 1, 1), so a layer held in several
 * textures is drawn a piece at a time.
 */
export const PLACE_VERTEX = `#version 300 es
in vec2 a_unit;
uniform mat3 u_place;
uniform vec2 u_size;
uniform vec4 u_unitRect;
out vec2 v_unit;
void main() {
  v_unit = u_unitRect.xy + a_unit * u_unitRect.zw;
  vec2 p = (u_place * vec3(v_unit, 1.0)).xy;
  gl_Position = vec4(p / u_size * 2.0 - 1.0, 0.0, 1.0);
}
`

/** The whole unit square, and a texture that holds all of its raster. */
export const WHOLE: readonly [number, number, number, number] = [0, 0, 1, 1]

/** The whole target. */
export const FULL_VERTEX = `#version 300 es
in vec2 a_unit;
out vec2 v_unit;
void main() {
  v_unit = a_unit;
  gl_Position = vec4(a_unit * 2.0 - 1.0, 0.0, 1.0);
}
`

/** How much of a layer reaches a pixel: its mask, opacity, enclosing folders' masks and clipping base. */
export const COVERAGE = `
uniform int u_maskMode;          // 0 none, 1 linked to the layer, 2 placed on its own
uniform sampler2D u_mask;
uniform vec4 u_maskWindow;       // the mask's unit square to its texture: xy + unit * zw
uniform mat3 u_docToMask;        // document pixels to the placed mask's unit square
uniform sampler2D u_folderMask;  // enclosing folders' masks, multiplied (same target space)
uniform bool u_hasFolderMask;
uniform sampler2D u_clip;        // the clipping base's coverage (same target space, alpha)
uniform bool u_hasClip;
uniform float u_opacity;
uniform vec2 u_size;             // target pixels
uniform float u_scale;           // target pixels per document pixel
uniform vec2 u_docOffset;        // the document position of the target's pixel 0

float coverage(vec2 unit) {
  vec2 doc = gl_FragCoord.xy / u_scale + u_docOffset;
  vec2 targetUv = gl_FragCoord.xy / u_size;
  float c = u_opacity;
  if (u_maskMode == 1) {
    c *= texture(u_mask, u_maskWindow.xy + unit * u_maskWindow.zw).r;
  } else if (u_maskMode == 2) {
    vec2 m = (u_docToMask * vec3(doc, 1.0)).xy;
    c *= (m.x < 0.0 || m.y < 0.0 || m.x > 1.0 || m.y > 1.0) ? 0.0 : texture(u_mask, u_maskWindow.xy + m * u_maskWindow.zw).r;
  }
  if (u_hasFolderMask) c *= texture(u_folderMask, targetUv).a;
  if (u_hasClip) c *= texture(u_clip, targetUv).a;
  return c;
}
`

/** A layer's pixels with its mask, opacity, folder masks and clipping applied (premultiplied out). */
export const LAYER_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_unit;
uniform sampler2D u_image;
uniform vec4 u_imageWindow;      // the layer's unit square to its texture: xy + unit * zw
uniform bool u_hasImage;
${COVERAGE}
out vec4 o;
void main() {
  vec4 c = u_hasImage ? texture(u_image, u_imageWindow.xy + v_unit * u_imageWindow.zw) : vec4(0.0);
  o = c * coverage(v_unit);
}
`

/** Only coverage, for a clipping base or a folder's mask: white times the coverage. */
export const COVERAGE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_unit;
uniform sampler2D u_image;
uniform vec4 u_imageWindow;
uniform bool u_hasImage;
${COVERAGE}
out vec4 o;
void main() {
  float a = u_hasImage ? texture(u_image, u_imageWindow.xy + v_unit * u_imageWindow.zw).a : 1.0;
  o = vec4(a * coverage(v_unit));
}
`

/** The blend modes on straight colour (`blendColor`), and `composite` for premultiplied layers. */
export const BLEND_FUNCTIONS = `
float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) {
  float l = lum(c);
  float n = min(min(c.r, c.g), c.b);
  float x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-6);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-6);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float sat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 setSat(vec3 c, float s) {
  float mx = max(max(c.r, c.g), c.b);
  float mn = min(min(c.r, c.g), c.b);
  return mx > mn ? (c - mn) * s / (mx - mn) : vec3(0.0);
}
float burn(float b, float s) { return b >= 1.0 ? 1.0 : (s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s)); }
float dodge(float b, float s) { return b <= 0.0 ? 0.0 : (s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s))); }
float softD(float b) { return b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b); }

float separable(int mode, float b, float s) {
  if (mode == 1) return min(b, s);                                                     // Darken
  if (mode == 2) return b * s;                                                         // Multiply
  if (mode == 3) return burn(b, s);                                                    // Color Burn
  if (mode == 4) return max(0.0, b + s - 1.0);                                         // Linear Burn
  if (mode == 5) return max(b, s);                                                     // Lighten
  if (mode == 6) return b + s - b * s;                                                 // Screen
  if (mode == 7) return dodge(b, s);                                                   // Color Dodge
  if (mode == 8) return min(1.0, b + s);                                               // Linear Dodge (Add)
  if (mode == 9) return b <= 0.5 ? 2.0 * s * b : 1.0 - 2.0 * (1.0 - s) * (1.0 - b);    // Overlay
  if (mode == 10) return s <= 0.5 ? b - (1.0 - 2.0 * s) * b * (1.0 - b) : b + (2.0 * s - 1.0) * (softD(b) - b); // Soft Light
  if (mode == 11) return s <= 0.5 ? 2.0 * s * b : 1.0 - 2.0 * (1.0 - s) * (1.0 - b);   // Hard Light
  if (mode == 12) return s <= 0.5 ? burn(b, 2.0 * s) : dodge(b, 2.0 * s - 1.0);        // Vivid Light
  if (mode == 13) return clamp(b + 2.0 * s - 1.0, 0.0, 1.0);                           // Linear Light
  if (mode == 14) return s <= 0.5 ? min(b, 2.0 * s) : max(b, 2.0 * s - 1.0);           // Pin Light
  if (mode == 15) return b + s >= 1.0 ? 1.0 : 0.0;                                     // Hard Mix
  if (mode == 16) return abs(b - s);                                                   // Difference
  if (mode == 17) return b + s - 2.0 * b * s;                                          // Exclusion
  if (mode == 18) return max(0.0, b - s);                                              // Subtract
  if (mode == 19) return s <= 0.0 ? (b <= 0.0 ? 0.0 : 1.0) : min(1.0, b / s);          // Divide
  return s;                                                                            // Normal
}

vec3 blendColor(int mode, vec3 b, vec3 s) {
  if (mode == 20) return setLum(setSat(s, sat(b)), lum(b));                            // Hue
  if (mode == 21) return setLum(setSat(b, sat(s)), lum(b));                            // Saturation
  if (mode == 22) return setLum(s, lum(b));                                            // Color
  if (mode == 23) return setLum(b, lum(s));                                            // Luminosity
  return vec3(separable(mode, b.r, s.r), separable(mode, b.g, s.g), separable(mode, b.b, s.b));
}

/** Source over backdrop with a blend mode, both premultiplied. */
vec4 composite(vec4 b, vec4 s, int mode) {
  vec3 cb = b.a > 0.0 ? b.rgb / b.a : vec3(0.0);
  vec3 cs = s.a > 0.0 ? s.rgb / s.a : vec3(0.0);
  vec3 mixed = (1.0 - b.a) * cs + b.a * clamp(blendColor(mode, cb, cs), 0.0, 1.0);
  return vec4(s.a * mixed + (1.0 - s.a) * b.rgb, s.a + b.a * (1.0 - s.a));
}
`

/** Blend a prepared source (already masked and faded) onto the backdrop. */
export const BLEND_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_backdrop;
uniform sampler2D u_source;
uniform int u_mode;
uniform vec2 u_size;
${BLEND_FUNCTIONS}
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / u_size;
  o = composite(texture(u_backdrop, uv), texture(u_source, uv), u_mode);
}
`

/** Copy a texture as it is (or unpremultiplied, for reading pixels back). */
export const COPY_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_unit;
uniform sampler2D u_source;
uniform bool u_unpremultiply;
uniform vec4 u_background;       // painted under the image (premultiplied); transparent for none
out vec4 o;
void main() {
  vec4 c = texture(u_source, v_unit);
  c = c + u_background * (1.0 - c.a);
  o = u_unpremultiply ? (c.a > 0.0 ? vec4(c.rgb / c.a, c.a) : vec4(0.0)) : c;
}
`

/** The document on screen: a checkerboard under its transparency, inside the page. */
export const DISPLAY_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_unit;
uniform sampler2D u_image;
uniform float u_checker;         // checker square size in device pixels
uniform vec3 u_light;
uniform vec3 u_dark;
out vec4 o;
void main() {
  vec4 c = texture(u_image, v_unit);
  vec2 cell = floor(gl_FragCoord.xy / u_checker);
  vec3 board = mod(cell.x + cell.y, 2.0) < 1.0 ? u_light : u_dark;
  o = vec4(c.rgb + board * (1.0 - c.a), 1.0);
}
`
