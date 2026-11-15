// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE SKINS — the same coin, the same geometry and the same light, a
   different material. Each skin is a small module:

     n          its number: the shader's COIN_SKIN
     header     GLSL helpers, compiled only into its own program
     diffuse    GLSL run before the lighting (the body colour)
     out        GLSL run after it, just before the pixel leaves: it may rewrite
                outgoingLight, reading coinUv, coinTop, coinWall, coinAO, normal,
                geometryViewDir, uKeyDir, uTime and the uSkin* uniforms
     props(L)   what it sets on the materials: metalness, roughness, colour,
                clearcoat, whether the brush stays, the room's brightness
     uniforms   its uniforms from its dials
     post()     full-screen effects after tone mapping (the pixel skin)
     dials(L)   its own panel dials, whose names are LOOK keys
     metallic   true when it is shaded as the metal: the metal's colour and the
                finish (brush, field roughness) reach it, so the panel shows them

   Switching skin changes COIN_SKIN: one recompile per switch, which the cost
   line times. Nothing here imports config.js (the panel and the coin hand LOOK
   in), so there is no cycle. */

import metal from './metal.js'
import plastic from './plastic.js'
import glass from './glass.js'
import pixel from './pixel.js'
import lava from './lava.js'
import matrix from './matrix.js'
import neon from './neon.js'

export const SKINS = [metal, plastic, glass, pixel, lava, matrix, neon]
export const SKIN_NAMES = SKINS.map((s) => s.id)
export const skinOf = (id) => SKINS.find((s) => s.id === id) ?? metal

/* every skin's GLSL for one stage, each behind its own #if */
export const skinGlsl = (stage) =>
  SKINS.filter((s) => s[stage])
    .map((s) => `#if COIN_SKIN == ${s.n}\n${s[stage]}\n#endif`)
    .join('\n')
