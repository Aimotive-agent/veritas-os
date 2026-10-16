/*
 * GLSL for adjustment layers: a line-by-line transliteration of engine/adjust-math.ts, which is
 * where the maths is explained and tested. Change the two together.
 */

import { BALANCE_REACH, GRAIN_DETAIL, GRAIN_REACH, NOISE_REACH } from '../adjust-math.ts'
import { BLEND_FUNCTIONS, COVERAGE } from './shaders.ts'

/** The `u_kind` each adjustment kind runs as in the shader. */
export const SHADER_KIND = {
  'Hue/Saturation': 0,
  Levels: 1,
  Curves: 1,
  Exposure: 2,
  'Gradient Map': 3,
  Grain: 4,
  Invert: 5,
  'Black & White': 6,
  'Color Balance': 7,
  'Gaussian Blur': 8,
  'Motion Blur': 8,
  'Add Noise': 9
} as const

/** The same for Veritas's own kinds (engine/herald-adjust.ts); Brightness/Contrast runs as its tone curve. */
export const HERALD_SHADER_KIND = {
  'Brightness/Contrast': 1,
  Vibrance: 10,
  'Photo Filter': 11,
  'Channel Mixer': 12,
  'Selective Color': 13,
  Posterize: 14,
  Threshold: 15,
  'Color Lookup': 16
} as const

const f = (value: number): string => (Number.isInteger(value) ? value.toFixed(1) : String(value))

