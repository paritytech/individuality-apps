// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE FLIP — the flip page's opening, in place of the slit's insert-coin.
   The solid coin (lucky.js, the slit's own look) floats on the dark page
   with FLIP THE COIN under it, and goes one of two ways (FLIP.by):

     swipe up  a finger up on it — a let-go fast enough, or a drag far
               enough — and it flies up, slowing as a thrown coin does, to
               hang near the top, turning over
     tap       a tap on it, and it hops and comes AT you, turning over, to
               hang big in the middle of the screen

   Either way it is then UP (onUp(t, how)): the story's clock starts, the
   page goes black behind it (the host's), and the coin goes on turning over
   in front of you, never stopping, while the wheel, the wedge and your
   tickets come on behind it. Or, with FLIP.flyOver, it does not stop there:
   it keeps coming at you and flies on over your head, out of sight ('over',
   then 'gone'), until the host brings it back.

   Then the host lands it: ride(t) → null while it should hang on, else
   { x, y, r, tint, u, T } along the way down (u 0 → 1), or { done } — and it
   comes onto its ticket slowing its turn to land face-on, going flat in the
   ticket's colour, so the disc the host draws from there is the same pixel.

   The GL is a see-through layer in front of the whole page here (the host's
   createGL alpha), reaching FLIP.escapePx past the screen's edges, so the
   coin can leave the screen; the light ground is a canvas under it.

   It keeps where the coin has been (the last second of it), so the host can
   draw its trail: trace(t, T, buf, N). */

import * as THREE from 'three'
import { REDUCED } from '../../../render-utils/device.js'
import { layout } from '../../../render-utils/layout.js'
import { createLuckyCoin } from '../../../render-utils/coin/lucky.js'
import { FLIP } from './flip-config.js'

const TAU = Math.PI * 2
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const smooth = (u) => u * u * (3 - 2 * u)
const HIT_PAD = 40 //    the hit target is this much bigger than the coin, nominal px
const TAP_MS = 300 //    a press let go within this, and…
const TAP_PX = 12 //     …moved less than this, is a tap
const SPRING_S = 0.35 // a let-go that flips nothing settles back over this
const HOP_S = 0.45 //    the wrong gesture's little hop
const HANG_BOB_PX = 5 // hanging, it floats this much
const HANG_BOB_S = 1.6

/* where it hangs, by the way it went: near the top and smaller (it went
   away from you), or in the middle and big (it came at you) */
export function hangPose(how, W, H) {
  return how === 'viewer' ? { x: W / 2, y: FLIP.tapHangY, r: FLIP.tapHangPx } : { x: W / 2, y: FLIP.swipeHangY, r: FLIP.swipeHangPx }
}
/* where its way down starts: where it hangs — or, flown over you, from over
   you: big, its centre above the top edge */
export function startPose(how, W, H) {
  return FLIP.flyOver ? { x: W / 2, y: -0.35 * FLIP.overReturnPx, r: FLIP.overReturnPx } : hangPose(how, W, H)
}

export function createFlipIntro({ gl, app, look, onUp = null, ride = null }) {
  const coin = createLuckyCoin({ gl, look })
  const hit = document.createElement('div')
  hit.id = 'coin'
  hit.setAttribute('aria-label', 'Your lottery token — flip it')
  app.appendChild(hit)

  let active = false
  let phase = 'done' // rest → drag → fly | jump → hang (or over → gone) → land → done
  let how = null //     'top' | 'viewer': which way it went
  let t0 = 0
  let upT = 0 //        when it got up (the black is timed from there)
  let lastT = 0
  const pos = { x: 0, y: 0 }
  let r = 0
  const q = new THREE.Quaternion()
  const xAxis = new THREE.Vector3(1, 0, 0)
  let turn = 0 //       the flip so far, rad about x
  let turnAt0 = 0 //    …when this phase began
  const omega = () => TAU * FLIP.flipTurnsPerS
  const from = { x: 0, y: 0, r: 0 } // where the fly or the jump started
  let flyT = 0.3 //     the fly's length, s
  const back = { y0: 0, t0: -1 } // a let-go settling back home
  let hopT0 = -1
  /* the landing: where it was when the host first placed it (so the way
     down starts where the hanging coin is), and its turn's settle */
  const land = { dx: 0, dy: 0, turn0: 0, turn1: 0, m0: 0 }
  let tint = '#ffffff'
  let tintAmount = 0
  let flat = 0
  let shown = true //  false while it is gone, over your head
  let landFrames = 0 // frames drawn landing, for the suite (a slow machine may draw few)
  let peakR = 0 //     the biggest it has been drawn since the flip, and…
  let hung = false //  …whether it ever hung (for the suite)
  let goneAfterS = null // how far into the flight over you it was hidden, s

  /* where it has been: {t, x, y, r}, a second of it */
  const hist = []
  const record = (t) => {
    hist.push({ t, x: pos.x, y: pos.y, r })
    while (hist.length > 2 && t - hist[0].t > 1.2) hist.shift()
  }

  const stage = () => {
    const s = layout.scale
    return { W: layout.W / s, H: layout.H / s }
  }
  const homeY = () => FLIP.coinY
  const bob = (t) => (REDUCED ? 0 : FLIP.bobPx * Math.sin((TAU * t) / Math.max(0.2, FLIP.bobMs / 1000)))

  /* the pointer, in stage px, and its speed from the last ~80 ms */
  const pointer = { id: -1, x0: 0, y0: 0, t0: 0, samples: [] }
  const point = (e) => {
    const rc = app.getBoundingClientRect()
    return { x: (e.clientX - rc.left) / layout.scale, y: (e.clientY - rc.top) / layout.scale }
  }
  function velocity() {
    const s = pointer.samples
    while (s.length > 2 && s[s.length - 1].t - s[0].t > 80) s.shift()
    const a = s[0]
    const b = s[s.length - 1]
    if (!a || !b || b.t - a.t < 8) return { x: 0, y: 0 }
    return { x: ((b.x - a.x) * 1000) / (b.t - a.t), y: ((b.y - a.y) * 1000) / (b.t - a.t) }
  }

  function enter(p, t) {
    phase = p
    t0 = t
    turnAt0 = turn
  }
  function up(t) {
    upT = t
    // flown over: straight on over you; otherwise it hangs
    const over = FLIP.flyOver && !REDUCED
    hung = !over
    goneAfterS = null
    if (over) {
      from.x = pos.x
      from.y = pos.y
      from.r = r
      enter('over', t)
    } else enter('hang', t)
    onUp?.(t, how)
  }
  function launch(t, way, v = 0) {
    how = way
    from.x = pos.x
    from.y = pos.y
    from.r = r
    if (REDUCED) {
      const { W, H } = stage()
      Object.assign(pos, hangPose(way, W, H))
      r = hangPose(way, W, H).r
      return up(t)
    }
    if (way === 'top') {
      /* thrown up at v, slowing evenly to a stop where it hangs: it takes
         2·distance / v — the faster the finger, the sooner it is there */
      const { W, H } = stage()
      const dist = Math.max(1, from.y - hangPose('top', W, H).y)
      flyT = clamp((2 * dist) / Math.max(FLIP.flyPxS, v), 0.12, 1.5)
      enter('fly', t)
    } else enter('jump', t)
  }

  hit.addEventListener('pointerdown', (e) => {
    if (!active || (phase !== 'rest' && phase !== 'drag') || pointer.id >= 0) return
    e.preventDefault()
    pointer.id = e.pointerId
    try {
      hit.setPointerCapture?.(e.pointerId)
    } catch {
      /* a synthetic pointer (the smoke test) has nothing to capture */
    }
    const p = point(e)
    pointer.x0 = p.x
    pointer.y0 = p.y
    pointer.t0 = e.timeStamp
    pointer.samples = [{ t: e.timeStamp, x: p.x, y: p.y }]
    back.t0 = -1
    hit.classList.add('is-down')
    coin.recenter()
    coin.hold(true)
    enter('drag', lastT)
  })
  hit.addEventListener('pointermove', (e) => {
    if (phase !== 'drag' || e.pointerId !== pointer.id) return
    const p = point(e)
    pointer.samples.push({ t: e.timeStamp, x: p.x, y: p.y })
    if (pointer.samples.length > 16) pointer.samples.shift()
    // swipe: it follows the finger up (and only a little down); tap: it stays put
    const dy = p.y - pointer.y0
    if (FLIP.by === 'swipe up') pos.y = homeY() + (dy < 0 ? dy : dy * 0.25)
  })
  function letGo(e) {
    if (phase !== 'drag' || (e && e.pointerId !== pointer.id)) return
    if (e) coin.gesture()
    coin.hold(false)
    hit.classList.remove('is-down')
    pointer.id = -1
    const t = lastT
    const last = pointer.samples[pointer.samples.length - 1] ?? { x: pointer.x0, y: pointer.y0, t: pointer.t0 }
    const moved = Math.hypot(last.x - pointer.x0, last.y - pointer.y0)
    const tap = e && e.timeStamp - pointer.t0 <= TAP_MS && moved < TAP_PX
    const v = velocity()
    if (FLIP.by === 'tap') {
      if (tap) return launch(t, 'viewer')
    } else {
      if (-v.y >= FLIP.swipeMinPxS || pointer.y0 - last.y >= FLIP.swipeMinPx) return launch(t, 'top', -v.y)
      if (tap) hopT0 = t // the wrong gesture: a little hop, so it reads as something to flip
    }
    back.y0 = pos.y
    back.t0 = t
    enter('rest', t)
  }
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) hit.addEventListener(ev, letGo)
  const onBlur = () => letGo(null)
  window.addEventListener('blur', onBlur)

  /* the turn's settle onto a face over the landing: a Hermite from where it
     is, at the speed it has, to a whole number of half-turns, at rest — the
     nearest one far enough on that it never turns back */
  function settleTurn(u) {
    const u2 = u * u
    const u3 = u2 * u
    return land.turn0 * (2 * u3 - 3 * u2 + 1) + land.m0 * (u3 - 2 * u2 + u) + land.turn1 * (-2 * u3 + 3 * u2)
  }

  function update(t) {
    const dt = clamp(t - lastT, 0.0005, 0.05)
    lastT = t
    if (!active) return
    coin.step(dt)
    const { W, H } = stage()
    switch (phase) {
      case 'rest': {
        pos.x = W / 2
        r = look.coinR
        let y = homeY() + bob(t)
        if (back.t0 >= 0) {
          const u = clamp((t - back.t0) / SPRING_S, 0, 1)
          y = back.y0 + (y - back.y0) * (1 - (1 - u) ** 3)
          if (u >= 1) back.t0 = -1
        }
        if (hopT0 >= 0) {
          const u = clamp((t - hopT0) / HOP_S, 0, 1)
          y -= 36 * 4 * u * (1 - u)
          turn = Math.PI * u // half a turn: it lands on its other face
          if (u >= 1) {
            hopT0 = -1
            turn = Math.round(turn / Math.PI) * Math.PI
          }
        }
        pos.y = y
        break
      }
      case 'drag':
        pos.x = W / 2
        r = look.coinR
        break
      case 'fly': {
        /* up, slowing evenly to a stop where it hangs, shrinking a little as it goes away */
        const hp = hangPose('top', W, H)
        const u = clamp((t - t0) / flyT, 0, 1)
        const e = 1 - (1 - u) * (1 - u)
        pos.x = from.x + (hp.x - from.x) * e
        pos.y = from.y + (hp.y - from.y) * e
        r = from.r + (hp.r - from.r) * e
        turn = turnAt0 + omega() * (t - t0)
        if (u >= 1) up(t)
        break
      }
      case 'jump': {
        /* a hop, and at you: its size as a thing coming closer does — 1/r eased — to hang big in the middle */
        const hp = hangPose('viewer', W, H)
        const u = clamp((t - t0) / Math.max(0.05, FLIP.jumpMs / 1000), 0, 1)
        const e = smooth(u)
        r = 1 / (1 / from.r + (1 / hp.r - 1 / from.r) * e)
        pos.x = from.x + (hp.x - from.x) * e
        pos.y = from.y + (hp.y - from.y) * e - FLIP.hopPx * Math.sin(Math.PI * u)
        turn = turnAt0 + omega() * (t - t0)
        if (u >= 1) up(t)
        break
      }
      case 'over': {
        /* on at you and up over your head: its size as a thing coming closer
           does, r0/(1 − z), rising off the top — past the screen's edges, as
           far as escapePx lets it be seen — then gone: at hideAtMs into the
           flight, or at its end, whichever is first */
        const u = clamp((t - t0) / Math.max(0.05, FLIP.overMs / 1000), 0, 1)
        if (u >= 1 || t - t0 >= FLIP.hideAtMs / 1000) {
          goneAfterS = t - t0
          enter('gone', t)
          shown = false
          coin.hide()
          return // and not placed again this frame: place() would show it
        }
        const z = 0.97 * u * u
        r = from.r / (1 - z)
        pos.x = from.x
        pos.y = from.y - (from.y + 0.6 * H) * u * u
        turn = turnAt0 + omega() * (t - t0)
        break
      }
      case 'gone':
      case 'hang':
      case 'land': {
        const out = ride?.(t)
        if (out?.done) return finish()
        const hp = hangPose(how, W, H)
        if (!out && phase === 'gone') {
          turn = turnAt0 + omega() * (t - t0) // still turning, out of sight
          return
        }
        if (!out) {
          /* turning over in front of you, never stopping, while the page comes on behind it */
          if (phase === 'land') {
            // the host took it back (the timeline): hang again — or, flown over, be gone again
            if (FLIP.flyOver) {
              enter('gone', t)
              shown = false
              coin.hide()
              return
            }
            enter('hang', t)
          }
          pos.x = hp.x
          pos.y = hp.y + (REDUCED ? 0 : HANG_BOB_PX * Math.sin((TAU * (t - upT)) / HANG_BOB_S))
          r = hp.r
          turn = turnAt0 + omega() * (t - t0)
          tintAmount = 0
          flat = 0
          break
        }
        if (phase === 'hang' || phase === 'gone') {
          /* the host has started to land it: the way down starts where it is
             (gone, it starts where the host says: over you) */
          const T = Math.max(0.05, out.T ?? 1)
          land.dx = phase === 'hang' ? pos.x - out.x : 0
          land.dy = phase === 'hang' ? pos.y - out.y : 0
          shown = true
          land.turn0 = turn
          land.m0 = omega() * T
          land.turn1 = Math.ceil((turn + (omega() * T) / 3) / Math.PI) * Math.PI
          enter('land', t)
        }
        const u = clamp(out.u ?? 0, 0, 1)
        const k = 1 - smooth(u)
        pos.x = out.x + land.dx * k
        pos.y = out.y + land.dy * k
        r = out.r
        turn = settleTurn(u)
        landFrames++
        tint = out.tint ?? '#ffffff'
        tintAmount = clamp((u - 0.35) / 0.45, 0, 1)
        flat = clamp((u - 0.55) / 0.4, 0, 1)
        break
      }
      default:
        return
    }
    record(t)
    peakR = Math.max(peakR, r)
    q.setFromAxisAngle(xAxis, turn)
    coin.place(pos.x, pos.y, r, q)
    coin.look(1, tint, tintAmount, flat)
    coin.slitLight(0, 0)
    const sc = layout.scale
    const rHit = (r + HIT_PAD) * sc
    hit.style.width = hit.style.height = `${2 * rHit}px`
    hit.style.transform = `translate(${pos.x * sc - rHit}px, ${pos.y * sc - rHit}px)`
    hit.classList.toggle('is-hidden', phase !== 'rest' && phase !== 'drag')
  }

  function finish() {
    phase = 'done'
    active = false
    coin.hide()
    hit.classList.add('is-hidden')
    app.classList.remove('is-intro')
  }

  function replay() {
    active = true
    app.classList.add('is-intro')
    shown = true
    how = null
    turn = 0
    hopT0 = -1
    back.t0 = -1
    pointer.id = -1
    hist.length = 0
    tintAmount = 0
    landFrames = 0
    peakR = 0
    hung = false
    flat = 0
    hit.classList.remove('is-down')
    pos.y = homeY()
    r = look.coinR
    enter('rest', lastT)
  }
  replay()

  /* the way it came over the last T seconds, N+1 samples evenly in time, head
     first, into buf { pts, ang, wid } — ang only ever grows with time (the
     length still to go, as drop.js has it), which is all the painter asks */
  function trace(t, T, buf, N) {
    if (hist.length < 2 || T <= 0) return 0
    let n = 0
    let k = hist.length - 1
    let along = 0
    for (let j = 0; j <= N; j++) {
      const tj = t - (T * j) / N
      if (tj < hist[0].t) break
      while (k > 0 && hist[k - 1].t > tj) k--
      const a = hist[Math.max(0, k - 1)]
      const b = hist[k]
      const u = b.t > a.t ? clamp((tj - a.t) / (b.t - a.t), 0, 1) : 1
      const x = a.x + (b.x - a.x) * u
      const y = a.y + (b.y - a.y) * u
      if (j > 0) along += Math.hypot(x - buf.pts[2 * j - 2], y - buf.pts[2 * j - 1])
      buf.pts[2 * j] = x
      buf.pts[2 * j + 1] = y
      buf.wid[j] = 2 * (a.r + (b.r - a.r) * u)
      buf.ang[j] = -along / 2000
      n = j + 1
    }
    return n
  }

  return {
    update,
    replay,
    trace,
    end: () => active && finish(),
    get active() {
      return active
    },
    get phase() {
      return phase
    },
    get how() {
      return how
    },
    /* the coin as it is now, and whether it is on its way (its trail shows) */
    get coinNow() {
      return { x: pos.x, y: pos.y, r, out: phase === 'fly' || phase === 'jump' || phase === 'hang' || phase === 'over' }
    },
    coin,
    debug() {
      return { phase, active, how, x: pos.x, y: pos.y, r, turn, flat, shown, landFrames, peakR, hung, goneAfterS, by: FLIP.by }
    },
    dispose() {
      window.removeEventListener('blur', onBlur)
      hit.remove()
      app.classList.remove('is-intro')
      coin.dispose()
    },
  }
}
