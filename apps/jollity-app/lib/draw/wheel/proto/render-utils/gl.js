// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* renderer, camera, scene, composer. The camera orbits the origin at the
   distance layout.js computes, so world px = stage px whatever the angle;
   camera.js decides the angle, orbit() places it. */
import * as THREE from 'three'
import { EffectComposer, RenderPass, EffectPass, BloomEffect } from 'postprocessing'
import { layout } from './layout.js'

const DEG = Math.PI / 180

/* fov() and bloom() are the scene's — the stage owns neither a field of view
   nor a look. bloom() returns { intensity, threshold, radius }; syncBloom()
   re-reads it, so a dial still lands live.

   bloom     null for a stage that never glows (the draw: its coin's look
             has none). Then there is no bloom at all — no effect, none of
             its targets, none of its passes a frame — and in its place a
             pass with no effects, which postprocessing skips unless it is
             the one drawing to the screen. So a coin's tone pass reads the
             scene's buffer straight (one full buffer, not two ping-ponged),
             and with nothing after it, the copy to the screen is the one the
             bloom made at intensity 0. bloom and syncBloom() are then null
             and a no-op; bloomPass is always in the chain
   alpha     a see-through layer (cleared to nothing) rather than an opaque
             black one, so it can sit over a page instead of being one
   margin()  css px the canvas reaches PAST the stage on every side — for a
             solid that has to leave the stage's box (the stage's own
             clipping is the host's to lift). The camera sees the same
             stage px in the middle, only more round them; 0 is the stage
             exactly. Read on resize(): call it again when it moves
   window()  for a stage whose only solid is small (the draw's coin): the
             canvas is a WINDOW onto the stage's frame rather than the frame,
             a square sized from window() — the radius, nominal px, of the
             biggest solid the page draws — and moved, each render(), onto
             what include() was handed since the last. The camera draws
             exactly the pixels of the full frame the window covers
             (setViewOffset, at an even device px, so even a pixel's
             derivatives are the full frame's), so the picture is the same
             one; every buffer — the canvas, the composer's, their
             multisampling — is the window's size, not the stage's. It grows
             if a solid ever spills out, and sleep() lets it all go (1×1)
             while nothing is shown. Off: include() does nothing and render()
             is the composer's. Never with a margin. */
