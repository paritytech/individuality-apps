// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE FALL — a coin off a disc and back onto it, a headline, and every other
   disc falling off the page. The host has already put the view where it
   wants it before play(), and then:

     flip      the host's disc comes off as the coin, jumps up off its own
               place tumbling end over end, growing as it rises, and lands
               back on the same place face-on — blank, and in the host's
               colour the whole way
     headline  from the landing, the host's words come up over the stage
     fall      fallAfterMs after the landing, every other disc the host
               handed over comes away and falls off the page: a kick up,
               gravity through air, a stagger in the order the dial says,
               tumbling as they go. The coin's own disc is left, alone.

   The coin is render-utils/coin/'s solid on the host's GL stage; the falling
   discs are the HOST's painter's (dropOf hands it where each one is), so
   they fall in their own size and colour, rings and all.

   Every frame is a closed form of the time since play(), like the prize: the
   flip is a function of u, and the fall is the confetti's linear-drag
   solution (render-utils/prize/confetti.js),

     y(t) = y0 + (g/k)·t + (vy0 − g/k)·(1 − e^(−kt))/k
     x(t) = x0 + vx0·(1 − e^(−kt))/k

   so a slow frame never moves anything, and every dial here (FALL, in
   ./config.js) is read every frame — moving one moves the outro where it is.

   The words are the host's, never this file's: `headline` is a string or a
   function returning one, read every frame. So are the DOM names — `id` for
   the layer (its headline is `.<id>-headline`) and `appClass`, which #app
   carries while it plays — so a page's own stylesheet keeps its own names. */

import * as THREE from 'three'
import { createCoin } from '../coin/coin.js'
import { PRIZE } from '../prize/config.js'
import { layout } from '../layout.js'
import { REDUCED } from '../device.js'
import { lcg } from '../rng.js'
import { createOrbit, CAMERA } from '../camera.js'
import { FALL } from './config.js'

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const smooth = (x) => x * x * (3 - 2 * x)
const X_AXIS = new THREE.Vector3(1, 0, 0)
const DEG = Math.PI / 180
/* the hand on the coin, as the coin lab's: gyro on a phone, the pointer on a
   desktop, through the stage's orbit rig — the coin leans this share of how
   far you have turned round it (look.js's tiltShare), within CAMERA.swing */
const LEAN = 0.35

