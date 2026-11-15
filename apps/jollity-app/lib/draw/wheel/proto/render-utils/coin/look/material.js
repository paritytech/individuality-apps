// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE METAL — three's MeshPhysicalMaterial, metalness 1, with four things
   patched into its fragment shader (onBeforeCompile, against three 0.185's
   chunks — the version is pinned in package.json):

   1. THE BRUSH. three's anisotropy stretches the highlight along a tangent
      direction; we compute that direction from the UV instead of a texture:
      spun (concentric grooves) → radial, so the highlight is the reference's
      light cone through the centre; linear → across the stroke. Its strength
      is a uniform, and three already treats 0 as isotropic, so anisotropy
      stays ON in the program and switching finish NEVER recompiles.
   2. THE GRAIN. A tiling streak texture (grainTexture below) read along the
      grooves — polar for spun, straight for linear — nudges the roughness and,
      a touch, the normal across the groove: the lines you see up close. It is
      mipmapped, so at the intro's size it fades out instead of shimmering.
   3. TOPS AND WALLS. The engraving's ORM map (maps.js) says where the
      letters' tops (G) and walls (B) are. Tops take uTopRough — frosted,
      polished, or (below 0) the field's own brushed metal; walls are always
      polished (uWallRough) with no brush, so they catch the room as a rim of
      light. Its cavity (R) is the aoMap, which three also applies to the
      reflections. The 3D letters (COIN_LETTER) tell top from wall by their
      own normal instead.
   4. PARALLAX (COIN_POM, off by default — the one toggle here that
      recompiles): a ray-march through the height map before any texture is
      read, so the letters keep their depth at an angle. Every face UV read in
      main() is rewritten to go through it.

   5. THE EDGES. Thin bevels turn faster than a pixel, so their highlight
      lands on one pixel and not the next — that flicker is specular
      aliasing, and the bloom turns each hot pixel into a sparkle.
      Antialiasing does not touch it. So: roughness widens by how fast the
      normal turns across the pixel (fwidth — uEdgeCalm), and no pixel leaves
      brighter than uCeiling. Then a controlled touch on top: uSheen lights
      edges turned toward the key (a Fresnel rim, weighted by the key's
      direction), so an edge reads as lit or shaded, never as a black gap.
   6. SHADOWS. On metal, a light's shadow only dims that light's own glint —
      the rest is the room's reflection, which a shadow map does not touch. So
      the key's shadow factor is caught in three's light loop and also dims the
      reflected room by uShadowRoom: the letters block the room as well as the
      lamp.

   7. SKINS (skins/): COIN_SKIN picks one; its GLSL runs before the lighting
      (the body colour) and just before the pixel leaves (rewriting
      outgoingLight). Everything above is what a skin gets to read.

   The edge band (COIN_EDGE) gets the brush and the grain, and a procedural
   reeding instead of maps. The letters (COIN_LETTER) get the brush on their
   tops only when those are brushed, and the face's normal map — the tops'
   curve (maps.js) — on their tops only. */

import * as THREE from 'three'
import { skinGlsl } from './skins/index.js'

const CH = THREE.ShaderChunk

/* one set of uniforms the whole coin shares: a dial writes it once */
export function createUniforms() {
  return {
    uBrush: { value: 0.7 },
    uGrain: { value: 0.5 },
    uGrainMap: { value: noGrain() }, // grainFor(): coin.js's look() picks it
    uTopRough: { value: 0.43 }, // the letters' tops; below 0: the field's own
    uTopBrush: { value: 0 }, //    1: the tops are brushed like the field
    uWallRough: { value: 0.12 }, // the letters' walls, always polished
    uEdgeCalm: { value: 0.6 },
    uCeiling: { value: 8 },
    uKeepHue: { value: 1 },
    uSheen: { value: 0.25 },
    uKeyDir: { value: new THREE.Vector3(0, 0, 1) }, // toward the key, view space
    uShadowRoom: { value: 0.6 },
    // the skins': a clock, two colours, four numbers, and the matrix's glyphs
    uTime: { value: 0 },
    uSkinColA: { value: new THREE.Color() },
    uSkinColB: { value: new THREE.Color() },
    uSkinP: { value: new THREE.Vector4() },
    uGlyphs: { value: null },
    uPomDepth: { value: 0.015 },
    uPomSteps: { value: 16 },
    uReeds: { value: 150 },
    uReedAmp: { value: 0.35 },
  }
}

/* 512² of streaks: each row one grey, broken into runs of random length, then
   smeared along the row — u runs ALONG the groove, v across it */
