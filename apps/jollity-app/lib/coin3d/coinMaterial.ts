// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// The coin's metal — two shader materials, one for the wall and one for the
// two flat faces.
//
// The look: near-black machined metal, a soft highlight along the top, a dark underside. Nothing chrome, no
// environment map, no scene lights. The whole lighting model is two fixed
// directions in VIEW space, which is what a studio lamp above the camera gives
// you: the highlight stays put on screen and the metal turns under it, so a
// rounded corner throws a moving glint and reads as machined.
//
// THE FACE TURNED TO THE PLAYER LIGHTS UP, and it does so from the geometry
// itself: a flat square to the camera is the one whose normal points hardest at
// it. No face index has to be passed in, no uniform is written per frame, and
// the change follows the turn instead of stepping at the settle.
//
// Colours are authored the way they are seen and written straight to the
// framebuffer, with no colour-space include.

import * as THREE from 'three'
import { COIN_TILT } from './coinMesh'

/** The studio key, in view space. Above the camera and a little to the left. */
const KEY_DIR = 'normalize(vec3(-0.30, 0.82, 0.49))'
/** A weak bounce from below, so the lower lip does not go flat black. */
const FILL_DIR = 'normalize(vec3(0.42, -0.58, 0.70))'

const WALL_VERTEX = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vN;

  void main() {
    vUv = uv;
    vN = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const WALL_FRAGMENT = /* glsl */ `
  precision mediump float;

  uniform sampler2D uEngrave;
  uniform vec3 uTop;
  uniform vec3 uBottom;
  uniform vec3 uKey;
  uniform float uDim;
  uniform float uLit;
  uniform float uFaceLo;
  uniform float uFaceHi;
  uniform float uOpacity;

  varying vec2 vUv;
  varying vec3 vN;

  void main() {
    vec3 n = normalize(vN);
    vec3 view = vec3(0.0, 0.0, 1.0);
    vec3 key = ${KEY_DIR};
    vec3 fill = ${FILL_DIR};
    float toCamera = dot(n, view);

    // The wall's own gradient, top to bottom. The lips fall outside 0..1 and
    // clamp, so the upper lip stays the lightest part of the metal.
    vec3 col = mix(uBottom, uTop, clamp(vUv.y, 0.0, 1.0));

    float ndl = max(dot(n, key), 0.0);
    col += uKey * ndl * 0.075;
    // A tight power, so the glint sits on the rounded edges and leaves the
    // flats dark. This is the term that says "turned metal".
    col += uKey * pow(ndl, 30.0) * 0.85;
    col += uKey * pow(max(dot(n, fill), 0.0), 8.0) * 0.06;
    col += uKey * pow(1.0 - max(toCamera, 0.0), 4.0) * 0.09;

    // How square this face is to the player. The window is set from the coin's
    // tilt, so the front face reaches 1 and its neighbours stay at 0.
    float lit = smoothstep(uFaceLo, uFaceHi, toCamera);

    // The engraving. One colour, two brightnesses — the atlas carries coverage
    // in its alpha and nothing else.
    float ink = texture2D(uEngrave, vUv).a;
    col = mix(col, vec3(mix(uDim, uLit, lit)), ink);
    col += vec3(1.0) * ink * lit * 0.2;

    gl_FragColor = vec4(col, uOpacity);
  }
`

const CAP_VERTEX = /* glsl */ `
  varying vec3 vN;
  varying float vR;
  varying vec2 vPool;

  void main() {
    vN = normalize(normalMatrix * normal);
    // The generator packs the distance from the axis into uv.x, so the face
    // can shade a radial gradient without carrying a texture.
    vR = uv.x;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // Where this point stands relative to the coin's own centre, IN VIEW
    // SPACE. The light pool below is painted on that, so it stays put on
    // screen while the metal turns under it. In model space it would spin with
    // the coin and read as a printed mark.
    //
    // DIVIDED BY THE OBJECT'S SCALE, so the pool keeps its size relative to the
    // coin. The coin canvas is orthographic and one world unit is one CSS
    // pixel, so it scales each mesh by its circumradius in pixels. Without this
    // the distance below would come back in pixels, the smoothstep would
    // saturate, and the pool would vanish on every coin.
    float scale = max(length(modelViewMatrix[0].xyz), 0.0001);
    vPool = (mv.xy - (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xy) / scale;
    gl_Position = projectionMatrix * mv;
  }
`

const CAP_FRAGMENT = /* glsl */ `
  precision mediump float;

  uniform vec3 uInner;
  uniform vec3 uOuter;
  uniform vec3 uKey;
  uniform float uOpacity;

  varying vec3 vN;
  varying float vR;
  varying vec2 vPool;

  void main() {
    vec3 n = normalize(vN);
    vec3 key = ${KEY_DIR};
    float ndl = max(dot(n, key), 0.0);
    // Two gradients. The first darkens toward the rim, so the face is not a
    // flat plate. The second is the lamp's pool, set back and to the left to
    // agree with the key direction.
    vec3 col = mix(uInner, uOuter, smoothstep(0.1, 1.0, vR));
    float pool = 1.0 - smoothstep(0.1, 0.95, length(vPool - vec2(-0.12, 0.2)));
    col += uKey * pool * 0.05;
    col += uKey * ndl * 0.05;
    col += uKey * pow(ndl, 20.0) * 0.14;
    gl_FragColor = vec4(col, uOpacity);
  }
`

/** How far the coin fades. 1 is the resting metal. `uOpacity` is a fade hook:
 *  nothing in this app fades the coin. Both materials carry it, so a coin
 *  would fade as one object.
 *
 *  `transparent` is on for the same reason. There is one coin on screen, so
 *  the depth sort has nothing to get wrong. */
const OPACITY_UNIFORM = (): { value: number } => ({ value: 1 })

/** The engraved wall. The caller owns the material and must dispose of it. */
export function makeWallMaterial(engrave: THREE.Texture): THREE.ShaderMaterial {
  const front = Math.cos(COIN_TILT)
  return new THREE.ShaderMaterial({
    vertexShader: WALL_VERTEX,
    fragmentShader: WALL_FRAGMENT,
    transparent: true,
    uniforms: {
      uOpacity: OPACITY_UNIFORM(),
      uEngrave: { value: engrave },
      uTop: { value: new THREE.Color(0x171b21) },
      uBottom: { value: new THREE.Color(0x05070a) },
      uKey: { value: new THREE.Color(0xc6e2f0) },
      // The two engraving brightnesses. They are the CSS opacities the prism
      // used, so the resting coin reads the same as it did.
      uDim: { value: 0.3 },
      uLit: { value: 0.95 },
      // A face square to the player can only reach cos(tilt), never 1, because
      // the coin leans back. Both ends of the window follow from that.
      uFaceLo: { value: front * 0.9 },
      uFaceHi: { value: front * 0.995 }
    }
  })
}

/** The top and bottom faces. */
export function makeCapMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: CAP_VERTEX,
    fragmentShader: CAP_FRAGMENT,
    transparent: true,
    uniforms: {
      uOpacity: OPACITY_UNIFORM(),
      uInner: { value: new THREE.Color(0x171b21) },
      uOuter: { value: new THREE.Color(0x090c10) },
      uKey: { value: new THREE.Color(0xc6e2f0) }
    }
  })
}
