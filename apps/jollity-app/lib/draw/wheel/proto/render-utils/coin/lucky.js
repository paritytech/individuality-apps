// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE LUCKY COIN — the intro's token, and the coin lab's Lucky coin exactly:
   the same solid, engraving and 3D letters (look/build.js on LUCKY_LOOK), in
   the same studio (look/studio.js), under the same key light, turned the same
   way by your hand (gyro, or the pointer on a desktop, through
   render-utils/camera.js as the lab's light.js uses it), finished the same
   way (neutral tone mapping, 4× MSAA, no bloom). What the lab shows is what
   floats here.

   Two things are the intro's own, on top of the lab's light:

     the slit   a point light at the mouth, from BELOW, at COIN.coinLight × how
                near the coin is to going in (0 while it floats: then it is the
                lab's coin to the pixel; brightest at the swallow's depth)
     flat       look()'s fourth argument, 0..1: the colour goes to black, the
                reflection off and the emissive to the tint, and the tone
                mapping fades out with it — so at 1 the coin is exactly the
                tint, whatever the light. The wheel lands it that way, the same
                pixel as the disc its painter takes over with

   It hangs off the CAMERA at layout.D, like coin.js, so its units are stage
   px; the camera never turns on the pages that play it, so camera space is
   world space and the lab's world-space key and studio carry over as they are.

   A FADE is the whole GL layer's (the canvas's CSS opacity), not the
   materials': a solid faded mesh by mesh shows its back through its front —
   the logo through FAIR DRAW. On the pages that play it the coin is that
   layer's only content.

   IN HAND the coin faces you: the hosts recenter() the gyro on a press (the
   phone as it is then is the front) and hold() it while the finger is on it,
   which eases its own lean out — the light still follows your hand.

   While the coin is shown it owns the stage's light: the hemisphere light is
   off (as in the lab), the studio is the scene's environment, and the
   composer carries the tone mapping and the multisampling. hide() and
   dispose() hand them back. The same API as coin.js where the intro uses it
   (size, place, hide, slitLight, look, mesh), so intro.js reads the same.

   DEFER: a coin built while another is still on the stage (the draw's prize,
   built while the intro's coin floats) can leave its GPU half — the maps'
   bake and its studio, which are its memory — for upload(), one step a call,
   so a host pays for it once the other coin has gone and the two are never
   held together. Its first draw, here, borrows the studio already on the
   renderer, which compiles the programs its own will use; with none to
   borrow there is nothing to wait for, and it is built whole. A place()
   before upload() is done finishes it there.

   MULTISAMPLING follows the stage's ceiling (layout.js DPR_CAP.msaa), and
   lets go of it live when a host lowers it. */

import * as THREE from 'three'
import { EffectPass, ToneMappingEffect, ToneMappingMode, BlendFunction } from 'postprocessing'
import { COIN } from './config.js'
import { layout, DPR_CAP } from '../layout.js'
import { createOrbit, CAMERA } from '../camera.js'
import { createCoinBuild } from './look/build.js'
import { createStudio, aimStudio, liveStudio } from './look/studio.js'
import { LUCKY_LOOK } from './look/look.js'

const DEG = Math.PI / 180
const KEY_DIST = 500 // the key light's distance, as the lab's
const LIGHT_REF = 300 // the distance (units = nominal px) at which coinLight × heat is the slit light's plain strength

export function createLuckyCoin({ gl, look = LUCKY_LOOK, defer = false }) {
  const L = look
  const build = createCoinBuild(gl.renderer)
  const { coin } = build
  coin.shape(L.thick, L.rimW, L.sides, L.round, L.edgeRound)
  build.prepare(L) // once: its letters are system-ui, which no page loads late
  let later = defer && !!liveStudio(gl.renderer) // the GPU half waits for upload()
  if (!later) while (!build.bake());
  // the sets' 1×1 placeholders, made real, so the first draw reads a texture
  else for (const set of Object.values(build.sets)) for (const t of [set.normal, set.orm]) gl.renderer.initRenderTarget(t)
  const group = coin.group
  group.visible = false
  group.traverse((o) => (o.frustumCulled = false))
  gl.camera.add(group)

  /* the lab's light: the studio, the key aimed from its window, the room and
     the key turned by your hand, and the coin leaning a share of it */
  let studio = later ? null : createStudio(gl.renderer, { back: L.backLight })
  const key = new THREE.DirectionalLight(0xffffff, 0)
  key.target.position.set(0, 0, 0)
  key.visible = false
  gl.scene.add(key, key.target)
  const aim = { qEnv: new THREE.Quaternion(), keyDir: new THREE.Vector3(0, 0, 1), keyRest: new THREE.Vector3(0, 0, 1) }
  const orbit = createOrbit()
  CAMERA.mouse = matchMedia('(pointer: fine)').matches // a desktop's pointer is its "gyro", as in the lab
  orbit.armGyro()
  const onPointer = (e) => {
    const r = gl.pointerRect?.() ?? gl.renderer.domElement.getBoundingClientRect()
    orbit.mouse(e.clientX - r.left, e.clientY - r.top, r.width, r.height)
  }
  addEventListener('pointermove', onPointer)
  const qTilt = new THREE.Quaternion()
  const eTilt = new THREE.Euler(0, 0, 0, 'XYZ')
  /* look.faceBack: the coin turned half round (about its upright) inside
     every turn its host gives it, so its back is the side that faces you at
     rest — the slit draw's Good luck coin starts on GOOD LUCK */
  const qBack = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)
  /* the coin in hand: its own lean eases out (the light still follows), so a
     held coin faces you square — the host's sideways turn is on top of it */
  let held = false
  let lean = 1 // how much of the lean is on, 0..1

  /* the slit */
  const slit = new THREE.PointLight(0xffffff, 0, 0, 1) // decay 1: intensity/distance, so the approach reads
  slit.visible = false
  gl.camera.add(slit)

  /* the finish: the lab's tone mapping, blended NORMAL so flat can fade it
     out (at opacity 1 it is the lab's SRC, the same picture) */
  const tone = new ToneMappingEffect({ mode: L.toneMapping === 'agx' ? ToneMappingMode.AGX : ToneMappingMode.NEUTRAL, blendFunction: BlendFunction.NORMAL })
  const tonePass = L.toneMapping === 'off' ? null : new EffectPass(gl.camera, tone)
  const msaa = () => (L.aa === 'msaa4' && DPR_CAP.msaa ? Math.min(4, gl.renderer.capabilities.maxSamples ?? 4) : 0)

  /* the stage's own, as it was before the coin took it */
  let taken = null
  function take(on) {
    if (on === !!taken) return
    if (on) {
      taken = { hemi: gl.light.intensity, env: gl.scene.environment, envI: gl.scene.environmentIntensity, envR: gl.scene.environmentRotation.clone(), ms: gl.composer.multisampling }
      gl.light.intensity = 0
      gl.scene.environment = studio?.texture ?? liveStudio(gl.renderer) // borrowed only for the first draw of a deferred coin
      gl.composer.multisampling = msaa()
      if (tonePass) gl.composer.addPass(tonePass)
    } else {
      gl.light.intensity = taken.hemi
      gl.scene.environment = taken.env
      gl.scene.environmentIntensity = taken.envI
      gl.scene.environmentRotation.copy(taken.envR)
      gl.composer.multisampling = taken.ms
      if (tonePass) gl.composer.removePass(tonePass)
      taken = null
    }
    key.visible = slit.visible = on
  }

  /* draw it once now, through the composer, under the lights it will be
     drawn with — the programs (for the composer's buffer, not the canvas:
     another variant), the tone pass and the multisampled buffers are all made
     by a first render, and on a slow GPU that one frame can swallow the whole
     launch if it is the first frame the coin is shown. Then one GPU sync, so
     all of it is paid for here, before the launch's clock starts */
  coin.look(L)
  group.position.set(0, 0, -layout.D)
  group.scale.setScalar(Math.max(1, L.coinR))
  group.visible = true
  take(true)
  gl.composer.render(0)
  // …and wait for the GPU to have done it, the bake and the letters too: that
  // work is queued, and the first frame that syncs would pay for all of it
  const ctx = gl.renderer.getContext()
  ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, new Uint8Array(4))
  take(false)
  group.visible = false

  /* the GPU half of a deferred coin, one step a call: the front's maps, the
     back's, then the studio. True once it is all held */
  let faces = false
  function upload() {
    if (!later) return true
    if (!faces) {
      faces = build.bake()
      return false
    }
    studio = createStudio(gl.renderer, { back: L.backLight })
    later = false
    return true
  }

  const Lf = { ...L } // the look this frame: L, tinted and flattened
  let redraws = 1 // how many times the face has been engraved
  const tintC = new THREE.Color()
  const cA = new THREE.Color()
  const cB = new THREE.Color()
  let flatNow = 0
  const canvasStyle = gl.renderer.domElement.style
  let fadeQ = 100 // the layer's opacity, ×100, as last written
  function fade(o) {
    const q = Math.round(Math.min(1, Math.max(0, o)) * 100)
    if (q === fadeQ) return
    fadeQ = q
    canvasStyle.opacity = q >= 100 ? '' : (q / 100).toFixed(2)
  }

  return {
    mesh: group,
    get radius() {
      return L.coinR
    },
    /* the solid's proportions are the look's; the size is place()'s */
    size() {},
    /* the hand's turn, every frame (dt s) */
    step(dt) {
      if (taken && gl.composer.multisampling !== msaa()) gl.composer.multisampling = msaa() // the ceiling dropped it
      CAMERA.swing = L.swing
      const o = orbit.step(dt)
      const yaw = L.followTilt ? o.yaw : 0
      const pitch = L.followTilt ? o.pitch : 0
      aimStudio(L.keyAz, L.keyEl, yaw, pitch, aim)
      gl.scene.environmentRotation.setFromQuaternion(aim.qEnv, 'XYZ')
      key.position.copy(aim.keyDir).multiplyScalar(KEY_DIST)
      key.intensity = L.glint * (1 - flatNow) // flat is no light at all: no glint either
      coin.uniforms.uKeyDir.value.copy(aim.keyDir)
      coin.uniforms.uTime.value = performance.now() / 1000
      const tau = Math.max(0, CAMERA.smoothMs) / 1000
      lean += ((held ? 0 : 1) - lean) * (tau > 1e-4 ? 1 - Math.exp(-dt / tau) : 1)
      const share = L.tiltShare * lean
      qTilt.setFromEuler(eTilt.set(o.pitch * DEG * share, -o.yaw * DEG * share, 0)) // the lean, light or no
    },
    /* the coin at stage point (sx, sy) — nominal px from the top-left — at
       screen radius rPx, turned by q (camera-local), leaning with your hand */
    place(sx, sy, rPx, q) {
      if (later) while (!upload());
      const s = layout.scale
      group.position.set(sx - layout.cx / s, -(sy - layout.cy / s), -layout.D)
      group.quaternion.multiplyQuaternions(qTilt, q)
      if (L.faceBack) group.quaternion.multiply(qBack)
      group.scale.setScalar(Math.max(1e-3, rPx))
      group.visible = true
      gl.include?.(group)
      take(true)
    },
    hide() {
      held = false
      group.visible = false
      take(false)
      fade(1)
    },
    /* the slit's light: at the mouth line (on the centre column, a little in
       front of the coin's plane), at heat 0..1 */
    slitLight(mouthY, heat) {
      const cyN = layout.cy / layout.scale
      slit.position.set(0, -(mouthY - cyN), -layout.D + 30)
      slit.intensity = Math.max(0, COIN.coinLight) * Math.max(0, heat) * LIGHT_REF
    },
    /* fade, the colours' slide toward your ticket's tint (amount 0..1) and
       how far it has gone flat (0..1) — see the header */
    look(opacity, tintHex, amount, flat = 0) {
      const f = Math.min(1, Math.max(0, flat))
      const a = Math.min(1, Math.max(0, amount))
      flatNow = f
      tintC.set(tintHex)
      Object.assign(Lf, L)
      if (a > 0 || f > 0) {
        Lf.plasticColour = `#${cA.set(L.plasticColour).lerp(tintC, a).multiplyScalar(1 - f).getHexString()}`
        Lf.plasticTopColour = `#${cB.set(L.plasticTopColour).lerp(tintC, a).multiplyScalar(1 - f).getHexString()}`
        Lf.plasticReflection = L.plasticReflection * (1 - f)
      }
      const s = group.scale.x
      coin.look(Lf)
      group.scale.setScalar(s) // look() scales to the look's coinR; the size is place()'s
      gl.scene.environmentIntensity = L.room * coin.envFactor * (1 - f)
      for (const m of coin.materials) m.emissive.copy(tintC).multiplyScalar(f)
      fade(opacity)
      tone.blendMode.setOpacity(1 - f)
    },
    /* inside a gesture: iOS asks for motion access only on a release */
    gesture: () => orbit.enableGyro(),
    /* the phone as it is now is the front: the coin (and its light) ease back
       square to you, and stay so — press on it, or a win landing it */
    recenter: () => orbit.recenter(),
    /* in hand (true) or let go: while held the coin does not lean */
    hold(on) {
      held = !!on
    },
    /* the coin's own lean with your hand this frame, degrees (0: square to you) */
    get lean() {
      return (2 * Math.acos(Math.min(1, Math.abs(qTilt.w)))) / DEG
    },
    get flat() {
      return flatNow
    },
    /* new words on the face — { amount, label, backLabel } — engraved and
       traced again, only if one of them has moved. A redraw is the costly
       step (tens of ms), so it is not for every frame. */
    words(patch = {}) {
      if (!Object.keys(patch).some((k) => L[k] !== patch[k])) return false
      Object.assign(L, patch)
      build.redraw(L)
      redraws++
      return true
    },
    get text() {
      return { amount: L.amount, label: L.label, backLabel: L.backLabel }
    },
    get redraws() {
      return redraws
    },
    get letterTriangles() {
      return coin.letterTriangles
    },
    upload,
    /* still waiting for upload() */
    get deferred() {
      return later
    },
    dispose() {
      take(false)
      fade(1)
      removeEventListener('pointermove', onPointer)
      orbit.dispose()
      gl.camera.remove(group, slit)
      gl.scene.remove(key, key.target)
      tonePass?.dispose()
      studio?.dispose()
      build.dispose() // the maps, the baker, the scratch canvases and the solid
    },
  }
}
