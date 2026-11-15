// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE ENGRAVING'S MAPS — a sharp canvas (engrave.js: R the field and its
   patterns, G where the letters are) in, three textures out, all on the GPU in
   a handful of full-screen passes:

     the patterns  softened by a texel (FINE — a hairline must survive)
     the letters   a DISTANCE FIELD of the mask (jump flooding: a seed pass on
                   the outline, then log₂ passes that each look 1, 2, 4… texels
                   further), so every texel knows how far it is inside or
                   outside a letter. The letter's height is a PROFILE of that
                   distance over the bevel — struck (a steep wall, a small round
                   shoulder, a flat top), rounded, or chamfer — instead of a
                   blur, which is what made them read as a soft emboss
     height        the two together, in LETTER HEIGHTS: the field is 0, a raised
                   letter's top 1 (a cut letter's floor −1, and everything
                   shifted up one so the top of the relief is always 1 — what
                   the parallax marches down from). Half-float. Kept only while
                   the parallax is on; otherwise it lives for the bake
     normal        the height's slope; one letter height is H_BAKE of the
                   diameter here, so the material's normalScale IS the letter
                   height in % (live, no rebake). RGBA8, mipmapped
     orm           R the cavity: grooves in the patterns (the fine height under
                   a wide blur of itself), the foot of a raised letter (a ring
                   just outside it, as wide as the letter is tall — the room's
                   reflection is blocked there), a cut letter's floor, and the
                   corner at the foot of the rim wall (the canvas's B, any shape). G the letters' TOPS, B
                   their WALLS — the material frosts or polishes the tops as
                   dialled and keeps the walls polished: that rim of light is
                   what says "raised"

   THE TOP CURVE: the tops fall away toward their edges over topCurveWidth, by
   topCurve letter heights, so a cap has a light side and a shadow side instead
   of one flat reflection (a struck coin's relief is sculpted, never flat). In
   relief it shapes the letter's own height; in geometry mode (letters.js) the
   letters are real triangles and are left out of the height — only this
   curve goes in, as a rise from the letter's edge inward (so nothing steps at
   the outline), and the 3D letters' caps read it through the face's normal map
   on their planar UV. Their foot ring stays too.

   A face gets one SET; baking into it again re-renders into the same
   targets, so the material keeps its textures and nothing recompiles. Only a
   new map size, or the height coming or going with the parallax, swaps them. */

import * as THREE from 'three'

export const H_BAKE = 0.01 // one letter height in the baked normals, as a share of the diameter
const WIDE = 0.02 //          the patterns' cavity neighbourhood, × map side
const FINE = 1 / 1024 //      the patterns' own softening, × map side: one texel at 1024
const CAVITY = 3 //           how quickly a pattern's groove goes dark
const FIELD = 0.6 //          the field's value in the canvas (engrave.js)
export const PATTERN = 0.6 //        a pattern's canvas height, in letter heights of H_REF: stipple's ±0.15 is a tenth of one
export const H_REF = 0.012 //        the patterns are cut for letters this tall (a share of the diameter, the
//                                   default 1.2 %); taller letters get the same patterns, not deeper ones
const FOOT = 0.55 //          how dark the foot of a raised letter goes
const GRIME = 0.45 //         …and a cut letter's floor
export const PROFILES = { struck: 0, rounded: 1, chamfer: 2 }

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`

const BLUR = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uStep;
varying vec2 vUv;
void main() {
  vec4 s = vec4(0.0);
  float wsum = 0.0;
  for (int i = -12; i <= 12; i++) {
    float x = float(i) / 12.0;
    float w = exp(-x * x * 4.5);
    s += texture2D(tSrc, vUv + uStep * float(i)) * w;
    wsum += w;
  }
  gl_FragColor = s / wsum;
}`

/* the outline's texels: inside, with a neighbour outside, or the other way.
   Texel coordinates are stored as integers (fragCoord − ½), which half-float
   holds exactly up to 2048; −1 means no seed */
const SEED = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
bool inside(vec2 o) { return texture2D(tSrc, vUv + o * uTexel).g > 0.5; }
void main() {
  bool a = inside(vec2(0.0));
  bool edge = inside(vec2(1.0, 0.0)) != a || inside(vec2(-1.0, 0.0)) != a || inside(vec2(0.0, 1.0)) != a || inside(vec2(0.0, -1.0)) != a;
  gl_FragColor = edge ? vec4(gl_FragCoord.xy - 0.5, 0.0, 1.0) : vec4(-1.0, -1.0, 0.0, 1.0);
}`

/* one jump: the nearest seed among the eight at uStep and this texel's own */
const JUMP = /* glsl */ `
uniform sampler2D tSeed;
uniform vec2 uTexel;
uniform float uStep;
void main() {
  vec2 me = gl_FragCoord.xy - 0.5;
  vec2 best = vec2(-1.0);
  float bd = 1e20;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 s = texture2D(tSeed, (gl_FragCoord.xy + vec2(float(i), float(j)) * uStep) * uTexel).xy;
      if (s.x < 0.0) continue;
      vec2 d = s - me;
      float dd = dot(d, d);
      if (dd < bd) { bd = dd; best = s; }
    }
  }
  gl_FragColor = vec4(best, 0.0, 1.0);
}`

/* the patterns and the letters laid together, in letter heights */
const COMPOSE = /* glsl */ `
uniform sampler2D tFine;
uniform sampler2D tSrc;
uniform sampler2D tSeed;
uniform float uBevel;   // texels
uniform float uFoot;    // texels: the foot ring's width
uniform float uLetters; // 1: the letters are in the relief · 0: they are geometry
uniform float uRaised;  // 1 raised · 0 cut
uniform float uCurve;   // letter heights the tops fall away by toward their edges
uniform float uCurveW;  // texels: over this much of the edge
uniform float uPatternK; // H_REF / the letters' height: the patterns keep their depth whatever the letters' height
uniform int uProfile;
varying vec2 vUv;
float profileOf(float u) {
  if (uProfile == 1) return sqrt(max(0.0, 1.0 - (1.0 - u) * (1.0 - u))); // rounded: a quarter circle
  if (uProfile == 2) return u;                                            // chamfer
  // struck: three quarters of the height in the first quarter of the run, then a round shoulder
  return u < 0.25 ? 3.0 * u : 0.75 + 0.25 * sqrt(max(0.0, 1.0 - pow((1.0 - u) / 0.75, 2.0)));
}
void main() {
  float base = texture2D(tFine, vUv).r;
  float m = texture2D(tSrc, vUv).g;
  vec2 s = texture2D(tSeed, vUv).xy;
  float d = s.x < 0.0 ? 1e4 : length(s - (gl_FragCoord.xy - 0.5));
  float sd = (m > 0.5 ? d : -d) + (m - 0.5); // signed: + inside, texels, with the canvas's own antialiasing at the edge
  float p = profileOf(clamp(sd / uBevel, 0.0, 1.0)) * uLetters;
  float c = 1.0 - pow(1.0 - clamp(sd / uCurveW, 0.0, 1.0), 2.0); // 0 at the edge, 1 once past the curve
  float letter = p * max(0.0, 1.0 - uCurve * (1.0 - c)) + (1.0 - uLetters) * uCurve * c * step(0.0, sd);
  float h = (base - ${FIELD.toFixed(2)}) * ${PATTERN.toFixed(2)} * uPatternK + letter * (uRaised * 2.0 - 1.0) + (1.0 - uRaised);
  float tops = smoothstep(0.88, 0.99, p);
  float walls = smoothstep(0.0, 0.06, p) * (1.0 - tops);
  float foot = uRaised * step(sd, 0.0) * (1.0 - smoothstep(0.0, uFoot, -sd));
  float floorGrime = (1.0 - uRaised) * p * ${(GRIME / FOOT).toFixed(3)};
  gl_FragColor = vec4(h, tops, walls, max(foot, floorGrime));
}`

const NORMAL = /* glsl */ `
uniform sampler2D tH;
uniform vec2 uTexel;
uniform float uK;
varying vec2 vUv;
void main() {
  float l = texture2D(tH, vUv - vec2(uTexel.x, 0.0)).r;
  float r = texture2D(tH, vUv + vec2(uTexel.x, 0.0)).r;
  float d = texture2D(tH, vUv - vec2(0.0, uTexel.y)).r;
  float u = texture2D(tH, vUv + vec2(0.0, uTexel.y)).r;
  vec3 n = normalize(vec3((l - r) * uK, (d - u) * uK, 1.0));
  gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
}`

const ORM = /* glsl */ `
uniform sampler2D tH;
uniform sampler2D tFine;
uniform sampler2D tW;
varying vec2 vUv;
void main() {
  vec4 h = texture2D(tH, vUv);
  float base = texture2D(tFine, vUv).r;
  float w = texture2D(tW, vUv).r;
  float cav = clamp((w - base) * ${CAVITY.toFixed(1)}, 0.0, 1.0);
  cav = max(cav, h.a * ${FOOT.toFixed(2)});
  // the concave corner at the foot of the rim wall: drawn along the field's edge
  // into the canvas's B (engrave.js), so it follows a polygon as well as a circle
  cav = max(cav, 0.45 * texture2D(tFine, vUv).b);
  gl_FragColor = vec4(1.0 - cav, h.g, h.b, 1.0);
}`

function target(N, type, mips, { format = THREE.RGBAFormat, nearest = false } = {}) {
  const filter = nearest ? THREE.NearestFilter : THREE.LinearFilter
  const rt = new THREE.WebGLRenderTarget(N, N, {
    type,
    format,
    depthBuffer: false,
    stencilBuffer: false,
    magFilter: filter,
    minFilter: mips ? THREE.LinearMipmapLinearFilter : filter,
    generateMipmaps: mips,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
  })
  rt.texture.colorSpace = THREE.NoColorSpace
  return rt
}

/* ONE baker a renderer, shared by every coin built on it: its six programs
   outlive any one coin, so a coin baked after another has gone (the draw's
   prize, after the intro's coin) does not compile them all again. It holds
   no pixels of its own — its working targets live only for a bake */
const BAKERS = new WeakMap()
export function createBaker(renderer) {
  if (!BAKERS.has(renderer)) BAKERS.set(renderer, makeBaker(renderer))
  return BAKERS.get(renderer)
}

function makeBaker(renderer) {
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2))
  quad.frustumCulled = false
  const scene = new THREE.Scene()
  scene.add(quad)
  const mat = (fragmentShader, uniforms) => new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false })
  const blur = mat(BLUR, { tSrc: { value: null }, uStep: { value: new THREE.Vector2() } })
  const seed = mat(SEED, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } })
  const jump = mat(JUMP, { tSeed: { value: null }, uTexel: { value: new THREE.Vector2() }, uStep: { value: 1 } })
  const compose = mat(COMPOSE, {
    tFine: { value: null },
    tSrc: { value: null },
    tSeed: { value: null },
    uBevel: { value: 1 },
    uFoot: { value: 1 },
    uLetters: { value: 1 },
    uRaised: { value: 1 },
    uCurve: { value: 0 },
    uCurveW: { value: 1 },
    uPatternK: { value: 1 },
    uProfile: { value: 0 },
  })
  const normal = mat(NORMAL, { tH: { value: null }, uTexel: { value: new THREE.Vector2() }, uK: { value: 1 } })
  const orm = mat(ORM, { tH: { value: null }, tFine: { value: null }, tW: { value: null } })
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy())

  function draw(material, to) {
    quad.material = material
    renderer.setRenderTarget(to)
    renderer.render(scene, cam)
  }
  function blurInto(src, via, to, radius, N) {
    blur.uniforms.tSrc.value = src
    blur.uniforms.uStep.value.set(radius / 12 / N, 0)
    draw(blur, via)
    blur.uniforms.tSrc.value = via.texture
    blur.uniforms.uStep.value.set(0, radius / 12 / N)
    draw(blur, to)
  }

  /* a set: the two maps every frame reads, and the height only while the
     parallax wants it. 1×1 until its first bake — a face needs its textures
     from its first frame, or its shader would be built without them */
  function createSet() {
    return { N: 0, normal: target(1, THREE.UnsignedByteType, true), orm: target(1, THREE.UnsignedByteType, true), height: null, version: 0 }
  }

  /* canvas → set.
       keepHeight   the parallax is on: keep the height target
       bevel        the letters' shoulder run, share of the map side
       height       the letters' height, share of the diameter (their foot ring is as wide)
       raised       raised or cut
       letters      false: the letters are geometry — leave them out of the relief
       profile      a PROFILES key
       curve        the tops' fall toward their edges, letter heights
       curveW       …over this share of the map side
     The working targets live only for the bake (~5 half-float squares, a few
     ms); what stays is the set. Returns true when the set's textures were
     replaced, so the caller re-points its materials */
  function bake(set, canvas, { keepHeight, bevel, height, raised, letters, profile, curve = 0, curveW = 0.015 }) {
    const N = canvas.width
    let swapped = false
    if (set.N !== N) {
      set.normal.dispose()
      set.orm.dispose()
      set.normal = target(N, THREE.UnsignedByteType, true)
      set.orm = target(N, THREE.UnsignedByteType, true)
      set.normal.texture.anisotropy = set.orm.texture.anisotropy = aniso
      set.height?.dispose()
      set.height = null
      set.N = N
      swapped = true
    }
    if (keepHeight && !set.height) {
      set.height = target(N, THREE.HalfFloatType, true)
      swapped = true
    } else if (!keepHeight && set.height) {
      set.height.dispose()
      set.height = null
      swapped = true
    }
    const source = new THREE.CanvasTexture(canvas)
    source.colorSpace = THREE.NoColorSpace
    source.minFilter = THREE.LinearFilter
    source.generateMipmaps = false
    const was = renderer.getRenderTarget()
    const texel = 1 / N

    // the patterns, fine
    const via = target(N, THREE.HalfFloatType, false)
    const fine = target(N, THREE.HalfFloatType, false)
    blurInto(source, via, fine, FINE * N, N)

    // the letters' distance field: as far as the bevel or the foot ring can need
    const bevelPx = Math.max(1, bevel * N)
    const footPx = Math.max(2, height * N * 1.2)
    const curvePx = Math.max(1, curveW * N)
    const reach = Math.max(bevelPx, footPx, curvePx) + 2
    const seedOpts = { format: THREE.RGFormat, nearest: true }
    let a = target(N, THREE.HalfFloatType, false, seedOpts)
    let b = target(N, THREE.HalfFloatType, false, seedOpts)
    seed.uniforms.tSrc.value = source
    seed.uniforms.uTexel.value.set(texel, texel)
    draw(seed, a)
    jump.uniforms.uTexel.value.set(texel, texel)
    const steps = []
    for (let s = 2 ** Math.ceil(Math.log2(reach)); s >= 1; s /= 2) steps.push(s)
    steps.push(1) // one more at 1 mends the flood's few wrong corners
    for (const s of steps) {
      jump.uniforms.tSeed.value = a.texture
      jump.uniforms.uStep.value = s
      draw(jump, b)
      ;[a, b] = [b, a]
    }
    b.dispose()

    const heightRT = set.height ?? target(N, THREE.HalfFloatType, false)
    compose.uniforms.tFine.value = fine.texture
    compose.uniforms.tSrc.value = source
    compose.uniforms.tSeed.value = a.texture
    compose.uniforms.uBevel.value = bevelPx
    compose.uniforms.uFoot.value = footPx
    compose.uniforms.uLetters.value = letters ? 1 : 0
    compose.uniforms.uRaised.value = raised ? 1 : 0
    compose.uniforms.uProfile.value = PROFILES[profile] ?? 0
    compose.uniforms.uCurve.value = curve
    compose.uniforms.uCurveW.value = curvePx
    compose.uniforms.uPatternK.value = H_REF / Math.max(1e-4, height)
    draw(compose, heightRT)
    a.dispose()

    const wide = target(N, THREE.HalfFloatType, false)
    blurInto(fine.texture, via, wide, WIDE * N, N)
    normal.uniforms.tH.value = heightRT.texture
    normal.uniforms.uTexel.value.set(texel, texel)
    normal.uniforms.uK.value = (H_BAKE * N) / 2
    draw(normal, set.normal)
    orm.uniforms.tH.value = heightRT.texture
    orm.uniforms.tFine.value = fine.texture
    orm.uniforms.tW.value = wide.texture
    draw(orm, set.orm)
    renderer.setRenderTarget(was)

    source.dispose()
    via.dispose()
    fine.dispose()
    wide.dispose()
    if (heightRT !== set.height) heightRT.dispose()
    set.version++
    return swapped
  }

  /* what the sets hold in GPU memory, bytes: RGBA8 normal and orm, the
     half-float height when kept; mips add a third */
  function bytes(sets) {
    let b = 0
    for (const s of sets) b += s.N * s.N * (4 + 4 + (s.height ? 8 : 0)) * (4 / 3)
    return b
  }

  /* the sets' maps; the baker's programs stay for the next coin (above) */
  function dispose(sets) {
    for (const s of sets) {
      s.normal.dispose()
      s.orm.dispose()
      s.height?.dispose()
    }
  }

  return { createSet, bake, bytes, dispose }
}
