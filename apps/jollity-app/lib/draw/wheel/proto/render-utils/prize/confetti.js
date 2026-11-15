// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* CONFETTI — a burst thrown up from a point, falling under gravity through
   air. Its own 2D canvas over the stage; nothing here is stepped. Every
   piece is a closed form of the time since the burst (linear drag has one),
   seeded, so the same burst plays the same way at 6 fps and at 60, and a
   frame can be drawn for any t.

     vy(t) = g/k + (vy0 − g/k)·e^(−kt)   (y down, g down, k the drag)
     y(t)  = y0 + (g/k)·t + (vy0 − g/k)·(1 − e^(−kt))/k
     x(t)  = x0 + vx0·(1 − e^(−kt))/k   + a flutter across it

   Two kinds. PAPER: small cards turning end over end — the height is the
   cosine of the card's own flip, which is what makes a flat rectangle read
   as paper. DISCS: the host's own discs, round the one the coin came off.
   They come away from where they are, onto a ring round the coin, and
   circle it as it goes up; at discBurstAtMs they fly off it — carrying the
   some of the speed they had on the ring, plus discBurstPx outward — and fall as the paper
   does, tumbling as they go. The ring is a closed form of the coin's own
   path (the host's `centreAt`), so that half is exact at any t too.

   THE SQUEEZE. Before the burst the ring pulls in on the coin — its gap
   from the coin's edge down to discSqueezeScale of itself (so 0 is tight on
   the rim, and it never covers the face) over discSqueezeMs, eased, then held
   for discSqueezeHoldMs, then the burst — and it goes round faster as it
   tightens, up to discSqueezeSpin times. The speed-up is a smoothstep k(t),
   so the extra angle is its integral, which has a closed form too:
     ∫₀ᵘ (3x² − 2x³) dx = u³ − u⁴/2

   The colours are read every frame, not baked into the pieces: each piece
   keeps a draw of 0..1 and picks from whatever the list is now, so a colour
   dial moves the confetti where it is. */

import { lcg } from '../rng.js'
import { PRIZE } from './config.js'
import { layout } from '../layout.js'

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const smooth = (x) => x * x * (3 - 2 * x)
/* how much of the speed a disc had going round it keeps as it flies off: all
   of it throws the lot sideways off a narrow page in a fraction of a second */
const CARRY = 0.3
/* …and they are thrown up as well as out, as the paper is — a burst straight
   out from the middle sends half of it down, and it is off the page in a
   second. A share of discBurstPx. */
const LIFT = 0.6
const pickOf = (colours, u) => colours[Math.min(colours.length - 1, Math.floor(u * colours.length))]