/* the grain a finish shows, or one texel of nothing for a finish that
   shows none (uGrain 0: the plastic Good luck coin, a polished face) — every
   read of it is × uGrain, so the picture is the same and the 512² is only
   made, and sent to the GPU, for a coin that shows it */
export const grainFor = (shown) => (shown ? grainTexture() : noGrain())
let NO_GRAIN = null
function noGrain() {
  if (NO_GRAIN) return NO_GRAIN
  NO_GRAIN = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1)
  NO_GRAIN.wrapS = NO_GRAIN.wrapT = THREE.RepeatWrapping
  NO_GRAIN.needsUpdate = true
  return NO_GRAIN
}

/* the same 512² of streaks every time (a fixed seed), so built once a page
   and shared by every coin that shows it */
let GRAIN = null
function grainTexture() {
  if (GRAIN) return GRAIN
  const N = 512
  const data = new Uint8Array(N * N * 4)
  let seed = 7
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
  const row = new Float32Array(N)
  for (let y = 0; y < N; y++) {
    let v = rnd()
    for (let x = 0; x < N; x++) {
      if (rnd() < 0.012) v = rnd() // a new run
      row[x] = v * 0.7 + rnd() * 0.3
    }
    // smear along the groove, wrapping so the tile has no seam
    const K = 6
    for (let x = 0; x < N; x++) {
      let s = 0
      for (let k = -K; k <= K; k++) s += row[(x + k + N) % N]
      const g = Math.round((s / (2 * K + 1)) * 255)
      const i = (y * N + x) * 4
      data[i] = data[i + 1] = data[i + 2] = g
      data[i + 3] = 255
    }
  }
  const t = new THREE.DataTexture(data, N, N)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.magFilter = THREE.LinearFilter
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.generateMipmaps = true
  t.anisotropy = 4
  t.needsUpdate = true
  return (GRAIN = t)
}

const HEADER = /* glsl */ `
uniform float uBrush;
uniform float uSpun;
uniform float uGrain;
uniform sampler2D uGrainMap;
uniform float uTopRough;
uniform float uTopBrush;
uniform float uWallRough;
uniform float uEdgeCalm;
uniform float uCeiling;
uniform float uKeepHue;
uniform float uSheen;
uniform vec3 uKeyDir;
uniform float uShadowRoom;
uniform float uTime;
uniform vec3 uSkinColA;
uniform vec3 uSkinColB;
uniform vec4 uSkinP;
float coinHash1(float n) { return fract(sin(n * 127.1) * 43758.5453); }
float coinHash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
#ifdef COIN_LETTER
varying float vLetterNz;
#endif
uniform float uReeds;
uniform float uReedAmp;
#ifdef COIN_POM
uniform sampler2D uHeight;
uniform float uPomDepth;
uniform int uPomSteps;
#endif

/* the tangent-space direction the highlight stretches along */
vec2 coinBrushDir(vec2 uv) {
  vec2 c = uv - 0.5;
  float r = length(c);
  vec2 radial = r > 1e-5 ? c / r : vec2(0.0, 1.0);
  return normalize(mix(vec2(0.0, 1.0), radial, uSpun));
}
/* spun has no direction at its very centre: fade the brush out there */
float coinBrushFade(vec2 uv) {
  return mix(1.0, smoothstep(0.0, 0.03, length(uv - 0.5)), uSpun);
}
/* the streaks, 0..1 about 0.5. Spun reads them in polar coordinates; the
   angle's seam would spike the derivatives into a line of blur, so the
   gradients come from whichever of two angles (seams opposite) is smooth
   there — the texel is the same, the tile repeats a whole number of times */
float coinGrain(vec2 uv) {
  vec2 c = uv - 0.5;
  float r = length(c) * 2.0;
  float a1 = atan(c.y, c.x) * 0.1591549 + 0.5;
  float a2 = fract(a1 + 0.5);
  vec2 p1 = vec2(a1 * 4.0, r * 0.6);
  vec2 p2 = vec2(a2 * 4.0, r * 0.6);
  bool two = fwidth(a1) > fwidth(a2);
  vec2 gx = two ? dFdx(p2) : dFdx(p1);
  vec2 gy = two ? dFdy(p2) : dFdy(p1);
  vec2 pl = vec2(uv.x * 1.0, uv.y * 1.2);
  float spun = textureGrad(uGrainMap, p1, gx, gy).r;
  float lin = textureGrad(uGrainMap, pl, dFdx(pl), dFdy(pl)).r;
  return mix(lin, spun, uSpun);
}
${skinGlsl('header')}
#ifdef COIN_POM
vec2 coinParallax(vec2 uv) {
  mat3 T = getTangentFrame(-vViewPosition, normalize(vNormal), uv);
  vec3 V = normalize(vViewPosition);
  vec3 v = vec3(dot(V, normalize(T[0])), dot(V, normalize(T[1])), dot(V, normalize(T[2])));
  float steps = float(uPomSteps);
  float layer = 1.0 / steps;
  vec2 dUv = v.xy / max(v.z, 0.25) * uPomDepth * layer;
  vec2 gx = dFdx(uv);
  vec2 gy = dFdy(uv);
  float d = 0.0;
  vec2 cur = uv;
  float h = 1.0 - textureGrad(uHeight, cur, gx, gy).r;
  for (int i = 0; i < 32; i++) {
    if (i >= uPomSteps || d >= h) break;
    cur -= dUv;
    d += layer;
    h = 1.0 - textureGrad(uHeight, cur, gx, gy).r;
  }
  vec2 prev = cur + dUv;
  float after = h - d;
  float before = (1.0 - textureGrad(uHeight, prev, gx, gy).r) - d + layer;
  return mix(cur, prev, clamp(after / (after - before + 1e-5), 0.0, 1.0));
}
#endif
`

