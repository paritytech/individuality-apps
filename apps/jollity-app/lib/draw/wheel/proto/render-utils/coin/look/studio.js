// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE STUDIO — the room the coin reflects, which is most of what metal looks
   like. Built from a few emissive panels in a dark gradient sphere, rendered
   once into a prefiltered cube (PMREM) at boot: nothing downloaded (the build
   is one inlined HTML file, and a 2 MB HDRI would double it), ~6 MB of GPU
   memory, and free every frame after.

   A face-on coin reflects what is BEHIND THE VIEWER (+z here), so the panels
   ring that hemisphere, a little off-axis: face-on the field is darkish with
   the key's streak across it, and a tilt sweeps the panels over the metal.

     key      a long strip up and to the left — the main streak
     window   a small hot square beside it — the crisp glint (and the key
              light's direction: light.js aims its DirectionalLight here)
     fill     a tall panel low on the right
     kicker   off to the side and behind — lights the bevels and the edge
     floor    a warm wide bounce from below
     back     a big soft panel straight BEHIND the coin (backLight). A letter's
              wall, like the coin's own edge, is seen edge-on, and an edge-on
              mirror reflects what is straight behind the thing — which was
              the dark back of the room, so polished walls read as dark bands.
              This is the product photographer's back light; it is brighter at
              its top, so the walls get a lit side and a dim one, not a stripe.
              The faces never see it: they reflect the room in front.

   Rebuilt (a PMREM render, ~10–30 ms) only when backLight changes.

   The prefiltered cube keeps no depth buffer: PMREM renders the room with
   one (3 MB at 256) and the cube is copied out of it texel for texel, so
   only the 6 MB the coin reads stays. The room itself and the PMREM
   generator are kept, one a renderer (a few hundred KB of geometry and
   programs, the generator's 6 MB ping-pong target let go after each use):
   a studio built after another has gone — the draw's prize, after the
   intro's coin — compiles nothing. liveStudio() is any studio still held on
   a renderer: a coin built ahead of its studio (lucky.js, defer) is drawn
   once under it, which compiles the programs its own will use. */

import * as THREE from 'three'

const DEG = Math.PI / 180
/* a direction from azimuth (0 = toward the viewer, + to the right) and elevation */
export const dir = (az, el) => new THREE.Vector3(Math.sin(az * DEG) * Math.cos(el * DEG), Math.sin(el * DEG), Math.cos(az * DEG) * Math.cos(el * DEG))

export const WINDOW_DIR = dir(-34, 22)

/* WHERE THE KEY IS (keyAz, keyEl) turns the whole studio: up by the
   elevation's change about the horizontal axis across the window, then round
   by the azimuth's — so the floor stays the floor. A viewer off the screen's
   normal (yaw, pitch, deg: the lab's gyro or pointer) turns it on by the
   inverse, as walking round a still coin in a still room would. Into `out`:
     qEnv     the room's turn (scene.environmentRotation)
     keyDir   toward the key light, world space — the window, turned with it
     keyRest  …and where it is with no viewer turn: the dials' own direction */
const AZ0 = Math.atan2(WINDOW_DIR.x, WINDOW_DIR.z) / DEG // where the studio was built with its window
const EL0 = Math.asin(WINDOW_DIR.y) / DEG
const elAxis = new THREE.Vector3(-Math.cos(AZ0 * DEG), 0, Math.sin(AZ0 * DEG)) // window × up: turning about it raises the window
const yAxis = new THREE.Vector3(0, 1, 0)
const qEl = new THREE.Quaternion()
const qAz = new THREE.Quaternion()
const qStudio = new THREE.Quaternion()
const qInv = new THREE.Quaternion()
const eInv = new THREE.Euler(0, 0, 0, 'XYZ')
export function aimStudio(keyAz, keyEl, yaw, pitch, out) {
  qEl.setFromAxisAngle(elAxis, (keyEl - EL0) * DEG)
  qAz.setFromAxisAngle(yAxis, (keyAz - AZ0) * DEG)
  qStudio.multiplyQuaternions(qAz, qEl)
  out.keyRest.copy(WINDOW_DIR).applyQuaternion(qStudio)
  qInv.setFromEuler(eInv.set(pitch * DEG, -yaw * DEG, 0))
  out.qEnv.multiplyQuaternions(qInv, qStudio)
  out.keyDir.copy(WINDOW_DIR).applyQuaternion(out.qEnv)
  return out
}

/* per renderer: the studios' textures it holds now, the rooms by back
   light, and the PMREM generator */
const KITS = new WeakMap()
const kitOf = (renderer) => {
  if (!KITS.has(renderer)) KITS.set(renderer, { live: new Set(), rooms: new Map(), pmrem: null })
  return KITS.get(renderer)
}
export const liveStudio = (renderer) => KITS.get(renderer)?.live.values().next().value ?? null

/* a target's texels into one without a depth buffer: texelFetch, so not one
   of them is filtered or rounded on the way */
let copier = null
function withoutDepth(renderer, rt) {
  copier ??= {
    scene: new THREE.Scene(),
    camera: new THREE.OrthographicCamera(),
    material: new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { tSrc: { value: null } },
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'uniform sampler2D tSrc;\nlayout(location = 0) out highp vec4 texel;\nvoid main() { texel = texelFetch(tSrc, ivec2(gl_FragCoord.xy), 0); }',
      depthTest: false,
      depthWrite: false,
    }),
  }
  if (!copier.mesh) {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3))
    copier.mesh = new THREE.Mesh(g, copier.material)
    copier.mesh.frustumCulled = false
    copier.scene.add(copier.mesh)
  }
  const t = rt.texture
  const out = new THREE.WebGLRenderTarget(rt.width, rt.height, { type: t.type, format: t.format, colorSpace: t.colorSpace, magFilter: t.magFilter, minFilter: t.minFilter, generateMipmaps: false, depthBuffer: false })
  out.texture.mapping = t.mapping
  out.texture.name = t.name
  copier.material.uniforms.tSrc.value = t
  const was = renderer.getRenderTarget()
  const autoClear = renderer.autoClear
  renderer.autoClear = false
  renderer.setRenderTarget(out)
  renderer.render(copier.scene, copier.camera)
  renderer.setRenderTarget(was)
  renderer.autoClear = autoClear
  copier.material.uniforms.tSrc.value = null
  rt.dispose()
  return out
}