const ADJUST_FUNCTIONS = `
float clamp01(float v) { return clamp(v, 0.0, 1.0); }
float wrapDegrees(float d) { return mod(d, 360.0); }

float srgbToLinear(float v) { return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4); }
float linearToSrgb(float v) { return v <= 0.0031308 ? v * 12.92 : 1.055 * pow(v, 1.0 / 2.4) - 0.055; }

vec3 rgbToHsl(vec3 c) {
  float mx = max(max(c.r, c.g), c.b);
  float mn = min(min(c.r, c.g), c.b);
  float l = (mx + mn) * 0.5;
  if (mx == mn) return vec3(0.0, 0.0, l);
  float d = mx - mn;
  float s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
  float h;
  if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
  else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
  else h = (c.r - c.g) / d + 4.0;
  return vec3(h * 60.0, s, l);
}

float hueChannel(float p, float q, float t) {
  float u = t < 0.0 ? t + 1.0 : (t > 1.0 ? t - 1.0 : t);
  if (u < 1.0 / 6.0) return p + (q - p) * 6.0 * u;
  if (u < 0.5) return q;
  if (u < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - u) * 6.0;
  return p;
}

vec3 hslToRgb(float h, float s, float l) {
  if (s <= 0.0) return vec3(l);
  float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
  float p = 2.0 * l - q;
  float t = wrapDegrees(h) / 360.0;
  return vec3(hueChannel(p, q, t + 1.0 / 3.0), hueChannel(p, q, t), hueChannel(p, q, t - 1.0 / 3.0));
}

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// Hue/Saturation.
uniform float u_hue;
uniform float u_saturation;
uniform float u_lightness;
uniform bool u_colorize;

vec3 hueSaturation(vec3 c) {
  vec3 hsl = rgbToHsl(c);
  float h = hsl.x;
  float s = hsl.y;
  float l = hsl.z;
  if (u_colorize) {
    h = wrapDegrees(u_hue);
    s = clamp01(u_saturation / 100.0);
  } else {
    h = wrapDegrees(h + u_hue);
    float amount = clamp(u_saturation / 100.0, -1.0, 1.0);
    s = amount <= 0.0 ? s * (1.0 + amount) : (amount >= 1.0 ? (s > 0.0 ? 1.0 : 0.0) : min(1.0, s / (1.0 - amount)));
  }
  float k = clamp(u_lightness / 100.0, -1.0, 1.0);
  l = k >= 0.0 ? l + (1.0 - l) * k : l * (1.0 + k);
  return hslToRgb(h, s, clamp01(l));
}

// Levels and Curves: 256 entries a row; rows RGB, red, green, blue.
uniform sampler2D u_tables;

float lookupRow(int row, float v) {
  float x = clamp01(v) * 255.0;
  int lo = min(254, int(floor(x)));
  return mix(texelFetch(u_tables, ivec2(lo, row), 0).r, texelFetch(u_tables, ivec2(lo + 1, row), 0).r, x - float(lo));
}

vec3 applyTables(vec3 c) {
  return vec3(lookupRow(0, lookupRow(1, c.r)), lookupRow(0, lookupRow(2, c.g)), lookupRow(0, lookupRow(3, c.b)));
}

// Exposure: u_exposureScale is 2 to the power of the stops.
uniform float u_exposureScale;
uniform float u_offset;
uniform float u_gamma;

float exposed(float v) { return clamp01(linearToSrgb(pow(max(0.0, srgbToLinear(v) * u_exposureScale + u_offset), 1.0 / u_gamma))); }
vec3 exposure(vec3 c) { return vec3(exposed(c.r), exposed(c.g), exposed(c.b)); }

// Gradient Map: the ends already swapped when reversed.
uniform vec3 u_dark;
uniform vec3 u_light;

vec3 gradientMap(vec3 c) { return mix(u_dark, u_light, clamp01(luma(c))); }

// Black & White: reds, yellows, greens, cyans, blues, magentas.
uniform float u_weights[6];
uniform bool u_tint;
uniform float u_tintHue;
uniform float u_tintSaturation;

vec3 blackWhite(vec3 c) {
  float mx = max(max(c.r, c.g), c.b);
  float mn = min(min(c.r, c.g), c.b);
  float md = c.r + c.g + c.b - mx - mn;
  float primary;
  float secondary;
  if (c.r >= c.g && c.r >= c.b) {
    primary = u_weights[0];
    secondary = c.g >= c.b ? u_weights[1] : u_weights[5];
  } else if (c.g >= c.b) {
    primary = u_weights[2];
    secondary = c.r >= c.b ? u_weights[1] : u_weights[3];
  } else {
    primary = u_weights[4];
    secondary = c.g >= c.r ? u_weights[3] : u_weights[5];
  }
  float gray = clamp01(mn + (md - mn) * secondary / 100.0 + (mx - md) * primary / 100.0);
  return u_tint ? hslToRgb(u_tintHue, clamp01(u_tintSaturation / 100.0), gray) : vec3(gray);
}

// Color Balance: each tone's shift for red, green and blue, already divided by 100.
uniform vec3 u_shadows;
uniform vec3 u_mids;
uniform vec3 u_highlights;
uniform bool u_preserve;

vec3 tonalWeights(float l) {
  return vec3(1.0 - smoothstep(0.0, 0.6, l), smoothstep(0.0, 0.5, l) * (1.0 - smoothstep(0.5, 1.0, l)), smoothstep(0.4, 1.0, l));
}

vec3 colorBalance(vec3 c) {
  vec3 w = tonalWeights(luma(c));
  vec3 balanced = clamp(c + (u_shadows * w.x + u_mids * w.y + u_highlights * w.z) * ${f(BALANCE_REACH)}, 0.0, 1.0);
  return u_preserve ? clamp(setLum(balanced, lum(c)), 0.0, 1.0) : balanced;
}

// Noise and grain.
uint pcg(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

float unitOf(uint h) { return float(h >> 8u) / 16777216.0; }
uint pixelHash(uint x, uint y, uint seed) { return pcg(x + pcg(y + pcg(seed))); }

uniform float u_amount;
uniform bool u_gaussian;
uniform bool u_monochromatic;
uniform uint u_seed;

float noiseChannel(uint base, int i) {
  float amplitude = u_amount / 100.0 * ${f(NOISE_REACH)};
  uint key = u_monochromatic ? base : pcg(base + uint(i) + 1u);
  float u = unitOf(key);
  if (!u_gaussian) return (u * 2.0 - 1.0) * amplitude;
  return sqrt(-2.0 * log(1.0 - u)) * cos(6.283185307179586 * unitOf(pcg(key))) * (amplitude / sqrt(3.0));
}

vec3 addNoise(vec3 c, uvec2 p) {
  uint base = pixelHash(p.x, p.y, u_seed);
  return clamp(c + vec3(noiseChannel(base, 0), noiseChannel(base, 1), noiseChannel(base, 2)), 0.0, 1.0);
}

float lattice(int ix, int iy, uint seed) { return unitOf(pixelHash(uint(ix), uint(iy), seed)) * 2.0 - 1.0; }
float fade(float t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }

float valueNoise(vec2 p, float cell, uint seed) {
  vec2 uv = p / cell;
  vec2 i = floor(uv);
  int ix = int(i.x);
  int iy = int(i.y);
  float tx = fade(uv.x - i.x);
  float ty = fade(uv.y - i.y);
  float top = mix(lattice(ix, iy, seed), lattice(ix + 1, iy, seed), tx);
  float bottom = mix(lattice(ix, iy + 1, seed), lattice(ix + 1, iy + 1, seed), tx);
  return mix(top, bottom, ty);
}

uniform float u_grainSize;
uniform float u_roughness;
uniform uint u_fineSeed;

vec3 grain(vec3 c, vec2 p) {
  float size = max(0.1, u_grainSize);
  float coarse = valueNoise(p, size, u_seed);
  float fine = valueNoise(p, max(0.5, size * ${f(GRAIN_DETAIL)}), u_fineSeed);
  float n = mix(coarse, fine, clamp01(u_roughness / 100.0)) * 1.7;
  float l = clamp01(luma(c));
  float delta = n * (u_amount / 100.0) * ${f(GRAIN_REACH)} * (0.3 + 2.8 * l * (1.0 - l));
  return clamp(c + delta, 0.0, 1.0);
}

// Vibrance, then Saturation as Hue/Saturation saturates (u_hue and u_lightness at 0).
uniform float u_vibrance;

float skinGuard(float hue) {
  float distance = abs(mod(hue - 25.0 + 540.0, 360.0) - 180.0);
  return 1.0 - 0.6 * max(0.0, 1.0 - distance / 35.0);
}

vec3 vibrance(vec3 c) {
  vec3 o = c;
  if (u_vibrance != 0.0) {
    float chroma = max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
    float amount = u_vibrance / 100.0;
    float k = amount > 0.0 ? 1.0 + amount * (1.0 - chroma) * (1.0 - chroma) * 1.5 * skinGuard(rgbToHsl(c).x) : 1.0 + amount * (1.0 - chroma * 0.5);
    float gray = luma(c);
    o = clamp(gray + (c - gray) * k, 0.0, 1.0);
  }
  return u_saturation != 0.0 ? hueSaturation(o) : o;
}

// Photo Filter: u_filter is what each channel is multiplied by.
uniform vec3 u_filter;

vec3 photoFilter(vec3 c) {
  vec3 filtered = c * u_filter;
  return u_preserve ? clamp(setLum(filtered, lum(c)), 0.0, 1.0) : filtered;
}

// Channel Mixer: each row is the red, green and blue shares and the constant, already divided by 100.
uniform vec4 u_mixRed;
uniform vec4 u_mixGreen;
uniform vec4 u_mixBlue;
uniform vec4 u_mixGray;
uniform bool u_monochrome;

float mixed(vec3 c, vec4 row) { return clamp01(dot(row.rgb, c) + row.a); }

vec3 channelMixer(vec3 c) {
  if (u_monochrome) return vec3(mixed(c, u_mixGray));
  return vec3(mixed(c, u_mixRed), mixed(c, u_mixGreen), mixed(c, u_mixBlue));
}

// Selective Color: cyan, magenta, yellow and black for reds, yellows, greens, cyans, blues, magentas, whites, neutrals, blacks, divided by 100.
uniform vec4 u_inks[9];
uniform bool u_absolute;

vec3 selectiveColor(vec3 c) {
  float mx = max(max(c.r, c.g), c.b);
  float mn = min(min(c.r, c.g), c.b);
  float md = c.r + c.g + c.b - mx - mn;
  float w[9];
  for (int i = 0; i < 9; i++) w[i] = 0.0;
  if (c.r >= c.g && c.r >= c.b) {
    w[0] = mx - md;
    if (c.g >= c.b) w[1] = md - mn; else w[5] = md - mn;
  } else if (c.g >= c.b) {
    w[2] = mx - md;
    if (c.r >= c.b) w[1] = md - mn; else w[3] = md - mn;
  } else {
    w[4] = mx - md;
    if (c.g >= c.r) w[3] = md - mn; else w[5] = md - mn;
  }
  w[6] = clamp01((mn - 0.5) * 2.0);
  w[7] = clamp01(1.0 - abs(mx - 0.5) - abs(mn - 0.5));
  w[8] = clamp01((0.5 - mx) * 2.0);
  float black = 1.0 - mx;
  vec3 change = vec3(0.0);
  for (int i = 0; i < 9; i++) {
    if (w[i] == 0.0) continue;
    vec4 ink = u_inks[i];
    float k = ink.w * (u_absolute ? 1.0 : black);
    vec3 share = u_absolute ? vec3(1.0) : 1.0 - c;
    change += w[i] * (ink.xyz * share + k);
  }
  return clamp(c - change, 0.0, 1.0);
}

// Posterize and Threshold, on the 8-bit values the channels show; a value right on a step reaches it.
uniform float u_levels;
uniform float u_level;

vec3 eightBit(vec3 c) { return floor(clamp(c, 0.0, 1.0) * 255.0 + 0.5); }
vec3 posterize(vec3 c) { return min(vec3(u_levels - 1.0), floor(eightBit(c) * u_levels / 255.0 + 1e-4)) / (u_levels - 1.0); }
vec3 threshold(vec3 c) { return vec3(dot(eightBit(c), vec3(0.2126, 0.7152, 0.0722)) + 1e-4 >= u_level ? 1.0 : 0.0); }

// Color Lookup: a table u_tableSize entries a side, spanning u_domainMin to u_domainMax.
uniform sampler3D u_table;
uniform float u_tableSize;
uniform vec3 u_domainMin;
uniform vec3 u_domainMax;

vec3 lookUp(vec3 c) {
  vec3 p = clamp((c - u_domainMin) / (u_domainMax - u_domainMin), 0.0, 1.0);
  return clamp(texture(u_table, (p * (u_tableSize - 1.0) + 0.5) / u_tableSize).rgb, 0.0, 1.0);
}
`

