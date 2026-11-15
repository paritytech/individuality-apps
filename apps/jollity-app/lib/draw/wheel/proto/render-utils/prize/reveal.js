// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE PRIZE REVEAL — a coin comes off a point on the page, jumps up into the
   middle turning about its upright axis, and lands face-on with the prize
   on it; a headline and a chip come up around it, and confetti goes up as it
   lands.

   The coin is the coin lab's default coin (render-utils/coin/look/'s
   BASE_LOOK, played through coin/lucky.js on the host's GL stage) — the
   same solid, raised letters, studio and key light; its look is tuned in
   render-utils/coin/look/. Where it starts is the host's (`from`:
   a stage point, a radius and a tint — on the wheel, your own disc, so the
   coin IS the disc at the first frame: it starts flat in the tint, and is
   metal by two thirds of the jump). Everything it SAYS is the host's too:
   the headline, the chip and the words on the coin's face are passed in, so
   nothing here knows what was won or why.

   The confetti is paper, or the host's own discs (`others`): the ones round
   the disc the coin came off, which come away with it, circle it on the way
   up and burst off it. While they are off, `taken` says how many of them
   (the first that many of `others`), so the host does not draw them twice.

   Every frame is a closed form of the time since play(): the jump, the turn,
   the type and the confetti all read (t − t0), so a slow frame never changes
   where anything is — only how often it is drawn.

   ONE SIDE EFFECT, the coin's own: while it is up, it owns the stage's light
   (lucky.js: the studio, the key, the tone mapping, the multisampling) and
   hands it back when it hides. And #app carries .is-prize for as long as the
   reveal does, which is how a host lifts its GL layer over its own. */

import * as THREE from 'three'
import { PRIZE } from './config.js'
import { layout } from '../layout.js'
import { createLuckyCoin } from '../coin/lucky.js'
import { BASE_LOOK } from '../coin/look/look.js'
import { createConfetti } from './confetti.js'
import { REDUCED } from '../device.js'
import { parseColor } from '../color.js'

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const smooth = (x) => x * x * (3 - 2 * x)
const easeOut = (u) => 1 - (1 - u) ** 3

/* the coin's own finish, for silver confetti — face.js's lathe sheen */
const SILVER = ['#f4f4f2', '#dcdcd9', '#b3b2ae', '#9d9c98', '#ffffff', '#c9c8c4']
/* one colour as confetti: the colour, and a few lighter and darker — flat
   paper in one ink reads as a hole in the page, a spread of shades as paper
   catching the light */
const shadeMemo = new Map()
function shadesOf(hex) {
  const hit = shadeMemo.get(hex)
  if (hit) return hit
  const h = parseColor(hex).rgb
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const mix = (to, k) => '#' + c.map((v) => Math.round(v + (to - v) * k).toString(16).padStart(2, '0')).join('')
  const out = [mix(0, 0.32), mix(0, 0.16), h, h, mix(255, 0.2), mix(255, 0.42)]
  shadeMemo.set(hex, out)
  return out
}

