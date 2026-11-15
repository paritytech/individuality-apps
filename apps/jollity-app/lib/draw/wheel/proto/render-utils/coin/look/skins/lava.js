// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* LAVA — a crust of dark basalt (rough, no metal, the room turned down) with
   molten rock showing through: in everything the relief cuts — the cavity map
   holds the letters' feet, the rosette's lines and the rim's corner — and in
   slow cracks drifting across the crust: domain-warped fbm (noise pushed
   around by noise, so it flows) and the edges of Voronoi cells (plates). The
   3D letters' walls smoulder. Emissive well over 1, so the bloom glows. The
   heaviest skin: ~5 octaves of noise, three times, per coin pixel. */

export default {
  id: 'lava',
  n: 4,
  header: /* glsl */ `
float coinNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = coinHash2(i);
  float b = coinHash2(i + vec2(1.0, 0.0));
  float c = coinHash2(i + vec2(0.0, 1.0));
  float d = coinHash2(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float coinFbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * coinNoise(p);
    p = p * 2.03 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return s;
}
/* how near p is to the edge between two Voronoi cells: F2 − F1 */
float coinCellEdge(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float d1 = 8.0;
  float d2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 r = o + vec2(coinHash2(i + o), coinHash2(i + o + 19.1)) - f;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  }
  return sqrt(d2) - sqrt(d1);
}
`,
  out: /* glsl */ `
{
  vec2 p = coinUv * uSkinP.y;
  float t = uTime * uSkinP.z;
  vec2 q = vec2(coinFbm(p + vec2(0.0, t)), coinFbm(p + vec2(5.2, 1.3) - t));
  float flow = coinFbm(p + 2.0 * q + vec2(0.5 * t, -0.3 * t));
  float crack = 1.0 - smoothstep(0.03, 0.12, coinCellEdge(p * 1.3 + q * 0.8));
  // only the deep recesses glow (the letters' feet, the rim's corner); a pattern's shallow cuts barely
  float recess = smoothstep(0.15, 0.55, 1.0 - coinAO);
  float heat = clamp(crack * (0.3 + 0.9 * flow) + recess * 0.6 + coinWall * 0.3, 0.0, 1.0) * uSkinP.x;
  vec3 molten = mix(uSkinColA, vec3(1.0, 0.85, 0.45), clamp(heat * heat, 0.0, 1.0));
  outgoingLight = outgoingLight * (1.0 - clamp(heat, 0.0, 1.0)) + molten * heat * 3.0;
}
`,
  props: () => ({ metalness: 0, roughness: 0.85, color: '#1c1714', brush: false, env: 0.15 }),
  uniforms: (u, L) => {
    u.uSkinColA.value.set(L.lavaColour)
    u.uSkinP.value.set(L.lavaHeat, L.lavaScale, L.lavaSpeed, 0)
  },
  dials: (L) => ({
    lavaColour: { type: 'color', default: L.lavaColour }, // the cooler glow; the hottest goes yellow-white
    lavaHeat: [L.lavaHeat, 0, 2, 0.01],
    lavaScale: [L.lavaScale, 1, 12, 0.1], //                 cracks across the diameter
    lavaSpeed: [L.lavaSpeed, 0, 2, 0.01], //                 how fast it flows
  }),
}
