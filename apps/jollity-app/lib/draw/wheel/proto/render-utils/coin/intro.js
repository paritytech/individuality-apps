// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE COIN — your lottery token, before the page it belongs to is seen. One
   object owns the phase, the gestures, the coin's motion and the slot's light,
   and it ends by handing the coin to whoever asked for it.

     wait      the coin sits below the bottom edge (launchDelayMs)
     launch    it flips straight up, the tumble dying as it rises, and stops
               face-on at homeY (launchMs, launchTurns); the slot comes up with it
     bob       it levitates (bobPx, bobMs, bobCurve). Pointer down on it — mid-
               spin, that turns the coin on to the next face and stops it —
     drag      it follows the finger VERTICALLY: the coin stays on the centre
               column. SIDEWAYS the finger turns it about the upright, as the
               coin lab's hand does (turnHalfTurnPx is half a turn); let go, it
               settles on the nearer face — the one the release was heading
               for — so a sideways drag flips it over. The slot's glow
               grows as the coin comes down, from glowStartPx above the mouth
               to its max at the swallow's depth (alpha restGlow → slotGlow);
               the chevron over the mouth goes under it. Crossing capturePx
               mid-drag swallows at once. With `flick` on, a finger faster than
               flickSpeedPx is flicking, not dragging: the coin stops following it and on
               release spins about the axis the flick sets, the sweep rounded to
               whole half-turns so the decay (spinTauMs) lands it face-on by
               itself. A slow let-go short of the line springs home (homeK,
               homeC) — or, springBack off, is fed into the slot from there
     swallow   the point of no return: the pointer is dead, the chevron goes.
               The coin sinks down the centre column to handoffAt·R under the
               mouth over swallowMs — leaving at the drag's speed, slowing to
               a steady sink — dimming behind the slot's dark block (slot.js):
               it goes INTO the slot. At that depth the host takes over —
     handover  ride(t, hand) places the coin, every frame, for as long as it
               wants it; the slot fades out under it (SLOT_FADE_S). With no
               ride the coin sinks on out of sight and fades behind the slot's
               dark block, and the slot goes after it
     done      the coin is gone and the page is the host's

   THE SEAM is `ride`. The coin knows nothing about what it becomes: it hands
   over `hand` — where it ended up, how big, and how fast it was still going
   down — and from there asks the host, every frame, where to be. The sphere
   turns itself under it until the coin is one of its dots; the wheel flies it
   round to its slot. Both are the host's business, and neither is here.

   REDUCED: the coin appears at home, nothing bobs or spins, and a tap inserts
   it.

   What is deliberately NOT here: the hand-over itself (the pin and the
   settle, which are the host's), and an `orbit.enableGyro()` on the first
   pointerup (this module knows no camera rig).

   THE COIN is the Lucky coin (lucky.js): the coin lab's, exactly — solid,
   letters, studio and key — with the slit's light on top as it comes down.
   A ride can take its light away (`flat`) so it arrives as a plain colour.

   ONE SIDE EFFECT worth knowing: while the coin is up, lucky.js turns the
   scene's hemisphere light off and gives the coin its own — the lab's studio
   as the scene's environment, its key, the slit — and puts tone mapping and
   multisampling on the composer. Any other lit solid in the host's scene is
   lit by that until the coin goes. */

import * as THREE from 'three'
import { COIN } from './config.js'
import { REDUCED } from '../device.js'
import { layout } from '../layout.js'
import { createSlot } from './slot.js'
import { createLuckyCoin } from './lucky.js'

const SLOT_FADE_S = 0.35 // the slot, mouth and hint fade out over this once the host has taken over
const SLOT_IN_S = 0.3 //   …and come up over this, COIN.slotInAtMs after the rise begins
const SINK_OUT_S = 0.6 //  no ride: the coin keeps sinking and fades over this, then it is done
const CHEVRON_BOTTOM = 30 // the chevron's box over the mouth, nominal px (mirrored in styles.css); its size is COIN.chevronPx
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const smooth = (a, b, x) => {
  const u = clamp((x - a) / Math.max(1e-6, b - a), 0, 1)
  return u * u * (3 - 2 * u)
}
const easeOut = (u) => 1 - (1 - u) ** 3
/* the levitation: each half-bob (up, then down) runs on one of these */
const bobCurves = {
  inOut: (u) => u * u * (3 - 2 * u),
  in: (u) => u * u,
  out: (u) => 1 - (1 - u) * (1 - u),
  linear: (u) => u,
}

/* gl        a stage from render-utils/gl.js: the coin hangs off gl.camera
   app       the stage element — the slot, the hit target and Replay go in it
   ride      (t, hand) → { x, y, r, opacity, tint, tintAmount, flat, done } in
             nominal stage px, called every frame from the hand-over on.
             flat (0..1) takes the light and the face art out, so at 1 the
             coin is the tint alone. Nothing (or done) ends the scene
   onSwallowed(hand)  the hand-over instant, once
   onFinish()         the coin is gone
   onReplay()         the in-page Replay text was pressed — the host resets
                      whatever it has and calls replay()
   replayButton       that text at all
   look               the coin's look (lucky.js; default the Lucky coin) — a
                      fresh object, since words() writes into it. The
                      vaporwave draw passes a plain white one */
export function createCoinIntro({ gl, app, ride = null, onSwallowed = null, onFinish = null, onReplay = null, replayButton = true, look = undefined }) {
  const coin = createLuckyCoin({ gl, look })
  const slot = createSlot({ app })

  /* the hit target rides the coin */
  const hit = document.createElement('div')
  hit.id = 'coin'
  hit.setAttribute('aria-label', 'Your lottery token — drag it into the slot')
  app.appendChild(hit)
  /* the replay text beside the reset: the scene from the top, any time */
  let replayBtn = null
  if (replayButton) {
    replayBtn = document.createElement('button')
    replayBtn.id = 'replay'
    replayBtn.type = 'button'
    replayBtn.textContent = 'Replay'
    app.appendChild(replayBtn)
    app.classList.add('has-replay')
    replayBtn.addEventListener('click', () => (onReplay ? onReplay() : replay()))
  }

  let phase = 'done'
  let active = false
  let t0 = 0 //     when the phase began
  let lastT = 0 //  the last frame's t
  let slotA = 0 //  the slot's opacity: it comes up SLOT_IN_S long, slotInAtMs after the rise begins
  let slotT0 = 0 // when that fade began
  let bobAt = 0 //  when the levitation starts: bobDelayMs after the launch lands
  let slotFade = 1 // …and what the hand-over is taking it down by

  /* the coin's motion, nominal stage px, y down */
  const pos = { x: 0, y: 0 }
  const vel = { x: 0, y: 0 }
  let radius = 0 //          on screen (nominal px)
  let opacity = 1 //         …and its fade, the host's to set through the ride
  let tintHex = '#fff'
  let tintAmount = 0
  let flat = 0 //            …and how far it has gone unlit, 0..1
  let tumble = 0 //          launch: the angle turned so far about x
  let tumbleTotal = 0 //     …out of this (whole half-turns)
  const qBase = new THREE.Quaternion() // what earlier spins left the coin at (a face-on pose)
  /* the running flick spin: total·(1 − e^(−t/τ)) about axis — or, braked by a
     press, a constant deceleration from a0 to total over T, so it stops on a face */
  const spin = { axis: new THREE.Vector3(1, 0, 0), total: 0, t0: -1, tau: 1, brake: false, a0: 0, T: 1 }
  const qSpin = new THREE.Quaternion()
  const qTmp = new THREE.Quaternion()
  const qFace = new THREE.Quaternion() // the nearest face-on pose to qBase, eased to after a spin cut short
  let fixing = false
  const q = new THREE.Quaternion()
  const vAxis = new THREE.Vector3()
  /* the sideways turn, about the upright, on top of everything else: the
     finger's x while it drags, then a critically damped spring (TURN_W) from
     where the release left it to the nearest whole half-turn it was heading
     for, closed-form in time as the lab's motion.js is. Settled, it is folded
     into qBase */
  const TURN_W = 7
  const turn = { ay: 0, grabX: 0, grabAy: 0, t0: -1, a0: 0, v0: 0, target: 0 }
  const qTurn = new THREE.Quaternion()
  const yAxis = new THREE.Vector3(0, 1, 0)
  function turnAt(t) {
    if (turn.t0 < 0) return turn.ay
    const d = turn.a0 - turn.target
    const u = t - turn.t0
    return turn.target + (d + (turn.v0 + TURN_W * d) * u) * Math.exp(-TURN_W * u)
  }
  /* let the turn go at t, at vx px/s sideways */
  function releaseTurn(t, vx) {
    turn.a0 = turnAt(t)
    turn.v0 = REDUCED ? 0 : (vx * Math.PI) / Math.max(1, COIN.turnHalfTurnPx)
    turn.target = Math.round((turn.a0 + turn.v0 / TURN_W) / Math.PI) * Math.PI
    turn.t0 = t
  }
  /* fold whatever the turn is at into the base pose (the hand-over): faceFix
     eases it onto a face from there */
  function foldTurn(t) {
    const a = turnAt(t)
    if (Math.abs(a) > 1e-6) qBase.premultiply(qTurn.setFromAxisAngle(yAxis, a))
    turn.ay = 0
    turn.t0 = -1
  }
  let heat = 0 // how near the coin is to going in, 0..1 — the glow's alpha is restGlow → slotGlow over it

  /* the pointer */
  let pointerId = -1
  const grab = { dy: 0 } // finger → coin centre offset at the grab (vertical: the drag is)
  const finger = { x: 0, y: 0 }
  const samples = [] // recent finger positions {t, x, y} (ms) for the release velocity
  let dragged = false // ever dragged: the hint goes for good
  let flicking = false // this hold turned out to be a flick: the coin stops following the finger
  let committed = false // past the point of no return: the pointer is dead, the chevron goes
  const sink = { y0: 0, v0: 0, t0: 0 } // the swallow: where the coin was caught, how fast it was going down, and when

  /* what the coin was at the hand-over — where it ended up, how big, and the
     speed it was still sinking at, so the host can leave at the coin's own */
  const hand = { t0: 0, x: 0, y: 0, r: 0, vy: 0 }

  /* ── geometry helpers, nominal stage px ─────────────────────────────── */
  const stage = () => {
    const s = layout.scale
    return { W: layout.W / s, H: layout.H / s, cx: layout.cx / s, cy: layout.cy / s, s }
  }
  const mouthY = () => COIN.slotY
  const parkY = () => stage().H + COIN.coinR + 20
  /* the coin's bottom edge → the mouth, px (negative once it is under) */
  const gap = () => mouthY() - (pos.y + radius)
  /* how far in the coin is, 0..1: 0 with its bottom edge glowStartPx above the
     mouth, 1 with its centre at the swallow's depth — one ramp through the
     drag and the swallow */
  const heatAt = (y) => smooth(mouthY() - COIN.glowStartPx - radius, mouthY() + COIN.handoffAt * radius, y)
  const heatNow = () => heatAt(pos.y)
  /* …and the glow's alpha for it: the two dials, 0..1 */
  const glowAlpha = (h) => COIN.restGlow + (COIN.slotGlow - COIN.restGlow) * clamp(h, 0, 1)
  /* the levitation's offset, −1..1: up on the curve, then down on it, once per bobMs.
     Still at home until bobAt, then starting from the middle of the wave (a
     quarter in), rising — so the wait ends in a bob, not a jump */
  function bobWave(t) {
    if (t < bobAt) return 0
    const per = Math.max(0.05, COIN.bobMs / 1000)
    const u = ((((t - bobAt) / per + 0.25) % 1) + 1) % 1
    const f = bobCurves[COIN.bobCurve] ?? bobCurves.inOut
    const h = u < 0.5 ? f(2 * u) : 1 - f(2 * u - 1)
    return 2 * h - 1
  }
  /* the home spring, toward the bob (or, REDUCED, the still home): a no-op at
     rest on it; after a release it brings the coin back */
  function springHome(t, dt) {
    const ty = REDUCED ? COIN.homeY : COIN.homeY + COIN.bobPx * bobWave(t)
    const tx = stage().cx
    vel.x += (COIN.homeK * (tx - pos.x) - COIN.homeC * vel.x) * dt
    vel.y += (COIN.homeK * (ty - pos.y) - COIN.homeC * vel.y) * dt
    pos.x += vel.x * dt
    pos.y += vel.y * dt
  }

  function enter(p, t) {
    phase = p
    t0 = t
    if (p === 'swallow') {
      committed = true // the point of no return
      sink.y0 = pos.y
      sink.v0 = Math.max(0, vel.y)
      sink.t0 = t
    }
  }

  /* the finger in stage px */
  function point(e) {
    const r = app.getBoundingClientRect()
    const s = layout.scale
    return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s }
  }

  /* the release velocity, px/s, from the samples of the last ~80 ms */
  function velocity(nowMs) {
    while (samples.length > 2 && nowMs - samples[0].t > 80) samples.shift()
    const a = samples[0]
    const b = samples[samples.length - 1]
    if (!a || !b || b.t - a.t < 8) return { x: 0, y: 0 }
    const dt = (b.t - a.t) / 1000
    return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt }
  }

  /* a flick: spin about the axis the flick sets. The near face follows the
     finger: for a velocity (vx, vy) on screen (y down) that axis is
     (vy, vx, 0) in camera-local units (x right, y up). The sweep ω₀·τ is rounded
     to whole half-turns so the exponential decay lands face-on by itself */
  function flick(v, t) {
    const speed = Math.hypot(v.x, v.y)
    if (speed < 1e-3) return
    bake(t)
    const tau = Math.max(0.05, COIN.spinTauMs / 1000)
    const n = Math.max(1, Math.round((COIN.flickGain * speed * tau) / Math.PI))
    spin.axis.set(v.y, v.x, 0).normalize()
    spin.total = n * Math.PI
    spin.tau = tau
    spin.brake = false
    spin.t0 = t
  }
  /* the spin's angle so far */
  const spinAngle = (t) => {
    if (spin.t0 < 0) return 0
    if (!spin.brake) return spin.total * (1 - Math.exp(-(t - spin.t0) / spin.tau))
    const u = clamp((t - spin.t0) / spin.T, 0, 1)
    return spin.a0 + (spin.total - spin.a0) * (1 - (1 - u) * (1 - u))
  }
  const BRAKE_MIN_S = 0.15
  /* a press mid-spin: keep turning, at the speed it has, on to the next face
     (a whole number of half-turns) and stop there — a constant deceleration,
     never shorter than BRAKE_MIN_S, so a fresh, fast spin takes a few more
     turns to come to rest rather than snapping */
  function brake(t) {
    if (spin.t0 < 0 || spin.brake) return
    const a = spinAngle(t)
    const w = (spin.total - a) / spin.tau // rad/s right now
    if (w < 1e-3) return bake(t)
    const aEnd = Math.min(spin.total, Math.ceil((a + (w * BRAKE_MIN_S) / 2) / Math.PI) * Math.PI)
    if (aEnd - a < 1e-3) return bake(t)
    spin.brake = true
    spin.a0 = a
    spin.total = aEnd
    spin.T = (2 * (aEnd - a)) / w
    spin.t0 = t
  }
  /* fold the running spin into the base pose — at its end (face-on by
     construction), or, cut short by a new flick, where it is right now: then
     the base is off a face and faceFix() eases it onto the nearest one */
  function bake(t = Infinity) {
    if (spin.t0 < 0) return
    const a = Math.min(spin.total, spinAngle(t))
    qTmp.setFromAxisAngle(spin.axis, a)
    qBase.premultiply(qTmp)
    spin.t0 = -1
    spin.brake = false
    faceFix()
  }
  const vFace = new THREE.Vector3()
  const vTmp = new THREE.Vector3()
  function faceFix() {
    vFace.set(0, 0, 1).applyQuaternion(qBase)
    const sign = vFace.z >= 0 ? 1 : -1
    if (Math.abs(vFace.z) > 0.9995) return
    qTmp.setFromUnitVectors(vFace, vTmp.set(0, 0, sign))
    qFace.copy(qBase).premultiply(qTmp)
    fixing = true
  }

  /* ── the pointer ────────────────────────────────────────────────────── */
  hit.addEventListener('pointerdown', (e) => {
    if (!active || phase !== 'bob' || pointerId >= 0) return
    e.preventDefault()
    pointerId = e.pointerId
    try {
      hit.setPointerCapture?.(e.pointerId)
    } catch {
      /* a synthetic pointer (the smoke test) has nothing to capture */
    }
    hit.classList.add('is-down')
    const p = point(e)
    grab.dy = pos.y - p.y
    finger.x = p.x
    finger.y = p.y
    flicking = false
    samples.length = 0
    samples.push({ t: e.timeStamp, x: p.x, y: p.y })
    // grab the turn where it is, mid-settle or not
    turn.ay = turnAt(lastT)
    turn.t0 = -1
    turn.grabX = p.x
    turn.grabAy = turn.ay
    brake(lastT) // pressed mid-spin: on to the next face, and stop
    coin.recenter() // the phone as it is now is the front: the coin squares up…
    coin.hold(true) // …and does not lean while it is in hand
    enter('drag', lastT)
  })
  hit.addEventListener('pointermove', (e) => {
    if (phase !== 'drag' || e.pointerId !== pointerId) return
    const p = point(e)
    finger.x = p.x
    finger.y = p.y
    samples.push({ t: e.timeStamp, x: p.x, y: p.y })
    if (samples.length > 16) samples.shift()
    // a finger this fast is flicking: from here the coin no longer follows it
    if (!flicking && !REDUCED && COIN.flick) {
      const v = velocity(e.timeStamp)
      if (Math.hypot(v.x, v.y) >= COIN.flickSpeedPx) flicking = true
    }
    if (!flicking) turn.ay = turn.grabAy + ((p.x - turn.grabX) * Math.PI) / Math.max(1, COIN.turnHalfTurnPx)
    if (!flicking && (Math.abs(p.y + grab.dy - pos.y) > 2 || Math.abs(p.x - turn.grabX) > 2)) dragged = true
  })
  function letGo(e) {
    if (phase !== 'drag' || (e && e.pointerId !== pointerId)) return
    if (e) coin.gesture() // iOS asks for motion access only inside a release: the light's turn
    coin.hold(false)
    hit.classList.remove('is-down')
    pointerId = -1
    const t = lastT
    // REDUCED: a tap is the whole gesture — it inserts
    const v = velocity(e ? e.timeStamp : performance.now())
    releaseTurn(t, flicking ? 0 : v.x) // it settles on the face it was heading for
    if (REDUCED && !dragged) return enter('swallow', t)
    if (!flicking && gap() <= COIN.capturePx) return enter('swallow', t)
    vel.x = 0 // the coin never leaves the centre column
    if (!REDUCED && COIN.flick && (flicking || Math.hypot(v.x, v.y) >= COIN.flickSpeedPx)) {
      flick(v, t)
      return enter('bob', t)
    }
    // springBack off: a drag let go short of the line is fed in from there
    if (!COIN.springBack && dragged) return enter('swallow', t)
    vel.y = v.y
    enter('bob', t)
  }
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) hit.addEventListener(ev, letGo)
  const onBlur = () => letGo(null)
  window.addEventListener('blur', onBlur)

  /* ── the frame ──────────────────────────────────────────────────────── */
  function update(t) {
    const dt = clamp(t - lastT, 0.0005, 0.05)
    lastT = t
    if (!active) return
    const { cx } = stage()
    slot.sync()
    coin.step(dt) // the lab's light, turned by your hand

    switch (phase) {
      case 'wait': {
        radius = COIN.coinR
        pos.x = cx
        pos.y = REDUCED ? COIN.homeY : parkY()
        if (REDUCED || t - t0 >= COIN.launchDelayMs / 1000) {
          if (REDUCED) {
            slotT0 = t
            enter('bob', t)
          } else {
            tumbleTotal = Math.max(1, Math.round(COIN.launchTurns * 2)) * Math.PI
            slotT0 = t
            enter('launch', t)
          }
        }
        break
      }
      case 'launch': {
        const u = clamp((t - t0) / Math.max(0.05, COIN.launchMs / 1000), 0, 1)
        const e = easeOut(u)
        const park = parkY()
        pos.y = park + (COIN.homeY - park) * e
        pos.x = cx // straight up, no sway
        tumble = tumbleTotal * e
        if (u >= 1) {
          qBase.setFromAxisAngle(vAxis.set(1, 0, 0), tumbleTotal) // a face-on pose (whole half-turns)
          tumble = 0
          vel.x = vel.y = 0
          bobAt = t + Math.max(0, COIN.bobDelayMs) / 1000 // a beat at home before it bobs
          enter('bob', t)
        }
        break
      }
      case 'bob': {
        radius = COIN.coinR // the dial is live
        springHome(t, dt)
        heat = heatNow()
        break
      }
      case 'drag': {
        radius = COIN.coinR
        // vertical only: the coin rides the centre column, the finger's y from the grab
        if (flicking) springHome(t, dt) // a flick: the coin is not dragged along
        else {
          pos.x = cx
          pos.y = finger.y + grab.dy
          vel.x = vel.y = 0
        }
        heat = heatNow()
        if (!flicking && gap() <= COIN.capturePx) {
          const v = velocity(performance.now())
          releaseTurn(t, v.x)
          vel.x = 0
          vel.y = v.y
          coin.hold(false)
          hit.classList.remove('is-down')
          pointerId = -1
          enter('swallow', t)
        }
        break
      }
      case 'swallow': {
        /* the sink: a cubic in time from the catch (y0, at the drag's speed v0)
           to the hand-over depth y1 in T = swallowMs, arriving at the steady
           speed dist/T — a Hermite; v0 capped at 3·dist/T keeps it monotonic.
           The dials are live: y1 and T are re-read each frame */
        radius = COIN.coinR
        const T = Math.max(0.001, COIN.swallowMs / 1000)
        const y1 = mouthY() + COIN.handoffAt * radius
        const dist = Math.max(0, y1 - sink.y0)
        const ve = dist / T
        const vs = clamp(sink.v0, 0, 3 * ve)
        const u = clamp((t - t0) / T, 0, 1)
        const u2 = u * u
        const u3 = u2 * u
        pos.x = cx
        pos.y = sink.y0 + dist * (3 * u2 - 2 * u3) + T * (vs * (u3 - 2 * u2 + u) + ve * (u3 - u2))
        vel.x = 0
        vel.y = (dist * 6 * (u - u2)) / T + vs * (3 * u2 - 4 * u + 1) + ve * (3 * u2 - 2 * u)
        heat = heatNow() // on to its max at the swallow's depth
        if (u >= 1) {
          pos.y = y1
          bake()
          foldTurn(t)
          faceFix() // a turn cut short by the hand-over eases onto its face
          hand.t0 = t
          hand.x = pos.x
          hand.y = pos.y
          hand.r = radius
          hand.vy = ve
          enter('handover', t)
          onSwallowed?.(hand)
        }
        break
      }
      case 'handover': {
        /* the host's, from here: it places the coin every frame for as long as
           it wants it. The slot fades out under it either way */
        if (!ride) {
          // nobody to hand over to: the coin sinks on out of sight, fading behind
          // the slot's dark block, and only then does the slot go — or the coin,
          // deeper than the block hides, would be seen again under the mouth
          const s = clamp((t - t0) / SINK_OUT_S, 0, 1)
          slotFade = 1 - clamp((t - t0 - SINK_OUT_S) / SLOT_FADE_S, 0, 1)
          heat = 1 - s
          pos.x = hand.x
          pos.y = hand.y + hand.vy * (t - hand.t0)
          radius = hand.r
          opacity = 1 - s
          if (s >= 1 && slotFade <= 0) return finish()
          break
        }
        slotFade = 1 - clamp((t - t0) / SLOT_FADE_S, 0, 1)
        heat = slotFade
        const out = ride(t, hand)
        if (!out || out.done) return finish()
        pos.x = out.x ?? hand.x
        pos.y = out.y ?? hand.y
        radius = Math.max(0.01, out.r ?? hand.r)
        opacity = out.opacity ?? 1
        tintHex = out.tint ?? '#fff'
        tintAmount = out.tintAmount ?? 0
        flat = out.flat ?? 0
        break
      }
      default:
        return
    }

    /* the coin's pose: the launch tumble, the baked pose, the running spin */
    if (phase === 'launch') q.setFromAxisAngle(vAxis.set(1, 0, 0), tumble)
    else {
      q.copy(qBase)
      if (spin.t0 >= 0) {
        const a = spinAngle(t)
        if (spin.total - a < 0.002) bake()
        else q.premultiply(qSpin.setFromAxisAngle(spin.axis, a))
      } else if (fixing) {
        qBase.slerp(qFace, Math.min(1, dt * 8))
        if (qBase.angleTo(qFace) < 0.002) fixing = false
        q.copy(qBase)
      }
      // the sideways turn on top; settled on its face (and no spin running), folded in
      const ay = turnAt(t)
      if (turn.t0 >= 0 && spin.t0 < 0 && t - turn.t0 > 0.2 && Math.abs(ay - turn.target) < 0.002) {
        turn.ay = turn.target
        turn.t0 = -1
        foldTurn(t)
        q.copy(qBase)
      } else if (Math.abs(ay) > 1e-6) q.premultiply(qTurn.setFromAxisAngle(yAxis, ay))
    }

    coin.place(pos.x, pos.y, radius, q)
    coin.look(opacity, tintHex, tintAmount, flat)
    const glowA = phase === 'handover' ? heat * glowAlpha(1) : glowAlpha(heat)
    slot.hot(glowA)
    // the slit lights the coin from below as it comes in, counted from where it
    // floats — none at home, where it is the lab's coin to the pixel
    const heatHome = heatAt(COIN.homeY)
    coin.slitLight(mouthY(), phase === 'handover' ? heat : clamp((heat - heatHome) / Math.max(1e-3, 1 - heatHome), 0, 1))
    if (phase !== 'handover') {
      // the whole slit — glow, hairline, chevron, hint, dark block — SLOT_IN_S long, slotInAtMs after the rise begins
      const at = COIN.slotInAtMs / 1000
      slotA = phase === 'wait' ? 0 : smooth(at, at + SLOT_IN_S, t - slotT0)
    }
    slot.show(slotA * slotFade)
    slot.hint(dragged || committed || phase === 'wait' ? 0 : 1)
    // the chevron sits BEHIND the coin: as the coin's bottom edge comes over its box it goes
    const chevTop = mouthY() - CHEVRON_BOTTOM - COIN.chevronPx
    slot.chevron(committed || phase === 'wait' ? 0 : 1 - smooth(chevTop - 8, chevTop + 8, pos.y + radius))

    // the hit target rides the coin (css px)
    const sc = layout.scale
    const rHit = (radius + COIN.hitPadPx) * sc
    hit.style.width = hit.style.height = `${2 * rHit}px`
    hit.style.transform = `translate(${pos.x * sc - rHit}px, ${pos.y * sc - rHit}px)`
    hit.classList.toggle('is-hidden', committed || phase === 'wait' || phase === 'launch')
  }

  function finish() {
    phase = 'done'
    active = false
    coin.hide()
    slot.show(0)
    slot.hot(0)
    hit.classList.add('is-hidden')
    app.classList.remove('is-intro')
    onFinish?.() // the page is the host's from here
  }

  /* start (or start again) from the top */
  function replay() {
    active = true
    app.classList.add('is-intro')
    qBase.identity()
    spin.t0 = -1
    tumble = 0
    heat = 0
    dragged = false
    flicking = false
    committed = false
    fixing = false
    turn.ay = 0
    turn.t0 = -1
    slotA = 0
    slotFade = 1
    opacity = 1
    tintHex = '#fff'
    tintAmount = 0
    flat = 0
    pointerId = -1
    hit.classList.remove('is-down')
    vel.x = vel.y = 0
    radius = COIN.coinR
    hand.t0 = hand.vy = 0
    coin.look(1, '#fff', 0)
    slot.show(0)
    slot.hot(glowAlpha(0))
    slot.hint(0)
    slot.chevron(0)
    enter('wait', lastT)
  }

  replay()

  return {
    update,
    replay,
    /* the host has called it off — a toggle went out from under it. The coin
       goes, the slot goes, and onFinish fires as if it had run its course */
    end: () => active && finish(),
    get active() {
      return active
    },
    get phase() {
      return phase
    },
    /* what the coin was at the hand-over — the ride gets this too */
    get hand() {
      return hand
    },
    coin,
    slot,
    /* what this frame did, for the smoke test */
    debug() {
      return {
        phase,
        active,
        x: pos.x,
        y: pos.y,
        vx: vel.x,
        vy: vel.y,
        radius,
        opacity,
        flat,
        lean: coin.lean, // the coin's own lean with your hand, deg (0: square to you)
        letters: coin.letterTriangles, // the Lucky coin's 3D letters, front and back
        hot: slot.hotValue,
        spinning: spin.t0 >= 0 && spin.total - spinAngle(lastT) > 0.01,
        braking: spin.t0 >= 0 && spin.brake,
        spinTotal: spin.t0 >= 0 ? spin.total : 0,
        flicking,
        turn: turnAt(lastT), //  the sideways turn not yet folded in, rad
        back: vFace.set(0, 0, 1).applyQuaternion(q).z < 0, // the back is toward you
        faceOn: Math.abs(vFace.set(0, 0, 1).applyQuaternion(q).z), // 1 = a face square to you (the intro's own pose, before the hand's lean)
        mouthY: mouthY(),
        gap: gap(),
        committed,
        hand: { ...hand },
      }
    },
    dispose() {
      window.removeEventListener('blur', onBlur)
      hit.remove()
      replayBtn?.remove()
      slot.element.remove()
      app.classList.remove('is-intro', 'has-replay')
      coin.dispose()
    },
  }
}