export function createPrizeReveal({ gl, app, look: baseLook = BASE_LOOK, first = null, defer = false }) {
  /* built once, here: the bake, the letters and the first compile are paid
     for before anything plays (lucky.js warms it up), not on the jump's
     first frame. A look of its own, so new words never touch the one it was
     made from — BASE_LOOK, unless the host brings its own — engraved with
     `first`, the [amount, label] play() will show, so its first frame has
     nothing to engrave. `defer`: its maps and studio wait for upload() */
  const look = { ...baseLook, ...(first ? { amount: first[0] ?? '', label: first[1] ?? '' } : {}) }
  const coin = createLuckyCoin({ gl, look, defer })
  const confetti = createConfetti({ app })
  const confettiCanvas = app.querySelector('#confetti')
  /* the words' and the confetti's fade, 0..1, for a host taking the page back
     from the reveal — the coin is not in it: it goes back to its disc
     (returnTo), and its GL layer carries the host's page too */
  let fadeK = 1
  function setOpacity(o) {
    fadeK = clamp01(o)
    const v = fadeK >= 1 ? '' : fadeK.toFixed(3)
    root.style.opacity = v
    if (confettiCanvas) confettiCanvas.style.opacity = v
  }

  const root = document.createElement('div')
  root.id = 'prize'
  root.className = 'is-hidden'
  root.innerHTML = '<div class="prize-head"><div class="prize-kicker"></div><div class="prize-headline"></div></div><div class="prize-chip"><span></span></div>'
  app.appendChild(root)
  const head = root.querySelector('.prize-head')
  const kickerEl = root.querySelector('.prize-kicker')
  const headlineEl = root.querySelector('.prize-headline')
  const chip = root.querySelector('.prize-chip')
  const chipText = chip.querySelector('span')

  let active = false
  let t0 = 0
  let lastT = 0
  let from = { x: 195, y: 600, r: 6 }
  let tint = '#ffffff'
  let colours = ['#fff']
  let others = []
  let texts = []
  let burst = false
  let restart = false // the clock starts again on the frame after the first one is drawn
  const pos = { x: 0, y: 0, r: 0 }
  const q = new THREE.Quaternion()
  const qBack = new THREE.Quaternion()
  const qPose = new THREE.Quaternion()
  const eSway = new THREE.Euler(0, 0, 0, 'XYZ')
  let swayNow = 0
  const X_AXIS = new THREE.Vector3(1, 0, 0)
  let back = null // going back to the host's disc (returnTo)

  /* THE HAND ON THE COIN, once it is home: drag it sideways and it turns
     about its upright — the stage's width is half a turn, as in the coin lab
     — and let go it settles on the nearer face, or the one it was flicked
     toward (a critically damped spring, closed form, on real time). So the
     back — the lab coin's own — is yours to turn over and see. */
  const hit = document.createElement('div')
  hit.className = 'prize-coin-hit'
  hit.setAttribute('aria-label', 'Your prize — drag it sideways to turn it over')
  app.appendChild(hit)
  const SETTLE_W = 7 // the spring's rate, 1/s: settled in ~0.7 s
  const turn = { ay: 0, dragging: false, pid: -1, grabX: 0, grabAy: 0, samples: [], rel: { t0: -1, ay: 0, v: 0, target: 0 } }
  const nowS = () => performance.now() / 1000
  function turnNow() {
    if (turn.dragging || turn.rel.t0 < 0) return turn.ay
    const t = nowS() - turn.rel.t0
    const d = turn.rel.ay - turn.rel.target
    return turn.rel.target + (d + (turn.rel.v + SETTLE_W * d) * t) * Math.exp(-SETTLE_W * t)
  }
  const turnK = () => Math.PI / Math.max(1, layout.W)
  function resetTurn() {
    turn.ay = 0
    turn.dragging = false
    turn.pid = -1
    turn.rel.t0 = -1
  }
  let grabbable = false
  hit.addEventListener('pointerdown', (ev) => {
    if (!grabbable || turn.pid !== -1) return
    turn.pid = ev.pointerId
    try {
      hit.setPointerCapture?.(ev.pointerId)
    } catch {
      /* a synthetic pointer (the smoke test) has nothing to capture */
    }
    turn.ay = turnNow() // take it where it is, mid-settle or not
    turn.dragging = true
    turn.grabX = ev.clientX
    turn.grabAy = turn.ay
    turn.samples = [{ t: nowS(), x: ev.clientX }]
    coin.recenter() // the phone as it is now is the front: the coin squares up…
    coin.hold(true) // …and does not lean while it is in hand
  })
  hit.addEventListener('pointermove', (ev) => {
    if (ev.pointerId !== turn.pid) return
    turn.ay = turn.grabAy + (ev.clientX - turn.grabX) * turnK()
    turn.samples.push({ t: nowS(), x: ev.clientX })
    while (turn.samples.length > 2 && turn.samples[turn.samples.length - 1].t - turn.samples[0].t > 0.08) turn.samples.shift()
  })
  const letGo = (ev) => {
    if (ev.pointerId !== turn.pid) return
    turn.pid = -1
    turn.dragging = false
    coin.hold(false)
    const a = turn.samples[0]
    const b = turn.samples[turn.samples.length - 1]
    const dt = a && b ? b.t - a.t : 0
    const recent = b && nowS() - b.t < 0.06 // a finger that stopped before letting go threw nothing
    const v = dt > 0.004 && recent ? ((b.x - a.x) / dt) * turnK() : 0
    turn.rel = { t0: nowS(), ay: turn.ay, v, target: Math.round((turn.ay + v / SETTLE_W) / Math.PI) * Math.PI }
  }
  for (const evName of ['pointerup', 'pointercancel', 'lostpointercapture']) hit.addEventListener(evName, letGo)
  let handT = -1 // real time of the last frame, for the hand's turn
  const UP = new THREE.Vector3(0, 1, 0)
  const vFace = new THREE.Vector3()
  const written = new Map() // style writes, only on change

  let hitShown = null
  function showHit(on) {
    if (on === hitShown) return
    hitShown = on
    hit.classList.toggle('is-grabbable', on)
    if (!on && turn.dragging) {
      turn.dragging = false
      turn.pid = -1
      coin.hold(false)
    }
  }
  function put(el, prop, value) {
    const key = `${el === head ? 'h' : el === chip ? 'c' : el === hit ? 'x' : 'r'}:${prop}`
    if (written.get(key) === value) return
    written.set(key, value)
    el.style.setProperty(prop, value)
  }

  /* the chip: a string, or parts — strings and { text, caps } — so a host
     can set a word in small caps without this file knowing what it says */
  function setChip(c) {
    const parts = Array.isArray(c) ? c : [c]
    chipText.replaceChildren(
      ...parts.map((p) => {
        if (typeof p === 'string') return document.createTextNode(p)
        const el = document.createElement('span')
        if (p.caps) el.className = 'prize-caps'
        el.textContent = p.text ?? ''
        return el
      }),
    )
    chip.hidden = !chipText.textContent
  }

  /* the confetti's colours, now: the host's, or one of the monochromes */
  function confettiColours() {
    switch (PRIZE.confettiColours) {
      case 'one colour':
        return shadesOf(PRIZE.confettiColour)
      case 'the tint':
        return shadesOf(tint)
      case 'silver':
        return SILVER
      default:
        return colours
    }
  }

  /* where the coin is e seconds into the reveal, nominal stage px — every
     frame's, and the discs' ring's, which reads it at other moments too */
  function coinAt(e, out = {}) {
    const cx = layout.cx / layout.scale
    const jumpS = Math.max(0.05, PRIZE.jumpMs / 1000)
    /* the jump: out along the straight line from the disc to the rest point,
       lifted by an arc, slowing into the rest — then a slow float */
    const u = clamp01(e / jumpS)
    const eu = easeOut(u)
    const settle = smooth(clamp01((e - jumpS) / 0.5))
    const bob = PRIZE.bobPx * Math.sin(((e - jumpS) * Math.PI * 2) / Math.max(0.2, PRIZE.bobMs / 1000)) * settle
    out.x = from.x + (cx - from.x) * eu
    out.y = from.y + (PRIZE.restY - from.y) * eu - PRIZE.arcPx * Math.sin(Math.PI * eu) + bob
    out.r = from.r + (PRIZE.coinR - from.r) * (1 - (1 - u) ** 4)
    out.u = u
    return out
  }
  const centreAt = (e) => coinAt(e)

  /* start (or start again) from `at`:
       from      { x, y, r } nominal stage px — the coin's first frame
       tint      the colour it starts as, sliding to the metal as it goes
       lines     the coin's face: [the big line, the word under it]
                 (strings, or { text }) — the look is the coin lab's
       headline, kicker   the words over it, all the host's
       chip      the chip under it: a string, or parts, strings and
                 { text, caps } — a caps part is set in small caps
       colours   the confetti's, when it is in the host's colours
       others    the host's discs round `from`, { x, y, r, colour, keep?, at? }, nominal
                 stage px, nearest first — the confetti, when it is discs (`at`:
                 when the host hands that one over, s from the start) */
  /* `free`: the first frame is free (update(), below) — or false, for a host
     that runs one clock of its own over the whole reveal and pauses it
     across that frame itself, so a slider over it stays true (the fall's
     own option, render-utils/fall/) */
  function play({ t, from: f, tint: tn = '#ffffff', lines = [], headline = '', kicker = '', chip: c = '', colours: cs, others: os = [], family: fm, free = true } = {}) {
    from = { ...f }
    tint = tn
    colours = cs?.length ? cs : ['#ffffff']
    others = os
    texts = lines.map((l) => (typeof l === 'string' ? l : l.text))
    // the face: re-engraved only if the words moved
    coin.words({ amount: texts[0] ?? '', label: texts[1] ?? '' })
    kickerEl.textContent = kicker
    headlineEl.textContent = headline
    setChip(c)
    kickerEl.hidden = !kicker
    t0 = t
    restart = free
    burst = false
    back = null
    resetTurn()
    coin.recenter() // the win lands face-on: the phone as it is now is the front
    confetti.clear()
    active = true
    root.classList.remove('is-hidden')
    app.classList.add('is-prize')
    update(t)
  }

  function update(t) {
    lastT = t
    /* the hand's turn runs on real time, whatever the host's clock does — a
       host holding its last frame still has a coin that leans with you */
    const nowR = performance.now() / 1000
    const dt = handT < 0 ? 0 : Math.max(0, Math.min(0.1, nowR - handT))
    handT = nowR
    if (!active) return
    /* THE FIRST FRAME IS FREE. It is the one that compiles the coin's
       material and uploads its face, which on a slow GPU (or software GL)
       can hold the page for a second or more — and a clock started at play()
       would come out of that stall with the jump already half over. So the
       coin sits at its start for that one frame, and the clock starts from
       the next: nothing is skipped, only begun a frame late. */
    if (restart && t > t0) {
      restart = false
      t0 = t
    }
    const e = Math.max(0, t - t0)
    coinAt(e, pos)
    const u = pos.u

    /* the turn about its upright axis: whole turns, slowing onto the face */
    const v = clamp01(e / Math.max(0.05, PRIZE.spinMs / 1000))
    const homeS = Math.max(PRIZE.jumpMs, PRIZE.spinMs) / 1000
    const yaw = PRIZE.spinTurns * Math.PI * 2 * easeOut(v) + turnNow()
    qPose.setFromAxisAngle(UP, yaw) // the pose it settles to: what faceOn measures
    /* IDLE SWAY, as the coin lab's (its look's `idle`): home and left alone, it
       rocks a little on two slow sines — eased in from the moment it is home,
       so nothing jumps; still while it is in hand; never under reduced motion */
    const swayK = look.idle && !REDUCED && !turn.dragging && !back ? smooth(clamp01((e - homeS) / 0.8)) : 0
    swayNow = swayK
    if (swayK > 0) {
      eSway.set(0.05 * Math.sin(nowR * 0.61) * swayK, yaw + 0.08 * Math.sin(nowR * 0.37 + 1) * swayK, 0, 'XYZ')
      q.setFromEuler(eSway)
    } else q.copy(qPose)
    /* home and turned onto its face: the hand may have it */
    grabbable = !back && e >= homeS
    showHit(grabbable)
    if (grabbable) {
      const s = layout.scale
      put(hit, 'left', `${((pos.x - pos.r) * s).toFixed(1)}px`)
      put(hit, 'top', `${((pos.y - pos.r) * s).toFixed(1)}px`)
      put(hit, 'width', `${(2 * pos.r * s).toFixed(1)}px`)
      put(hit, 'height', `${(2 * pos.r * s).toFixed(1)}px`)
    }

    coin.step(dt) // the lab's light, turned by your hand
    // it starts as the disc it came off — flat, exactly its colour — and is the lab's metal by two thirds of the way
    let flat = 1 - smooth(clamp01(u / 0.66))
    /* GOING BACK (returnTo): flicked up off where it is, end over end, and
       down onto the host's disc, shrinking to it and going flat into its
       colour on the way down — on real time, from the moment it was asked */
    if (back) {
      const w = clamp01((nowR - back.t0) / back.s)
      const ew = smooth(w)
      pos.x = back.from.x + (back.to.x - back.from.x) * ew
      pos.y = back.from.y + (back.to.y - back.from.y) * ew - back.hop * Math.sin(Math.PI * w)
      pos.r = back.from.r + (back.to.r - back.from.r) * ew
      q.copy(back.q0).premultiply(qBack.setFromAxisAngle(X_AXIS, back.halves * Math.PI * ew))
      flat = Math.max(flat, smooth(clamp01((w - 0.35) / 0.55)))
      back.u = w
    }
    coin.place(pos.x, pos.y, pos.r, q)
    coin.look(1, tint, 0, flat)

    /* the confetti. Paper goes up from wherever the coin is at its moment;
       discs are off the host from the first frame. A kind switched mid-way
       drops the other and takes over from here. */
    if (PRIZE.confettiKind === 'discs') {
      if (burst) {
        confetti.dropPaper()
        burst = false
      }
      if (!confetti.gathered) confetti.gather(others, from)
    } else {
      if (confetti.gathered) confetti.dropDiscs()
      // a host's slider run back past the burst takes the paper back with it
      if (burst && e < PRIZE.confettiAtMs / 1000) {
        confetti.dropPaper()
        burst = false
      }
      if (!burst && e >= PRIZE.confettiAtMs / 1000) {
        burst = true
        confetti.burst(pos.x, pos.y, t)
      }
    }
    confetti.draw(t, { colours: confettiColours(), centreAt, since: t0 })

    /* the type: each line up over textFadeMs from its own moment, rising */
    const fade = Math.max(0.01, PRIZE.textFadeMs / 1000)
    const a = smooth(clamp01((e - PRIZE.headlineAtMs / 1000) / fade))
    const b = smooth(clamp01((e - PRIZE.chipAtMs / 1000) / fade))
    put(root, '--prize-head-y', `${PRIZE.headlineY}px`)
    put(root, '--prize-chip-y', `${Math.round(PRIZE.restY + PRIZE.coinR + PRIZE.chipGapPx)}px`)
    put(head, 'opacity', a.toFixed(2))
    put(head, '--rise', `${((1 - a) * PRIZE.textRisePx).toFixed(1)}px`)
    put(chip, 'opacity', b.toFixed(2))
    put(chip, '--rise', `${((1 - b) * PRIZE.textRisePx).toFixed(1)}px`)
  }

  function end() {
    setOpacity(1) // the next play starts whole
    back = null
    resetTurn()
    showHit(false)
    if (!active) return
    active = false
    coin.hide()
    confetti.clear()
    root.classList.add('is-hidden')
    app.classList.remove('is-prize')
  }

  return {
    play,
    update,
    end,
    setOpacity,
    /* the coin back to a disc of the host's: { to: { x, y, r } nominal px,
       ms, hopPx, flips } — up off where it is by hopPx, `flips` half-turns
       end over end (whole ones land it face-on), and down onto `to`, flat in
       the tint by the end. `returned` says it is there */
    returnTo({ to, ms = 900, hopPx = 160, flips = 2 } = {}) {
      if (!active) return
      back = { t0: performance.now() / 1000, s: Math.max(0.05, ms / 1000), from: { x: pos.x, y: pos.y, r: pos.r }, to: { ...to }, hop: hopPx, halves: Math.round(flips), q0: q.clone(), u: 0 }
    },
    get returned() {
      return !!back && back.u >= 1
    },
    get opacity() {
      return fadeK
    },
    get active() {
      return active
    },
    /* the coin itself, hung off the camera at layout.D. A host whose world
       comes nearer the camera than that can scale it toward the eye after
       update() — the same picture, only nearer, so nothing covers it */
    get mesh() {
      return coin.mesh
    },
    /* when it is all over, in seconds from play(): the coin home and turned,
       the type up, and the last of the confetti gone — the end of the reveal,
       for a host's slider. Past it the coin only floats. */
    get endS() {
      const ms = [PRIZE.jumpMs, PRIZE.spinMs, PRIZE.chipAtMs + PRIZE.textFadeMs, PRIZE.headlineAtMs + PRIZE.textFadeMs]
      if (PRIZE.confetti) ms.push((PRIZE.confettiKind === 'discs' ? PRIZE.discBurstAtMs : PRIZE.confettiAtMs) + PRIZE.confettiMs)
      return Math.max(...ms) / 1000
    },
    /* how many of `others` are off the host right now — it leaves those out */
    get taken() {
      return active ? confetti.taken : 0
    },
    /* what this frame did, for the smoke test */
    debug() {
      return {
        active,
        t: active ? lastT - t0 : 0,
        x: pos.x,
        y: pos.y,
        r: pos.r,
        from: { ...from },
        faceOn: Math.abs(vFace.set(0, 0, 1).applyQuaternion(qPose).z), // 1 = the face square to you (the pose it settles to: not the hand's lean, nor the idle sway)
        confetti: { pieces: confetti.count, live: confetti.live, kind: PRIZE.confettiKind, taken: active ? confetti.taken : 0, kept: active ? confetti.kept : [], colours: confettiColours(), ring: confetti.ring },
        face: coin.text, // the words on the coin
        turn: turnNow(), // the hand's turn about the upright, rad (π: the back toward you)
        lean: coin.lean, // the coin's own lean with your hand, deg (0: square to you)
        sway: swayNow, // how much of the idle sway is on, 0..1
        grabbable,
        faces: coin.redraws, // how many times the face has been engraved: new words re-engrave it
        flat: coin.flat,
        headline: headlineEl.textContent,
        chip: chipText.textContent,
        headOpacity: Number(head.style.opacity || 0),
        chipOpacity: Number(chip.style.opacity || 0),
      }
    },
    /* the coin's GPU half, deferred (lucky.js): one step a call, true once held */
    upload: () => coin.upload(),
    dispose() {
      end()
      coin.dispose()
      confetti.dispose()
      root.remove()
      hit.remove()
    },
  }
}