export function createGL(canvas, { fov: fovOf = () => 115, bloom: bloomOf = () => ({ intensity: 1, threshold: 0.2, radius: 0.5 }), alpha = false, margin: marginOf = () => 0, window: windowOf = null } = {}) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha,
    powerPreference: 'high-performance',
    stencil: false,
    depth: false,
  })
  renderer.debug.checkShaderErrors = false // JOLLITY: no synchronous compile check per shader
  renderer.toneMapping = THREE.NoToneMapping
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.setClearColor(0x000000, alpha ? 0 : 1)

  // the largest point sprite this driver draws (device px): the dot shaders cap at it
  const ctx = renderer.getContext()
  const maxPointPx = ctx.getParameter(ctx.ALIASED_POINT_SIZE_RANGE)?.[1] || 1024

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(fovOf(), 1, 10, 8000)
  /* the camera is IN the scene so a child of it (the intro's coin, intro/coin.js)
     stays screen-locked whatever the orbit does; three.js updates a parented
     camera through the scene's own matrix pass */
  scene.add(camera)
  /* the sphere — every dot and trail renderer's mesh — lives in one group, so
     the intro can turn the whole sphere (coin/scene.js: a rotation about the origin,
     which the dot shaders' occlusion and depth cue are exact under) and hand it
     back at the identity. Everything else — the roulette ball, the marker's
     arrow — stays in the scene proper */
  const world = new THREE.Group()
  scene.add(world)

  /* the one light: the dot shaders ignore it; the solids — the marker's arrow
     pyramid (marker.js), the roulette ball (ball.js) — are what it is for */
  const light = new THREE.HemisphereLight(0xffffff, 0x223344, 2.5)
  scene.add(light)

  const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType })
  const renderPass = new RenderPass(scene, camera)
  const b0 = bloomOf?.()
  const bloom = b0
    ? new BloomEffect({
        mipmapBlur: true,
        intensity: b0.intensity,
        luminanceThreshold: b0.threshold,
        luminanceSmoothing: 0.25,
        radius: b0.radius,
      })
    : null
  const bloomPass = bloom ? new EffectPass(camera, bloom) : new EffectPass(camera)
  composer.addPass(renderPass)
  composer.addPass(bloomPass)

  let yawDeg = 0
  let pitchDeg = 0

  /* stand at layout.D from the centre, yaw about y then pitch about x, look at
     the centre: the sphere keeps its px size and stays under the bearing cap */
  function orbit(yaw, pitch) {
    yawDeg = yaw
    pitchDeg = pitch
    const D = layout.D
    const phi = yaw * DEG
    const psi = pitch * DEG
    camera.position.set(D * Math.sin(phi) * Math.cos(psi), D * Math.sin(psi), D * Math.cos(phi) * Math.cos(psi))
    camera.lookAt(0, 0, 0)
  }

  let marginPx = 0
  function resize() {
    if (win.on) return fitWindow()
    const m = Math.max(0, Math.round(marginOf() || 0))
    const W = layout.W + 2 * m
    const H = layout.H + 2 * m
    renderer.setPixelRatio(layout.dpr)
    composer.setSize(W, H, false)
    if (m > 0 || marginPx > 0) {
      const st = canvas.style
      st.left = st.top = m > 0 ? `${-m}px` : ''
      st.width = m > 0 ? `${W}px` : ''
      st.height = m > 0 ? `${H}px` : ''
    }
    marginPx = m
    /* the stage's fov spans its height: the taller canvas, the same scale, a wider angle */
    const fov = Math.min(170, Math.max(5, fovOf()))
    camera.fov = m > 0 ? Math.min(170, (2 * Math.atan(Math.tan((fov * DEG) / 2) * (H / layout.H))) / DEG) : fov
    camera.aspect = W / H
    orbit(yawDeg, pitchDeg)
    camera.updateProjectionMatrix()
  }
  /* ── the window ─────────────────────────────────────────────────────────── */
  const PAD = 1.5 // its half side, × the radius it is sized from: room for a lean, and a rim turned to you in perspective
  const STEP = 16 // device px its side is rounded up to
  const win = { on: !!windowOf, x: 0, y: 0, w: 0, h: 0, W: 0, H: 0, side: 0, grown: 0, overflow: 0, most: 0, asleep: false }
  const included = []
  const centre = new THREE.Vector3()
  const corner = new THREE.Vector3()
  const pct = (v) => `${(v * 100).toFixed(4)}%`
  /* a side that fits the frame, and leaves it an even number of px to
     spare, so a window clamped to the far edge still starts on an even px */
  const fitSide = (s, full) => {
    let w = Math.min(s, full)
    if ((full - w) % 2) w -= 1
    return Math.max(1, w)
  }
  function fitWindow() {
    const dpr = layout.dpr
    win.W = Math.max(1, Math.floor(layout.W * dpr))
    win.H = Math.max(1, Math.floor(layout.H * dpr))
    win.side = Math.max(Math.ceil((2 * PAD * Math.max(1, windowOf()) * layout.scale * dpr) / STEP) * STEP, win.grown)
    win.w = fitSide(win.side, win.W)
    win.h = fitSide(win.side, win.H)
    renderer.setPixelRatio(1)
    if (!win.asleep) composer.setSize(win.w, win.h, false)
    const st = canvas.style
    st.right = st.bottom = 'auto'
    camera.fov = Math.min(170, Math.max(5, fovOf()))
    orbit(yawDeg, pitchDeg)
    view(win.x, win.y)
  }
  /* the window at (x, y), device px of the full frame from its top-left: the
     camera's view of it, and the canvas over it, in % of the stage */
  function view(x, y) {
    win.x = x
    win.y = y
    camera.setViewOffset(win.W, win.H, x, y, win.w, win.h)
    camera.aspect = layout.W / layout.H // the full frame's, as the stage has always drawn it (setViewOffset sets it from whole px)
    camera.updateProjectionMatrix()
    const st = canvas.style
    st.left = pct(x / win.W)
    st.top = pct(y / win.H)
    st.width = pct(win.w / win.W)
    st.height = pct(win.h / win.H)
  }
  /* onto what was included: in the full frame, the box round each of its
     meshes' bounding spheres — a cube about the sphere, square to the camera,
     projected corner by corner (its near face is the larger: perspective,
     covered). A sphere does not grow as a solid turns, where a box turned
     with it would (a coin flipped end over end: by up to √2) */
  function follow() {
    if (!included.length) return
    scene.updateMatrixWorld()
    camera.clearViewOffset()
    camera.aspect = layout.W / layout.H
    camera.updateProjectionMatrix()
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const o of included) {
      o.traverseVisible((m) => {
        const g = m.geometry
        if (!g?.attributes?.position?.count) return
        if (!g.boundingSphere) g.computeBoundingSphere()
        const s = g.boundingSphere
        const r = s.radius * m.matrixWorld.getMaxScaleOnAxis()
        if (!(r > 0)) return
        centre.copy(s.center).applyMatrix4(m.matrixWorld).applyMatrix4(camera.matrixWorldInverse)
        for (let i = 0; i < 8; i++) {
          corner.set(centre.x + (i & 1 ? r : -r), centre.y + (i & 2 ? r : -r), centre.z + (i & 4 ? r : -r)).applyMatrix4(camera.projectionMatrix)
          const px = ((corner.x + 1) / 2) * win.W
          const py = ((1 - corner.y) / 2) * win.H
          x0 = Math.min(x0, px)
          x1 = Math.max(x1, px)
          y0 = Math.min(y0, py)
          y1 = Math.max(y1, py)
        }
      })
    }
    included.length = 0
    if (!(x1 > x0)) return view(win.x, win.y)
    const need = Math.ceil(Math.max(x1 - x0, y1 - y0)) + 4
    win.most = Math.max(win.most, need)
    if ((need > win.w && win.w < win.W) || (need > win.h && win.h < win.H)) {
      // a solid spilled out: the window grows, and stays grown
      win.overflow++
      win.grown = Math.ceil(need / STEP) * STEP
      fitWindow()
    }
    const clamp = (v, hi) => Math.max(0, Math.min(hi, v))
    let x = clamp(Math.round((x0 + x1) / 2 - win.w / 2), win.W - win.w)
    let y = clamp(Math.round((y0 + y1) / 2 - win.h / 2), win.H - win.h)
    x -= x & 1
    y -= y & 1
    view(x, y)
  }
  function render(dt) {
    if (win.on) {
      if (win.asleep) {
        win.asleep = false
        composer.setSize(win.w, win.h, false)
      }
      follow()
    }
    composer.render(dt)
  }
  function sleep() {
    if (!win.on || win.asleep) return
    win.asleep = true
    composer.setSize(1, 1, false)
  }

  resize()

  function syncBloom() {
    if (!bloom) return
    const b = bloomOf()
    bloom.intensity = b.intensity
    bloom.luminanceMaterial.threshold = b.threshold
    bloom.mipmapBlurPass.radius = b.radius
  }

  return {
    renderer,
    scene,
    world,
    camera,
    composer,
    bloom,
    bloomPass,
    renderPass,
    light,
    resize,
    orbit,
    syncBloom,
    maxPointPx,
    get margin() {
      return marginPx
    },
    alpha,
    /* a solid drawn this frame: the window follows it (a no-op without one) */
    include(o) {
      if (win.on) included.push(o)
    },
    render,
    sleep,
    /* the rect a pointer's position is read against: the stage's when the
       canvas is a window onto it, else the canvas's (margin and all) */
    pointerRect: () => (win.on ? canvas.parentElement : canvas).getBoundingClientRect(),
    get window() {
      return win.on ? { x: win.x, y: win.y, w: win.w, h: win.h, W: win.W, H: win.H, overflow: win.overflow, most: win.most, asleep: win.asleep } : null
    },
  }
}
