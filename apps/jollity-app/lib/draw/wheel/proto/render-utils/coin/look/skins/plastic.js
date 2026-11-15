// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* COLOUR PLASTIC — a toy's glossy shell: a coloured body with no metal in it
   (so the colour is diffuse, lit by the room), under a clearcoat — the second,
   glass-smooth specular layer that gives injection-moulded plastic its hard
   highlight. The letters' tops take a second colour (the tops mask), so it
   reads like a two-shot moulding — and the letters' walls can take it too
   (uSkinP.x), so the whole letter is the second shot. Cost: the clearcoat's second lobe. */

export default {
  id: 'plastic',
  n: 1,
  // before the lighting: the body colour, the tops in the second one
  diffuse: /* glsl */ `
diffuseColor.rgb = mix(uSkinColA, uSkinColB, max(coinTop, coinWall * uSkinP.x));
`,
  // a diffuse body takes far more of the room than metal does: turned down so it does not bloom
  // specularIntensity scales a dielectric's reflection head-on AND at grazing (three's F90):
  // at 1 a matte body still goes white where it turns edge-on — the reeds, the rim
  props: (L) => ({ metalness: 0, roughness: L.plasticRoughness, clearcoat: L.plasticGloss, brush: false, env: 0.45, specularIntensity: L.plasticReflection }),
  uniforms: (u, L) => {
    u.uSkinColA.value.set(L.plasticColour)
    u.uSkinColB.value.set(L.plasticTopColour)
    u.uSkinP.value.x = L.plasticWallColour ? 1 : 0
  },
  dials: (L) => ({
    plasticColour: { type: 'color', default: L.plasticColour },
    plasticTopColour: { type: 'color', default: L.plasticTopColour }, // the letters' tops
    plasticWallColour: L.plasticWallColour, //                           the letters' walls in the tops' colour
    plasticGloss: [L.plasticGloss, 0, 1, 0.01], //                      the clearcoat: 0 a matte toy
    plasticRoughness: [L.plasticRoughness, 0.05, 1, 0.01], //           the body under it
    plasticReflection: [L.plasticReflection, 0, 1, 0.01], //            how much it reflects, edge-on too: 0 chalk, 1 plastic
  }),
}