export function createStudio(renderer, { back = 1 } = {}) {
  const kit = kitOf(renderer)
  if (!kit.rooms.has(back)) kit.rooms.set(back, roomScene(back))
  kit.pmrem ??= new THREE.PMREMGenerator(renderer)
  const cube = kit.pmrem.fromScene(kit.rooms.get(back), 0, 0.1, 100)
  kit.pmrem._pingPongRenderTarget?.dispose() // three's own field: the generator keeps the target object, and makes it again on its next use
  const rt = withoutDepth(renderer, cube)
  kit.live.add(rt.texture)

  return {
    texture: rt.texture,
    bytes: rt.width * rt.height * 8, // half-float RGBA
    dispose: () => {
      kit.live.delete(rt.texture)
      rt.dispose()
    },
  }
}

/* the room the studio is a picture of */
function roomScene(back) {
  const scene = new THREE.Scene()

  // the room: a dark vertical gradient, a touch lighter at the horizon
  const room = new THREE.SphereGeometry(50, 48, 24)
  const col = []
  const p = room.attributes.position
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) / 50
    const v = y > 0 ? 0.05 + 0.05 * (1 - y) : 0.05 * (1 + y) + 0.012
    col.push(v, v, v * 1.05)
  }
  room.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  scene.add(new THREE.Mesh(room, new THREE.MeshBasicMaterial({ side: THREE.BackSide, vertexColors: true })))

  const panel = (w, h, strength, d, tint = [1, 1, 1]) => {
    const m = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
    m.color.setRGB(tint[0] * strength, tint[1] * strength, tint[2] * strength)
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m)
    mesh.position.copy(d).multiplyScalar(30)
    mesh.lookAt(0, 0, 0)
    scene.add(mesh)
  }
  panel(34, 5, 5, dir(-12, 34)) //                     key
  panel(3.2, 3.2, 22, WINDOW_DIR) //                   window
  panel(10, 20, 1.4, dir(52, -6)) //                   fill
  panel(6, 26, 3.5, dir(112, 12), [0.95, 0.97, 1]) //  kicker
  panel(60, 24, 0.5, dir(0, -62), [1, 0.86, 0.72]) //  floor
  if (back > 0) {
    // back: bright along its top, dimmer toward its foot
    const g = new THREE.PlaneGeometry(44, 22, 1, 8)
    const c = []
    const gp = g.attributes.position
    for (let i = 0; i < gp.count; i++) {
      const v = 0.35 + 0.65 * (gp.getY(i) / 22 + 0.5)
      c.push(v, v, v)
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3))
    const m = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, vertexColors: true })
    m.color.setScalar(3 * back)
    const mesh = new THREE.Mesh(g, m)
    mesh.position.copy(dir(180, 4)).multiplyScalar(30)
    mesh.lookAt(0, 0, 0)
    scene.add(mesh)
  }

  return scene
}
