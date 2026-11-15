// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* NEON — a dark glassy coin with tubes of light laid along every edge it
   already knows: any slope in the face's normal map (the rosette's lines, a
   relief letter's walls), the cavity map's rings (the letters' feet, the
   rim's corner) and the 3D letters' walls. Two colours travel along the
   tubes, and a flicker now and then; the bloom does the glow. Cheap: it only
   reads maps the coin already has. */

export default {
  id: 'neon',
  n: 6,
  out: /* glsl */ `
{
  float tube = coinWall;
#ifdef COIN_FACE
  vec3 nm = texture2D(normalMap, coinUv).xyz * 2.0 - 1.0;
  // the pattern's lines are the dimmer tubes; the letters' feet and the rim's corner the bright ones
  tube = max(tube, 0.15 * smoothstep(0.04, 0.04 + 0.3 / max(0.1, uSkinP.x), length(nm.xy)));
  tube = max(tube, smoothstep(0.08, 0.45, 1.0 - coinAO));
#endif
  float along = 0.5 + 0.5 * sin((coinUv.x - coinUv.y) * 7.0 + uTime * 0.7);
  vec3 neon = mix(uSkinColA, uSkinColB, along);
  float flick = 1.0 - uSkinP.y * step(0.94, coinHash1(floor(uTime * 14.0)));
  outgoingLight += neon * tube * 3.0 * flick;
}
`,
  props: () => ({ metalness: 0.2, roughness: 0.12, color: '#0b0b14', brush: false, env: 0.3 }),
  uniforms: (u, L) => {
    u.uSkinColA.value.set(L.neonColourA)
    u.uSkinColB.value.set(L.neonColourB)
    u.uSkinP.value.set(L.neonTubeWidth, L.neonFlicker, 0, 0)
  },
  dials: (L) => ({
    neonColourA: { type: 'color', default: L.neonColourA },
    neonColourB: { type: 'color', default: L.neonColourB },
    neonTubeWidth: [L.neonTubeWidth, 0.2, 3, 0.01], // how much of each edge lights
    neonFlicker: [L.neonFlicker, 0, 1, 0.01], //      a failing tube now and then
  }),
}