export function createConfetti({ app, id = 'confetti' }) {
  const canvas = document.createElement('canvas')
  canvas.id = id
  canvas.setAttribute('aria-hidden', 'true')
  app.appendChild(canvas)
  const g = canvas.getContext('2d')

  let pieces = []
  let t0 = -1
  let discs = []
  let gathered = false
  let drawn = false
  let live = 0
  let ring = { r: 0, on: 0, squeeze: 0 } // the discs' ring as of the last draw, for the suite

  function fit() {
    const w = Math.round(layout.W * layout.dpr)
    const h = Math.round(layout.H * layout.dpr)
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
  }

  /* a burst from (x, y), nominal stage px, at time t. The pieces are made
     here, once; the dials that shape the throw are read now and the ones
     that shape the fall (gravity, drag, life) every frame. */
  function burst(x, y, t, seed = 11) {
    const rnd = lcg(seed)
    const n = PRIZE.confetti ? PRIZE.confettiCount : 0
    const spread = (PRIZE.confettiSpreadDeg * Math.PI) / 180
    pieces = Array.from({ length: n }, () => {
      const a = -Math.PI / 2 + (rnd() * 2 - 1) * spread
      const v = PRIZE.confettiSpeedPx * (0.35 + 0.65 * rnd())
      const size = PRIZE.confettiSizePx * (0.6 + 0.8 * rnd())
      return {
        x0: x + (rnd() - 0.5) * 20,
        y0: y + (rnd() - 0.5) * 12,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        w: size,
        h: size * (0.45 + 0.3 * rnd()),
        pick: rnd(), //                     which colour, of whatever the list is
        spin: (rnd() * 2 - 1) * 9, //       rad/s, the card turning in the plane
        flip: 5 + rnd() * 9, //             rad/s, end over end
        phase: rnd() * Math.PI * 2,
        sway: 10 + rnd() * 22, //           px, the flutter across the fall
        swayW: 2 + rnd() * 3, //            rad/s
        life: 0.7 + 0.3 * rnd(), //         a share of confettiMs
      }
    })
    t0 = t
  }

  /* the discs: the host's, as they are drawn — { x, y, r, colour, keep, at },
     nominal stage px, nearest the coin first. `keep`: it stays its own colour
     as confetti rather than taking the confetti's (a disc the host marks out).
     `keepSize`: it stays its own size, rather than growing to confettiSizePx. `from` is the coin's start, which each
     disc's place on the ring is measured round. Their clock is the host's,
     passed to draw() as `since`. `at` (optional, s on that clock): a disc the
     host hands over later — not drawn before it, and coming away from (x, y)
     then; without it each comes away a little late, at random, as ever */
  function gather(list, from, seed = 23) {
    const rnd = lcg(seed)
    discs = list.map((d) => ({
      x0: d.x,
      y0: d.y,
      r0: d.r,
      colour: d.colour ?? '#ffffff',
      keep: !!d.keep,
      keepSize: !!d.keepSize,
      a0: Math.atan2(d.y - from.y, d.x - from.x), // where it is round the coin now, so it swings out onto the ring rather than across it
      band: rnd(), //           how deep in the ring
      w: 0.75 + 0.5 * rnd(), // its own speed round, a share of discTurnsPerS
      lag: rnd(), //            how late it comes away, a share of half the gather
      at: Number.isFinite(d.at) ? d.at : null, // …or exactly when, the host's
      kick: 0.35 + 0.65 * rnd(),
      grow: 0.6 + 0.8 * rnd(),
      pick: rnd(),
      flip: 4 + rnd() * 8,
      phase: rnd() * Math.PI * 2,
      sway: 8 + rnd() * 18, //  px, the flutter across the fall, once it is off the ring
      swayW: 2 + rnd() * 3,
      life: 0.7 + 0.3 * rnd(),
    }))
    gathered = true
  }

  function clear() {
    pieces = []
    discs = []
    t0 = -1
    gathered = false
    live = 0
    // nothing left to fly: the whole stage's pixels go (fit() sizes it again at the next burst)
    canvas.width = canvas.height = 0
    drawn = false
  }

  /* the fall: a piece at (x0, y0) moving (vx, vy), dt seconds on */
  function fall(x0, y0, vx, vy, dt) {
    const k = Math.max(0.01, PRIZE.drag)
    const grav = PRIZE.gravityPx
    const decay = (1 - Math.exp(-k * dt)) / k
    return [x0 + vx * decay, y0 + (grav / k) * dt + (vy - grav / k) * decay]
  }

  /* the squeeze at e seconds: k, how far pulled in (0..1), and spun, the
     time-integral of k — the extra turning it has done, in seconds' worth */
  function squeezeAt(e) {
    if (!PRIZE.discSqueeze) return { k: 0, spun: 0 }
    const s1 = Math.max(0, (PRIZE.discBurstAtMs - PRIZE.discSqueezeHoldMs) / 1000) // pulled all the way in by here
    const s0 = Math.max(0, s1 - PRIZE.discSqueezeMs / 1000) //                       …starting here
    const d = s1 - s0
    if (e <= s0) return { k: 0, spun: 0 }
    if (d <= 1e-6 || e >= s1) return { k: 1, spun: d / 2 + (e - s1) }
    const u = (e - s0) / d
    return { k: smooth(u), spun: d * (u ** 3 - u ** 4 / 2) }
  }

  /* a disc on the ring, e seconds after it came away (before any burst) */
  function onRing(p, e, centreAt) {
    const c = centreAt(e)
    const gatherS = Math.max(0.05, PRIZE.discGatherMs / 1000)
    const u = smooth(clamp01((e - (p.at ?? p.lag * gatherS * 0.5)) / gatherS))
    const sq = squeezeAt(e)
    // the squeeze takes in the gap between the ring and the coin's edge, never the coin: 0 is tight on its rim
    const R = c.r + (PRIZE.discRingPx + PRIZE.discRingDepthPx * p.band) * Math.max(0, 1 + (PRIZE.discSqueezeScale - 1) * sq.k)
    const a = p.a0 + Math.PI * 2 * PRIZE.discTurnsPerS * p.w * (e + (Math.max(0, PRIZE.discSqueezeSpin) - 1) * sq.spun)
    const x = p.x0 + (c.x + R * Math.cos(a) - p.x0) * u
    const y = p.y0 + (c.y + R * Math.sin(a) - p.y0) * u
    return { x, y, u, c }
  }

  function drawPaper(dt, colours, H) {
    const lifeS = Math.max(0.1, PRIZE.confettiMs / 1000)
    for (const p of pieces) {
      const life = lifeS * p.life
      if (dt >= life) continue
      let [x, y] = fall(p.x0, p.y0, p.vx, p.vy, dt)
      x += p.sway * Math.sin(p.swayW * dt + p.phase) * Math.min(1, dt * 2)
      if (y > H + 20) continue
      live++
      const u = dt / life
      g.globalAlpha = u < 0.75 ? 1 : 1 - (u - 0.75) / 0.25
      g.fillStyle = pickOf(colours, p.pick)
      g.save()
      g.translate(x, y)
      g.rotate(p.phase + p.spin * dt)
      g.scale(1, Math.cos(p.phase + p.flip * dt))
      g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h)
      g.restore()
    }
  }

  function drawDiscs(e, colours, centreAt, H) {
    const lifeS = Math.max(0.1, PRIZE.confettiMs / 1000)
    const burstS = Math.max(0, PRIZE.discBurstAtMs / 1000)
    const n = PRIZE.confetti ? Math.min(discs.length, PRIZE.confettiCount) : 0
    const H1 = 1 / 240 // for the speed off the ring: a closed form, differenced
    let ringSum = 0 // how far out the ring is, for the suite: the mean of those still on it
    let onIt = 0
    for (let i = 0; i < n; i++) {
      const p = discs[i]
      let x
      let y
      let u
      let squash = 1
      let alpha = 1
      if (p.at != null && e < p.at) continue // still the host's
      if (e < burstS) {
        let c
        ;({ x, y, u, c } = onRing(p, e, centreAt))
        if (u >= 1) {
          ringSum += Math.hypot(x - c.x, y - c.y)
          onIt++
        }
      } else {
        const dt = e - burstS
        const life = lifeS * p.life
        if (dt >= life) continue
        const b = onRing(p, burstS, centreAt)
        const was = onRing(p, Math.max(0, burstS - H1), centreAt)
        // off the ring with some of the speed it had there, and thrown out from the coin's middle
        const ox = b.x - b.c.x
        const oy = b.y - b.c.y
        const d = Math.hypot(ox, oy) || 1
        const kick = PRIZE.discBurstPx * p.kick
        const vx = (CARRY * (b.x - was.x)) / H1 + (ox / d) * kick
        const vy = (CARRY * (b.y - was.y)) / H1 + (oy / d) * kick - LIFT * PRIZE.discBurstPx
        ;[x, y] = fall(b.x, b.y, vx, vy, dt)
        x += p.sway * Math.sin(p.swayW * dt + p.phase) * Math.min(1, dt * 2)
        u = b.u
        squash = Math.cos(p.phase + p.flip * dt) // tumbling, the way a coin does
        const f = dt / life
        alpha = f < 0.75 ? 1 : 1 - (f - 0.75) / 0.25
      }
      if (y > H + 30) continue
      live++
      // its own size and colour on the wheel, growing into confetti as it comes away
      const r = p.keepSize ? p.r0 : p.r0 + ((PRIZE.confettiSizePx / 2) * p.grow - p.r0) * u
      g.save()
      g.translate(x, y)
      g.scale(1, Math.abs(squash) < 0.08 ? 0.08 : squash)
      g.beginPath()
      g.arc(0, 0, Math.max(0.5, r), 0, Math.PI * 2)
      g.globalAlpha = alpha
      g.fillStyle = p.colour
      g.fill()
      if (u > 0 && !p.keep) {
        g.globalAlpha = alpha * u
        g.fillStyle = pickOf(colours, p.pick)
        g.fill()
      }
      g.restore()
    }
    ring = { r: onIt ? ringSum / onIt : 0, on: onIt, squeeze: squeezeAt(e).k }
  }

  /* one frame at t. `colours` is the list to pick from now; `centreAt(e)` is
     where the coin is e seconds after `since`, when the discs came away. */
  function draw(t, { colours = ['#ffffff'], centreAt, since = t } = {}) {
    const paper = t0 >= 0 && pieces.length
    const round = gathered && discs.length && centreAt
    if (!paper && !round) {
      if (drawn) clear()
      return
    }
    fit()
    const s = layout.scale * layout.dpr
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, canvas.width, canvas.height)
    g.setTransform(s, 0, 0, s, 0, 0)
    const H = layout.H / layout.scale
    live = 0
    if (paper) drawPaper(Math.max(0, t - t0), colours, H)
    if (round) drawDiscs(Math.max(0, t - since), colours, centreAt, H)
    g.globalAlpha = 1
    drawn = true
  }

  return {
    burst,
    gather,
    draw,
    clear,
    /* stop throwing paper, keep any discs (or the other way round): a kind
       switched mid-reveal */
    dropPaper() {
      pieces = []
      t0 = -1
    },
    dropDiscs() {
      discs = []
      gathered = false
    },
    get gathered() {
      return gathered
    },
    get count() {
      return pieces.length + (PRIZE.confetti ? Math.min(discs.length, PRIZE.confettiCount) : 0)
    },
    /* how many of the host's discs are off the host, as of now */
    get taken() {
      return gathered && PRIZE.confetti ? Math.min(discs.length, PRIZE.confettiCount) : 0
    },
    /* …and of those, the colours of the ones that keep their own (`keep`) */
    get kept() {
      return gathered && PRIZE.confetti ? discs.slice(0, Math.min(discs.length, PRIZE.confettiCount)).filter((p) => p.keep).map((p) => p.colour) : []
    },
    /* pieces still in the air and on screen, as of the last draw */
    get ring() {
      return ring
    },
    get live() {
      return live
    },
    dispose() {
      canvas.remove()
    },
  }
}