const ROUGHNESS = /* glsl */ `
#include <roughnessmap_fragment>
float coinG = coinGrain(coinUv);
roughnessFactor = clamp(roughnessFactor * (1.0 + uGrain * (coinG - 0.5) * 1.4), 0.03, 1.0);
#if defined(COIN_FACE)
vec3 coinOrm = texture2D(aoMap, coinUv).rgb;
float coinTop = coinOrm.g;
float coinWall = coinOrm.b;
float coinAO = coinOrm.r;
#elif defined(COIN_LETTER)
float coinTop = smoothstep(0.85, 0.97, vLetterNz);
float coinWall = 1.0 - coinTop;
float coinAO = 1.0;
#else
float coinTop = 0.0;
float coinWall = 0.0;
float coinAO = 1.0;
#endif
${skinGlsl('diffuse')}
roughnessFactor = mix(roughnessFactor, uTopRough < 0.0 ? roughnessFactor : uTopRough, coinTop);
roughnessFactor = mix(roughnessFactor, uWallRough, coinWall);
// how much of the brush a texel keeps: none on a wall, the tops' own on a top
float coinBrushKeep = (1.0 - coinWall) * mix(1.0, uTopBrush, coinTop);
`

const NORMAL = /* glsl */ `
#include <normal_fragment_maps>
#ifdef COIN_LETTER
// the curve is for the caps: a wall's UV is its own, so it keeps its geometric normal
normal = normalize(mix(nonPerturbedNormal, normal, coinTop));
#endif
{
  vec2 bd = coinBrushDir(coinUv);
  vec3 across = normalize(tbn[0] * bd.x + tbn[1] * bd.y);
  normal = normalize(normal + across * (coinG - 0.5) * uGrain * 0.12 * coinBrushKeep);
#ifdef COIN_EDGE
  // the reeding, faded out where a ridge gets narrower than a pixel (at a
  // grazing angle, or a small coin) — else it sparkles, and the bloom with it
  float ridge = coinUv.x * uReeds;
  float fade = 1.0 - smoothstep(0.25, 0.6, fwidth(ridge));
  normal = normalize(normal + normalize(tbn[0]) * cos(ridge * 6.2831853) * uReedAmp * fade);
#endif
}
// how fast the normal turns across this pixel: the edges' specular antialiasing
float coinNormalTurn = length(fwidth(normal));
`

