// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* GLASS — a crystal coin. Not three's transmission pass: that shows what is
   behind the object, and behind this coin is a black stage, so real glass here
   would read as black glass. Instead the room itself is sampled along the
   REFRACTED view ray — three times, with the IOR a little apart for red, green
   and blue (chromatic dispersion: the rainbow fringes on every edge) — and
   mixed with the reflected room by Fresnel, plus the key's glint.

   `depth` blends two readings of the refracted ray: straight through (what is
   behind the coin — dark unless the back light is up) and bounced once off
   the far face back toward you (a gem's look: the studio's panels folded
   through the relief). Four environment reads a pixel. */

export default {
  id: 'glass',
  n: 2,
  /* the refracted ray for one colour's IOR, straight through or bounced off
     the far face, in the world frame the environment is sampled in */
  header: /* glsl */ `
vec3 coinGlassRay(vec3 I, vec3 N, float n, float depth) {
  vec3 t = refract(I, N, 1.0 / n);
  vec3 bounced = reflect(t, -N);
  return inverseTransformDirection(normalize(mix(t, bounced, depth)), viewMatrix);
}
`,
  out: /* glsl */ `
#ifdef USE_ENVMAP
{
  vec3 V = geometryViewDir;
  // refraction magnifies every ripple of the relief into rainbow grit: it bends
  // through a calmer normal, part way back to the surface's own
  vec3 N = normalize(mix(nonPerturbedNormal, normal, 0.35));
  float ior = uSkinP.x;
  float disp = uSkinP.y;
  float frost = uSkinP.z;
  float depth = uSkinP.w;
  vec3 I = -V;
  vec3 refr = vec3(
    textureCubeUV(envMap, envMapRotation * coinGlassRay(I, N, ior - disp, depth), frost).r,
    textureCubeUV(envMap, envMapRotation * coinGlassRay(I, N, ior, depth), frost).g,
    textureCubeUV(envMap, envMapRotation * coinGlassRay(I, N, ior + disp, depth), frost).b
  ) * envMapIntensity;
  vec3 refl = getIBLRadiance(V, normal, max(0.02, frost * 0.5));
  float F = 0.04 + 0.96 * pow(1.0 - saturate(dot(N, V)), 5.0);
  outgoingLight = mix(refr * uSkinColA, refl, F) + reflectedLight.directSpecular;
}
#endif
`,
  props: (L) => ({ metalness: 0, roughness: 0.05, brush: false, env: 0.5 }),
  uniforms: (u, L) => {
    u.uSkinColA.value.set(L.glassTint)
    u.uSkinP.value.set(L.glassIor, L.glassDispersion, L.glassFrost, L.glassDepth)
  },
  dials: (L) => ({
    glassTint: { type: 'color', default: L.glassTint },
    glassIor: [L.glassIor, 1, 2.4, 0.01], //                  1.5 glass · 2.4 diamond
    glassDispersion: [L.glassDispersion, 0, 0.15, 0.005], //  the rainbow on the edges
    glassFrost: [L.glassFrost, 0, 1, 0.01], //                 frosted: the refraction blurs
    glassDepth: [L.glassDepth, 0, 1, 0.01], //                 0 see-through · 1 a gem's bounce
  }),
}
