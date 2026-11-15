// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* PIXEL ART — the lit metal coin, then two passes over the finished frame:
   postprocessing's own PixelationEffect (big square pixels) and a small
   palette effect that snaps every pixel to a handful of colours through a
   4×4 Bayer dither, so the gradients become the checker ramps of an 8-bit
   game. The coin's material is untouched — the light, the tilt and the glints
   all come through, just in fewer, bigger pixels. Cost: two cheap
   full-screen passes; antialiasing is skipped under it (pixel art wants hard
   edges). */

import { Effect, PixelationEffect } from 'postprocessing'
import { Uniform, Vector3, Color } from 'three'

const MAX = 8
export const PALETTES = {
  gameboy: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'],
  pico8: ['#000000', '#1d2b53', '#7e2553', '#5f574f', '#c2c3c7', '#fff1e8', '#ffa300', '#29adff'],
  cga: ['#000000', '#55ffff', '#ff55ff', '#ffffff'],
  mono: ['#000000', '#ffffff'],
  sepia: ['#1b1105', '#5e4424', '#a9875b', '#f0dfc0'],
}
export const PALETTE_NAMES = Object.keys(PALETTES)

const FRAG = /* glsl */ `
uniform vec3 palette[${MAX}];
uniform int count;
uniform float dither;
uniform float cell;
float bayer4(vec2 p) {
  int x = int(mod(p.x, 4.0));
  int y = int(mod(p.y, 4.0));
  int i = x + y * 4;
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[i]) + 0.5) / 16.0;
}
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  // the dither steps on the big pixels' grid, not the screen's
  float b = bayer4(floor(gl_FragCoord.xy / cell)) - 0.5;
  vec3 c = clamp(inputColor.rgb + b * dither * 0.35, 0.0, 1.0);
  vec3 best = palette[0];
  float bd = 1e9;
  for (int i = 0; i < ${MAX}; i++) {
    if (i >= count) break;
    vec3 d = c - palette[i];
    float dd = dot(d, d);
    if (dd < bd) { bd = dd; best = palette[i]; }
  }
  outputColor = vec4(best, inputColor.a);
}`

class PaletteEffect extends Effect {
  constructor() {
    super('PaletteEffect', FRAG, {
      uniforms: new Map([
        ['palette', new Uniform(Array.from({ length: MAX }, () => new Vector3()))],
        ['count', new Uniform(4)],
        ['dither', new Uniform(0.6)],
        ['cell', new Uniform(4)],
      ]),
    })
  }
  set(name, cellPx, dither) {
    const list = PALETTES[name] ?? PALETTES.gameboy
    const c = new Color()
    list.forEach((hex, i) => {
      c.set(hex) // linear, as the passes work
      this.uniforms.get('palette').value[i].set(c.r, c.g, c.b)
    })
    this.uniforms.get('count').value = list.length
    this.uniforms.get('dither').value = dither
    this.uniforms.get('cell').value = cellPx
  }
}

export default {
  id: 'pixel',
  metallic: true, // the lit metal coin, pixelated
  n: 3,
  props: () => ({}),
  uniforms: () => {},
  /* the post effects, built once per switch to this skin; sync() keeps them live */
  post: () => {
    const pixelate = new PixelationEffect(4)
    const palette = new PaletteEffect()
    return {
      effects: [pixelate, palette],
      sync(L, dpr) {
        const cellPx = Math.max(1, L.pixelSize * dpr)
        pixelate.granularity = cellPx
        palette.set(L.pixelPalette, cellPx, L.pixelDither)
      },
    }
  },
  dials: (L) => ({
    pixelSize: [L.pixelSize, 1, 16, 1], //  css px a pixel
    pixelPalette: { type: 'select', options: PALETTE_NAMES, default: L.pixelPalette },
    pixelDither: [L.pixelDither, 0, 1, 0.01], // the checker ramps between colours
  }),
}
