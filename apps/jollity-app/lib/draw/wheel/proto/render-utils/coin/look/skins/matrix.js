// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* MATRIX SCREEN — the face as a dark screen with glyph rain on it: the UV
   square cut into cells, each column falling at its own speed with a white
   leading glyph and a fading green trail, each cell's glyph flickering to
   another now and then. The glyphs come from a 4×4 atlas drawn once on a
   canvas (half-width katakana and digits, mirrored as in the film). The 3D
   letters' walls glow; faint scanlines over it all. Cheap: an atlas read and
   a few hashes per pixel. */

import * as THREE from 'three'

const GLYPHS = 'ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘ01'.split('')
let atlas = null
function glyphAtlas() {
  if (atlas) return atlas
  const S = 256
  const cell = S / 4
  const c = document.createElement('canvas')
  c.width = c.height = S
  const g = c.getContext('2d')
  g.fillStyle = '#000'
  g.fillRect(0, 0, S, S)
  g.fillStyle = '#fff'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.font = `bold ${cell * 0.78}px ui-monospace, Menlo, monospace`
  GLYPHS.forEach((ch, i) => {
    const x = (i % 4) * cell + cell / 2
    const y = Math.floor(i / 4) * cell + cell / 2
    g.save()
    g.translate(x, y)
    g.scale(-1, 1)
    g.fillText(ch, 0, 0)
    g.restore()
  })
  atlas = new THREE.CanvasTexture(c)
  atlas.colorSpace = THREE.NoColorSpace
  atlas.generateMipmaps = true
  atlas.minFilter = THREE.LinearMipmapLinearFilter
  return atlas
}

export default {
  id: 'matrix',
  n: 5,
  header: /* glsl */ `
uniform sampler2D uGlyphs;
`,
  out: /* glsl */ `
{
  float cells = uSkinP.x;
  vec2 g = coinUv * cells;
  vec2 cell = floor(g);
  vec2 f = fract(g);
  float col = cell.x;
  float speed = (0.5 + coinHash1(col) * 0.9) * uSkinP.y;
  float head = fract(uTime * speed * 0.12 + coinHash1(col + 17.0));
  float y = 1.0 - cell.y / cells;                 // 0 at the top, falling down
  float d = fract(head - y);                       // how far above the head this cell is
  float trail = exp(-d / max(0.02, uSkinP.z * 0.4));
  float flip = floor(uTime * (1.5 + coinHash1(col + 3.0) * 4.0) + coinHash2(cell) * 7.0);
  float gi = floor(coinHash2(cell + flip * 0.137) * 16.0);
  vec2 guv = (vec2(mod(gi, 4.0), 3.0 - floor(gi / 4.0)) + f) / 4.0;
  float glyph = texture2D(uGlyphs, guv).r;
  float lead = 1.0 - smoothstep(0.0, 1.5 / cells, d);
  vec3 rain = uSkinColA * glyph * trail * 2.5 + vec3(0.85, 1.0, 0.9) * glyph * lead * 3.5;
#ifdef COIN_LETTER
  rain *= 1.0 + 1.5 * coinTop; // the 3D letters' caps rain brighter, so the amount reads
#endif
  float scan = 0.82 + 0.18 * sin(gl_FragCoord.y * 3.14159);
  outgoingLight = outgoingLight * 0.5 + rain * scan + uSkinColA * coinWall * 1.2;
}
`,
  props: () => ({ metalness: 0.3, roughness: 0.3, color: '#060a07', brush: false, env: 0.25 }),
  uniforms: (u, L) => {
    u.uGlyphs.value = glyphAtlas()
    u.uSkinColA.value.set(L.matrixColour)
    u.uSkinP.value.set(L.matrixGlyphsAcross, L.matrixSpeed, L.matrixTrail, 0)
  },
  dials: (L) => ({
    matrixColour: { type: 'color', default: L.matrixColour },
    matrixGlyphsAcross: [L.matrixGlyphsAcross, 8, 80, 1], // glyphs across the diameter
    matrixSpeed: [L.matrixSpeed, 0, 4, 0.01],
    matrixTrail: [L.matrixTrail, 0.05, 2, 0.01], //          how long each column's tail
  }),
}