/* the key's shadow, caught as three's light loop applies it */
const SHADOW_FROM = /directLight\.color \*= (\( directLight\.visible && receiveShadow \) \? getShadow\( directionalShadowMap\[ i \][^;]*);/
const SHADOW_TO = '{ float coinSh = $1; directLight.color *= coinSh; coinShadow = min( coinShadow, coinSh ); }'

const AFTER_AO = /* glsl */ `
#include <aomap_fragment>
reflectedLight.indirectSpecular *= mix(1.0, coinShadow, uShadowRoom);
`

const BEFORE_OUT = /* glsl */ `
${skinGlsl('out')}
{
  float rim = pow(1.0 - saturate(dot(normal, geometryViewDir)), 4.0);
  float toward = saturate(0.3 + 0.7 * dot(normal, uKeyDir));
  outgoingLight += uSheen * 2.0 * rim * toward * diffuseColor.rgb;
  // the ceiling: clamp each channel (a hot highlight goes white), or scale the whole
  // colour down so it keeps its hue — a matte green lit hard stays green, not white
  float coinPeak = max(outgoingLight.r, max(outgoingLight.g, outgoingLight.b));
  outgoingLight = uKeepHue > 0.5 ? outgoingLight * min(1.0, uCeiling / max(coinPeak, 1e-5)) : min(outgoingLight, vec3(uCeiling));
}
#include <opaque_fragment>
`

const ROUGH_FROM = 'material.roughness += geometryRoughness;'
const ROUGH_TO = 'material.roughness += geometryRoughness + min(coinNormalTurn * uEdgeCalm, 0.5);'

const ANISO_FROM = 'vec2 anisotropyV = anisotropyVector;'
const ANISO_TO = 'vec2 anisotropyV = coinBrushDir(coinUv) * uBrush * coinBrushFade(coinUv) * coinBrushKeep;'

/* the chunks main() reads a face UV in, expanded so the rewrite reaches them */
const EXPAND = ['normal_fragment_begin', 'normal_fragment_maps', 'aomap_fragment', 'lights_physical_fragment', 'roughnessmap_fragment']

function patch(shader, uniforms, kind) {
  Object.assign(shader.uniforms, uniforms)
  let fs = shader.fragmentShader
  const at = fs.indexOf('void main() {')
  let head = fs.slice(0, at)
  let body = fs.slice(at + 'void main() {'.length)
  body = body
    .replace('#include <roughnessmap_fragment>', ROUGHNESS)
    .replace('#include <normal_fragment_maps>', NORMAL)
    .replace('#include <aomap_fragment>', AFTER_AO)
    .replace('#include <opaque_fragment>', BEFORE_OUT)
    .replace('#include <lights_fragment_begin>', `float coinShadow = 1.0;\n${CH.lights_fragment_begin.replace(SHADOW_FROM, SHADOW_TO)}`)
  for (const name of EXPAND) body = body.replace(`#include <${name}>`, CH[name])
  for (const [from, what] of [
    [ANISO_FROM, 'the brush'],
    [ROUGH_FROM, 'the edges\' antialiasing'],
  ])
    if (!body.includes(from)) console.warn(`[coin-look] three changed lights_physical_fragment: ${what} is not patched`)
  if (!SHADOW_FROM.test(CH.lights_fragment_begin)) console.warn("[coin-look] three changed lights_fragment_begin: the shadow no longer dims the room")
  body = body.replace(ANISO_FROM, ANISO_TO).replace(ROUGH_FROM, ROUGH_TO)
  body = body.replace(/\b(vUv|vNormalMapUv|vAoMapUv)\b/g, 'coinUv')
  const uv = '\n#ifdef COIN_POM\n  vec2 coinUv = coinParallax(vUv);\n#else\n  vec2 coinUv = vUv;\n#endif\n'
  shader.fragmentShader = `${head}${HEADER}\nvoid main() {${uv}${body}`
  if (kind === 'letter') {
    // the letter's own normal, before any turn: z is "facing up off the coin" — its top
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'varying float vLetterNz;\nvoid main() {')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  vLetterNz = objectNormal.z;')
  }
}

const DEFINE = { face: 'COIN_FACE', edge: 'COIN_EDGE', letter: 'COIN_LETTER' }

/* kind: 'face' | 'edge' | 'letter'. `own` are this material's own uniforms
   (uSpun, and uHeight for a face), merged over the shared ones */
export function createMetal(kind, shared, own = {}) {
  const m = new THREE.MeshPhysicalMaterial({ metalness: 1, roughness: 0.3, anisotropy: 1 })
  // added to three's own (STANDARD, PHYSICAL): without PHYSICAL there is no USE_SPECULAR,
  // and a dielectric's reflection goes to white at grazing whatever specularIntensity says
  m.defines = { ...m.defines, [DEFINE[kind]]: '' }
  const uniforms = { ...shared, ...own }
  m.onBeforeCompile = (shader) => patch(shader, uniforms, kind)
  m.defines.COIN_SKIN = 0
  m.customProgramCacheKey = () => `coin-look:${kind}:${'COIN_POM' in m.defines ? 'pom' : ''}:skin${m.defines.COIN_SKIN}`
  m.userData.uniforms = uniforms
  return m
}

/* the skin, by number: true when it changed (a recompile) */
export function setSkin(m, n) {
  if (m.defines.COIN_SKIN === n) return false
  m.defines.COIN_SKIN = n
  m.needsUpdate = true
  return true
}

/* the one recompiling toggle this file owns */
export function setParallax(m, on) {
  if (on === 'COIN_POM' in m.defines) return false
  if (on) m.defines.COIN_POM = ''
  else delete m.defines.COIN_POM
  m.needsUpdate = true
  return true
}