/**
 * An adjustment over the backdrop, every pixel of the target: the adjusted colour blended with the
 * backdrop's in the layer's mode, mixed in by the coverage, and the backdrop's alpha kept (an
 * adjustment never adds opacity). Blurs read their colour from `u_source`, the blurred backdrop.
 */
export const ADJUST_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;
uniform sampler2D u_backdrop;
uniform sampler2D u_source;
uniform vec2 u_sourceSize;
uniform float u_sourceOffset;
uniform int u_kind;
uniform int u_mode;
${COVERAGE}
${BLEND_FUNCTIONS}
${ADJUST_FUNCTIONS}
out vec4 o;
void main() {
  vec4 b = texelFetch(u_backdrop, ivec2(gl_FragCoord.xy), 0);
  if (b.a <= 0.0) {
    o = vec4(0.0);
    return;
  }
  vec3 cb = clamp(b.rgb / b.a, 0.0, 1.0);
  vec2 doc = gl_FragCoord.xy / u_scale + u_docOffset;
  vec3 ca = cb;
  if (u_kind == 0) ca = hueSaturation(cb);
  else if (u_kind == 1) ca = applyTables(cb);
  else if (u_kind == 2) ca = exposure(cb);
  else if (u_kind == 3) ca = gradientMap(cb);
  else if (u_kind == 4) ca = grain(cb, doc);
  else if (u_kind == 5) ca = 1.0 - cb;
  else if (u_kind == 6) ca = blackWhite(cb);
  else if (u_kind == 7) ca = colorBalance(cb);
  else if (u_kind == 8) {
    vec4 s = texture(u_source, (gl_FragCoord.xy + u_sourceOffset) / u_sourceSize);
    ca = s.a > 1e-5 ? clamp(s.rgb / s.a, 0.0, 1.0) : cb;
  } else if (u_kind == 9) ca = addNoise(cb, uvec2(floor(doc)));
  else if (u_kind == 10) ca = vibrance(cb);
  else if (u_kind == 11) ca = photoFilter(cb);
  else if (u_kind == 12) ca = channelMixer(cb);
  else if (u_kind == 13) ca = selectiveColor(cb);
  else if (u_kind == 14) ca = posterize(cb);
  else if (u_kind == 15) ca = threshold(cb);
  else if (u_kind == 16) ca = lookUp(cb);
  vec3 blended = clamp(blendColor(u_mode, cb, ca), 0.0, 1.0);
  o = vec4(mix(cb, blended, coverage(vec2(0.0))) * b.a, b.a);
}
`
