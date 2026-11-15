// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* The coin: your lottery token, a solid in the scene. It hangs off the
   CAMERA, at the camera's own distance D, so it is screen-locked whatever the
   orbit does and its units are screen units — at depth D one world unit is one
   nominal stage px (layout.js), so a coin of radius r is r px on screen and a
   local (x, y) is a stage point. intro.js decides where it is, how it is
   turned and how big; this is only the object.

   Nothing is cut at the slot: under the mouth the coin dims behind the
   slot's dark block (slot.js, a DOM layer over the GL), so the whole solid
   is always drawn.

   The slit is the coin's light. A point light sits at the mouth, camera-
   attached like the coin, lighting it from BELOW with the glow's own alpha
   (COIN.coinLight × alpha, falling off with distance: brighter as the coin
   comes down), plus a dim even fill (COIN.coinFill). three.js cannot light
   one object and not another, so while the coin is shown the scene's
   hemisphere light is turned off — the coin is the only lit solid then (the
   ball and the marker's arrow are hidden through the scene) — and restored
   when it goes.

   Placeholder faces for now: one grey. setFace(texture) is where the FAIR
   DRAW / GOOD LUCK art goes later (paint the SVG to a CanvasTexture); the
   metal look is an env map + metalness on these same materials. TODO(later):
   the design's square hole needs a Shape-with-hole geometry in geometry().

   For the prize reveal (render-utils/prize/) it also has a base colour, a
   metal finish and a face per side (setBase, metal, setFaces), and a light
   placed anywhere rather than at the slot's mouth (lightAt). The intro
   calls none of them, so the coin it plays is the plain one. */

import * as THREE from 'three'
import { COIN } from './config.js'
import { layout } from '../layout.js'

const GREY = '#b3b3b3' // ≤ 0.7 luminance under the hemisphere light: under the bloom threshold, no halo

export function createCoin({ gl }) {
  const base = { color: new THREE.Color(GREY), roughness: 0.65, metalness: 0, transparent: true, opacity: 1 }
  const rim = new THREE.MeshStandardMaterial(base)
  const heads = new THREE.MeshStandardMaterial(base)
  const tails = new THREE.MeshStandardMaterial(base)
  const materials = [rim, heads, tails] // CylinderGeometry's groups: side, top (+y → toward the camera after the turn), bottom
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), materials)
  mesh.frustumCulled = false
  mesh.visible = false
  gl.camera.add(mesh)

  /* the slit's light and the fill: on only while the coin is */
  const slit = new THREE.PointLight(0xffffff, 0, 0, 1) // decay 1: intensity/distance, so the approach reads
  const fill = new THREE.AmbientLight(0xffffff, 0)
  slit.visible = fill.visible = false
  gl.camera.add(slit)
  gl.camera.add(fill)
  const LIGHT_REF = 300 // the distance (units = nominal px) at which coinLight × alpha is the light's plain strength
  let hemi = -1 // the scene's hemisphere light, as it was before the coin took the lights
  function lights(on) {
    if (on === slit.visible) return
    slit.visible = fill.visible = on
    if (on) {
      hemi = gl.light.intensity
      gl.light.intensity = 0
    } else if (hemi >= 0) {
      gl.light.intensity = hemi
      hemi = -1
    }
  }

  let geomR = 0
  let geomT = 0
  /* a disc of radius r and thickness th, turned so its faces look down the
     camera's −z: heads toward the viewer at the identity orientation */
  function geometry(r, th) {
    if (r === geomR && th === geomT) return
    geomR = r
    geomT = th
    mesh.geometry.dispose()
    mesh.geometry = new THREE.CylinderGeometry(r, r, th, 64, 1).rotateX(Math.PI / 2)
  }

  const grey = new THREE.Color(GREY) // what look() tints FROM — setBase moves it
  const tintC = new THREE.Color()

  return {
    mesh,
    get radius() {
      return geomR
    },
    /* build (or rebuild: the dials are live) the disc */
    size(r, th) {
      geometry(Math.max(1, r), Math.max(0.5, th))
    },
    /* the coin at stage point (sx, sy) — nominal px from the top-left — at
       screen radius rPx, turned by q (camera-local: x right, y up, z at you) */
    place(sx, sy, rPx, q) {
      const s = layout.scale
      const cxN = layout.cx / s
      const cyN = layout.cy / s
      mesh.position.set(sx - cxN, -(sy - cyN), -layout.D)
      mesh.scale.setScalar(Math.max(1e-3, rPx / Math.max(1, geomR)))
      mesh.quaternion.copy(q)
      mesh.visible = true
      gl.include?.(mesh)
      lights(true)
    },
    hide() {
      mesh.visible = false
      lights(false)
    },
    /* the slit's light this frame: at the mouth line (stage y = mouthY, on the
       centre column, a little in front of the coin's plane so the faces catch
       it too), at the glow's alpha */
    slitLight(mouthY, alpha) {
      const cyN = layout.cy / layout.scale
      slit.position.set(0, -(mouthY - cyN), -layout.D + 30)
      slit.intensity = Math.max(0, COIN.coinLight) * Math.max(0, alpha) * LIGHT_REF
      fill.intensity = Math.max(0, COIN.coinFill)
    },
    /* fade, and the colour's slide from the placeholder grey toward your
       ticket's tint (amount 0..1) as the coin becomes the dot */
    look(opacity, tintHex, amount) {
      tintC.set(tintHex)
      for (const m of materials) {
        m.opacity = opacity
        m.color.copy(grey).lerp(tintC, amount)
      }
    },
    /* later: the face art — a texture on both faces (the rim keeps the metal) */
    setFace(texture) {
      heads.map = texture
      tails.map = texture
      heads.needsUpdate = tails.needsUpdate = true
    },
    /* …or one per side, each with its own relief (bump) map */
    setFaces({ heads: h = null, tails: t = null, headsBump = null, tailsBump = null } = {}) {
      heads.map = h
      tails.map = t
      heads.bumpMap = headsBump
      tails.bumpMap = tailsBump
      heads.needsUpdate = tails.needsUpdate = true
    },
    /* the colour look() tints from: the placeholder grey unless told
       otherwise — a face texture wants white under it, or it comes out dim */
    setBase(hex) {
      grey.set(hex)
    },
    /* the finish: metal and roughness on all three, relief on the faces */
    metal({ metalness = 0, roughness = 0.65, bumpScale = 1 } = {}) {
      for (const m of materials) {
        m.metalness = metalness
        m.roughness = roughness
      }
      heads.bumpScale = tails.bumpScale = bumpScale
    },
    /* the key light at a stage point (nominal px), dz in front of the coin's
       plane, and the even fill — the slit's own two lights, put somewhere
       else by a host with no slit */
    lightAt(sx, sy, dz, intensity, fillIntensity) {
      const s = layout.scale
      slit.position.set(sx - layout.cx / s, -(sy - layout.cy / s), -layout.D + dz)
      slit.intensity = Math.max(0, intensity) * LIGHT_REF
      fill.intensity = Math.max(0, fillIntensity)
    },
    dispose() {
      lights(false)
      gl.camera.remove(slit)
      gl.camera.remove(fill)
      gl.camera.remove(mesh)
      mesh.geometry.dispose()
      for (const m of materials) m.dispose()
    },
  }
}