export function createFallOutro({ gl, app, id = 'fall', appClass = 'is-falling', headline = '' }) {
  const coin = createCoin({ gl })
  const orbit = createOrbit()
  CAMERA.mouse = matchMedia('(pointer: fine)').matches // a desktop's pointer is its "gyro", as in the lab
  orbit.armGyro()
  const onPointer = (e) => {
    const r = gl.pointerRect?.() ?? gl.renderer.domElement.getBoundingClientRect()
    orbit.mouse(e.clientX - r.left, e.clientY - r.top, r.width, r.height)
  }
  addEventListener('pointermove', onPointer)
  const qTilt = new THREE.Quaternion()
  const qFlip = new THREE.Quaternion() // the flip alone, without the lean — what faceOn measures
  const eTilt = new THREE.Euler(0, 0, 0, 'XYZ')
  let handT = -1 // the rig's own clock: it eases on real time, whatever the host's clock does

  const root = document.createElement('div')
  root.id = id
  root.className = 'is-hidden'
  root.innerHTML = `<div class="${id}-headline"></div>`
  app.appendChild(root)
  const head = root.querySelector(`.${id}-headline`)
  let words = headline
  const wordsNow = () => String((typeof words === 'function' ? words() : words) ?? '')

  let active = false
  let t0 = 0
  let lastT = 0
  let restart = false
  let from = { x: 195, y: 440, r: 3 }
  let tint = '#ffffff'
  let mineOpacity = 1 // yours, the coin: how much of it shows (the host's — a slot not lit, held back)
  /* YOURS TOO, if the host asks (mineFallsAfterMs): this long after the last
     of the others is off the page, the coin on your slot goes the same way —
     a kick straight up and the same air and gravity — so nobody is left.
     null (the default, the lost page's and the flow's): yours stays, alone */
  let mineAfter = null
  const MINE_KICK = 0.7 // its throw, a share of fallKickPx — a middling one of the others'
  const MINE_FLIP = 7 //  rad/s, end over end as it goes
  const pos = { x: 0, y: 0, r: 0 }
  const q = new THREE.Quaternion()
  const vFace = new THREE.Vector3()
  const written = new Map()
  function put(el, prop, value) {
    const key = `${el === head ? 'h' : 'r'}:${prop}`
    if (written.get(key) === value) return
    written.set(key, value)
    el.style.setProperty(prop, value)
  }

  /* the discs, by SLOT index k: where each rests (nominal px), its own
     throw, and its place in each of the orders — all made once per play, so
     the order dial is live */
  let n = 0
  let has = null //  Uint8Array: 1 for a slot that falls
  let x0 = null
  let y0 = null
  let ang = null //  kick direction, a share of ±spread either side of up
  let kick = null // kick speed, a share of fallKickPx
  let flip = null // rad/s, end over end
  let turn = null // rad/s, in the plane
  let phase = null
  const ranks = {} // order → Float32Array of 0..1, the share of the stagger it waits
  let falling = 0
  let fallen = 0

  function rankBy(keys) {
    const idx = []
    for (let k = 0; k < n; k++) if (has[k]) idx.push(k)
    idx.sort((a, b) => keys[a] - keys[b])
    const out = new Float32Array(n)
    const last = Math.max(1, idx.length - 1)
    idx.forEach((k, i) => (out[k] = i / last))
    return out
  }

  /* the phases, in seconds from t0 */
  const flipS = () => Math.max(0.05, FALL.flipMs / 1000)
  const fallAtS = () => flipS() + Math.max(0, FALL.fallAfterMs) / 1000

  /* the discs, ahead of play() — a host whose slider wants to know how long
     the whole thing is (endS) before it has started primes it first:
       from      { x, y, r } your disc on screen, nominal px — the coin's first frame
       count     how many discs the host has
       discs     [{ k, x, y }] every slot but yours, resting, nominal px
       mineFallsAfterMs  yours falls too, this long after the last of them (null: it stays) */
  function prime({ from: f, count = 0, discs = [], mineFallsAfterMs = null } = {}) {
    from = { ...f }
    mineAfter = mineFallsAfterMs == null ? null : Math.max(0, mineFallsAfterMs) / 1000
    n = count
    has = new Uint8Array(n)
    x0 = new Float32Array(n)
    y0 = new Float32Array(n)
    ang = new Float32Array(n)
    kick = new Float32Array(n)
    flip = new Float32Array(n)
    turn = new Float32Array(n)
    phase = new Float32Array(n)
    const shuffle = new Float32Array(n)
    const dist = new Float32Array(n)
    const rnd = lcg(31)
    for (const d of discs) {
      const k = d.k
      has[k] = 1
      x0[k] = d.x
      y0[k] = d.y
      ang[k] = rnd() * 2 - 1
      kick[k] = 0.4 + 0.6 * rnd()
      flip[k] = 4 + rnd() * 8
      turn[k] = (rnd() * 2 - 1) * 4
      phase[k] = rnd() * Math.PI * 2
      shuffle[k] = rnd()
      dist[k] = Math.hypot(d.x - from.x, d.y - from.y)
    }
    ranks['from yours out'] = rankBy(dist)
    ranks.random = rankBy(shuffle)
    ranks['top first'] = rankBy(y0)
    endKey = ''
  }

  /* start (or start again) at t, primed with the same three as prime(), and:
       tint      your colour — the coin's, the whole way
       free      the first frame is free (update(), below) — or false, for a
                 host that runs one clock of its own over the whole outro and
                 pauses it for that frame itself, so a slider over it stays true */
  function play({ t, from: f, tint: tn = '#ffffff', count = 0, discs = [], free = true, headline: h, mineFallsAfterMs = null } = {}) {
    prime({ from: f, count, discs, mineFallsAfterMs })
    if (h !== undefined) words = h
    tint = tn
    coin.setFaces({})
    coin.setBase('#ffffff')
    t0 = t
    restart = free
    active = true
    root.classList.remove('is-hidden')
    app.classList.add(appClass)
    update(t)
  }

  function update(t) {
    lastT = t
    if (!active) return
    // the first frame compiles the coin and can stall: the clock starts from the next (reveal.js)
    if (restart && t > t0) {
      restart = false
      t0 = t
    }
    const e = Math.max(0, t - t0)

    /* the flip: up off the slot and back onto it, growing to its peak on
       the way up and coming down to its landed size */
    const u = clamp01(e / flipS())
    const hop = Math.sin(Math.PI * u)
    // back at the size of the disc it came off, or at the dial's
    const land = FALL.landAsDisc ? Math.max(0.5, from.r) : Math.max(1, FALL.flipLandPx)
    const base = from.r + (land - from.r) * u
    pos.x = from.x
    pos.y = from.y - Math.max(0, FALL.flipUpPx) * hop
    pos.r = base + (Math.max(1, FALL.flipPeakPx) - base) * hop
    // half-turns at a steady rate: the coin is blank both sides, so any of them lands face-on
    const halves = REDUCED ? 0 : Math.max(0, Math.round(FALL.flipTurns * 2))
    /* yours, falling after the others (mineFallsAfterMs): off its slot the same way they went */
    const mineDt = mineAfter != null && FALL.fall ? e - mineAtS() : -1
    if (mineDt > 0) {
      mineInto(mineDt, mineAt)
      pos.x = mineAt.x
      pos.y = mineAt.y
      pos.r = land
    }
    const tumbling = mineDt > 0 && FALL.fallTumble && !REDUCED ? MINE_FLIP * mineDt : 0
    q.setFromAxisAngle(X_AXIS, halves * Math.PI * u + tumbling)
    qFlip.copy(q)
    /* …leaning with your hand on top of the flip */
    const now = performance.now() / 1000
    const o = orbit.step(handT < 0 ? 0 : Math.min(0.1, now - handT))
    handT = now
    q.premultiply(qTilt.setFromEuler(eTilt.set(o.pitch * DEG * LEAN, -o.yaw * DEG * LEAN, 0)))

    coin.size(PRIZE.coinR, PRIZE.coinThick) // built at the prize's proportions, scaled to size
    // your colour, all of it: a plain finish (the coin intro's own), since a metal one darkens a colour toward its reflections
    coin.metal({ metalness: 0, roughness: 0.65, bumpScale: 0 })
    coin.place(pos.x, pos.y, pos.r, q)
    coin.look(mineOpacity, tint, 1)
    coin.lightAt(pos.x - 140, pos.y - 170, 460, PRIZE.keyLight, PRIZE.fillLight)

    /* the headline, from the landing — its words read live, like every dial here */
    const said = wordsNow()
    if (head.textContent !== said) head.textContent = said
    const fade = Math.max(0.01, FALL.fadeMs / 1000)
    const a = e < flipS() ? 0 : smooth(clamp01((e - flipS()) / fade))
    put(root, `--${id}-head-y`, `${FALL.headY}px`)
    put(head, 'opacity', a.toFixed(2))
    put(head, '--rise', `${((1 - a) * 10).toFixed(1)}px`)

    countFall(e)
  }

  /* the seconds disc k has been falling, e seconds in, or < 0 */
  function fallFor(k, e) {
    if (!FALL.fall || !has || !has[k]) return -1
    const order = ranks[FALL.fallOrder]
    const wait = order ? order[k] * Math.max(0, FALL.fallStaggerMs) / 1000 : 0
    return e - fallAtS() - wait
  }

  /* where a falling disc is, dt seconds into its fall: into out */
  function fallInto(k, dt, out) {
    const spread = (FALL.fallSpreadDeg * Math.PI) / 180
    const a = -Math.PI / 2 + ang[k] * spread
    const v = Math.max(0, FALL.fallKickPx) * kick[k]
    const vx = Math.cos(a) * v
    const vy = Math.sin(a) * v
    const kd = Math.max(0.01, FALL.fallDrag)
    const g = Math.max(0, FALL.fallGravityPx)
    const decay = (1 - Math.exp(-kd * dt)) / kd
    out.x = x0[k] + vx * decay
    out.y = y0[k] + (g / kd) * dt + (vy - g / kd) * decay
    const tumble = FALL.fallTumble && !REDUCED
    out.sq = tumble ? Math.cos(flip[k] * dt) : 1
    out.rot = tumble ? phase[k] + turn[k] * dt : 0
    return out
  }

  /* yours, dt seconds into its fall: straight up off its slot, then the others' air and gravity */
  const mineAt = { x: 0, y: 0 }
  function mineInto(dt, out) {
    const vy = -Math.max(0, FALL.fallKickPx) * MINE_KICK
    const kd = Math.max(0.01, FALL.fallDrag)
    const g = Math.max(0, FALL.fallGravityPx)
    const decay = (1 - Math.exp(-kd * dt)) / kd
    out.x = from.x
    out.y = from.y + (g / kd) * dt + (vy - g / kd) * decay
    return out
  }
  /* when yours goes, s from play(): mineFallsAfterMs after the last of the others is off */
  const mineAtS = () => othersOffS() + (mineAfter ?? 0)

  const probe = { x: 0, y: 0, sq: 1, rot: 0 }
  let endKey = ''
  let endAt = 0
  /* when the last of the others is off the page, s from play(): each leaves
     where its fall first crosses the bottom edge — past the top of its throw
     y only grows, so a bisection from there finds it. Worked out again only
     when a dial that moves it has moved */
  function othersOffS() {
    const key = [FALL.flipMs, FALL.fallAfterMs, FALL.fall, FALL.fallOrder, FALL.fallStaggerMs, FALL.fallKickPx, FALL.fallSpreadDeg, FALL.fallGravityPx, FALL.fallDrag, layout.H, layout.scale, n].join('|')
    if (key === endKey) return endAt
    endKey = key
    endAt = fallAtS()
    if (!FALL.fall || !has) return endAt
    const H = layout.H / layout.scale + 40
    const kd = Math.max(0.01, FALL.fallDrag)
    const g = Math.max(0, FALL.fallGravityPx)
    for (let k = 0; k < n; k++) {
      if (!has[k]) continue
      const wait = -(fallFor(k, 0) + fallAtS()) // fallFor(k, e) is e − fallAt − wait
      const a = -Math.PI / 2 + ang[k] * ((FALL.fallSpreadDeg * Math.PI) / 180)
      const vy = Math.sin(a) * Math.max(0, FALL.fallKickPx) * kick[k]
      const top = g > 0 && vy < 0 ? Math.log((g / kd - vy) / (g / kd)) / kd : 0 // where vy crosses zero
      let lo = top
      let hi = 60
      if (fallInto(k, hi, probe).y < H) {
        endAt = Math.max(endAt, fallAtS() + wait + hi) // it never leaves: the slider stops a minute in
        continue
      }
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2
        if (fallInto(k, mid, probe).y > H) hi = mid
        else lo = mid
      }
      endAt = Math.max(endAt, fallAtS() + wait + hi)
    }
    return endAt
  }
  /* …and how long yours takes to leave once it goes */
  function mineOffS() {
    const H = layout.H / layout.scale + 40
    const kd = Math.max(0.01, FALL.fallDrag)
    const g = Math.max(0, FALL.fallGravityPx)
    const vy = -Math.max(0, FALL.fallKickPx) * MINE_KICK
    let lo = g > 0 && vy < 0 ? Math.log((g / kd - vy) / (g / kd)) / kd : 0
    let hi = 60
    if (mineInto(hi, probe).y < H) return hi
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2
      if (mineInto(mid, probe).y > H) hi = mid
      else lo = mid
    }
    return hi
  }
  function countFall(e) {
    falling = 0
    fallen = 0
    if (!has) return
    const H = layout.H / layout.scale
    for (let k = 0; k < n; k++) {
      const dt = fallFor(k, e)
      if (dt <= 0) continue
      fallInto(k, dt, probe)
      if (probe.y > H + 40) fallen++
      else falling++
    }
  }

  const drop = { x: 0, y: 0, sq: 1, rot: 0 }
  return {
    prime,
    play,
    update,
    /* how much of your coin shows, 0..1 (the host's: 1 unless it says) */
    set mineOpacity(v) {
      mineOpacity = Math.max(0, Math.min(1, Number(v) || 0))
    },
    end() {
      if (!active) return
      active = false
      coin.hide()
      root.classList.add('is-hidden')
      app.classList.remove(appClass)
    },
    dispose() {
      removeEventListener('pointermove', onPointer)
      coin.dispose()
      root.remove()
    },
    get active() {
      return active
    },
    /* slot k this frame, nominal px, or null while it is still in its place.
       One object, reused: 5000 discs a frame do not allocate. */
    dropOf(k) {
      if (!active) return null
      const dt = fallFor(k, Math.max(0, lastT - t0))
      if (dt <= 0) return null
      return fallInto(k, dt, drop)
    },
    /* its beats, s from play(): your coin's flip over, and the others starting to fall —
       a host can hold between the two (the slit page's Continue) */
    get flipEndS() {
      return flipS()
    },
    get fallAtS() {
      return fallAtS()
    },
    /* …and the last of the others off the page */
    get othersOffS() {
      return othersOffS()
    },
    /* the end of the outro, in seconds from play(), for a host's slider:
       the last of the others off the page — or, with yours falling too, yours */
    get endS() {
      const others = othersOffS()
      return mineAfter != null && FALL.fall ? others + mineAfter + mineOffS() : others
    },
    get fallShare() {
      if (!active || !FALL.fall) return 0
      const e = Math.max(0, lastT - t0) - fallAtS()
      return smooth(clamp01(e / Math.max(0.3, FALL.fallStaggerMs / 1000 + 0.3)))
    },
    debug() {
      const e = active ? Math.max(0, lastT - t0) : 0
      return {
        active,
        t: e,
        stage: !active ? 'off' : e < flipS() ? 'flip' : e < fallAtS() ? 'landed' : 'fall',
        x: pos.x,
        y: pos.y,
        r: pos.r,
        from: { ...from },
        faceOn: Math.abs(vFace.set(0, 0, 1).applyQuaternion(qFlip).z), // 1 = the face square to you (the flip, not the hand's lean)
        headline: head.textContent,
        headOpacity: Number(head.style.opacity || 0),
        falling,
        fallen,
        discs: has ? has.reduce((s, v) => s + v, 0) : 0,
        // yours, when the host has it fall too: when it goes (s from play()), and when the others had all gone
        mine: mineAfter == null || !has ? null : { othersOff: othersOffS(), at: mineAtS(), off: mineAtS() + mineOffS(), falling: e > mineAtS() },
      }
    },
  }
}
