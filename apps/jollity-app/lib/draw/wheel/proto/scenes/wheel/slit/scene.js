// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE DRAW, THROUGH THE SLIT — the full flow again:

     the coin   the solid coin, nothing on it, dragged down into a lit slit
                (render-utils/coin/'s intro — the slit's light shines further
                out as it comes in)
     the slit   bends: one curve, its ends rising into a bowl and meeting at
                the top as a circle (bowl.js)
     the coin   never stops: it comes back flat and coloured, speeds round the
                circle trailing, and spirals in onto its ticket on a wheel
                that is already turning, at the ticket's own speed (orbit.js)
     the hub    the circle's light goes soft and settles as the hub's glow as
                the coin spirals in; the wedge's edge lights up from
                the hub; WINNER
     the draw   the wheel starts before the coin is down; the tickets come on
                round it. It lands, zoomed onto the WHOLE wedge
                (zoom.js), an arrow on the edge to your ticket if it is off
                the stage
     who        who's playing comes on along the top, and the winners are lit
                one by one, left to right, then you (walk.js, names.js) —
                then, with the toggle on, the prize if it is yours (and a
                Continue), or Not this time and a Continue that starts the
                fall (wheel/ending.js); until then the wheel takes taps

   The beats overlap (sequence.js): the whole is one movement, not a list.

   A page of the wheel's family, like flow/: the draw (draw.js, rig.js), the
   placement (place.js), the spin's clock (timing.js) and the endings are the
   wheel's, imported as they are. Everything it DRAWS is its own (paint.js),
   flat; the coin is the only solid on it.

   TWO CLOCKS. The sequence: seconds from the hand-over (the coin at the
   swallow's depth), never scrubbed — what has appeared stays. The spin: the
   flow's, a go of timing.js's under the slow-mo, started on its cue, which
   the timeline scrubs. A frame is a closed form of both, so ?at=<s> freezes
   the page at any moment of the story (for review, and for the suite). */

import { measure, layout as stage, DPR_CAP } from '../../../render-utils/layout.js'
import { createGL } from '../../../render-utils/gl.js'
import { COIN } from '../../../render-utils/coin/config.js'
import { PRIZE } from '../../../render-utils/prize/config.js'
import { createCoinIntro } from '../../../render-utils/coin/intro.js'
import { buildRing, ringFromValues, ranksFor } from '../draw.js' // JOLLITY: ringFromValues
import { profileFor, profileOmegaAt, motionAngleAt, warpFor, stretchesFor } from '../timing.js'
import { place, fitFor } from '../place.js'
import { createEnding } from '../ending.js'
import { FLOW } from '../config.js'
import { entropyWalk, wantFor, fresh } from '../rig.js'
import { SLIT, SOLID_LOOK, PRIZE_LOOK, slitActions } from './config.js'
import { bowlAt } from './bowl.js'
import { orbitPath } from './orbit.js'
import { wedgeBox, reachFit, zoomFit, zoomAt } from './zoom.js'
import { cuesFor, ramp, ticketAt, trailS, burstOut } from './sequence.js'
import { FLIP } from './flip-config.js'
import { flipCuesFor } from './flip-sequence.js'
import { createFlipIntro, startPose } from './flip.js'
import { dropPath } from './drop.js'
import { createPainter, mixHex, colourOf } from './paint.js'
import { createLegend } from './legend.js'
import { nameFor, rowFor, rowXFor, nearestTurn, roundFrom6 } from './names.js' // JOLLITY: roundFrom6, the ticker's order
import { walkPlan, walkAt, nameIn, ticketAlpha, stateOf, NOBODY } from './walk.js'
import { TAILS } from './trail-look/look.js'
import './style.css'

const TAU = Math.PI * 2
const clamp01 = (v) => Math.max(0, Math.min(1, v))
const lerp = (a, b, t) => a + (b - a) * t
const smooth = (u) => {
  const x = clamp01(u)
  return x * x * (3 - 2 * x)
}
const signed = (a) => {
  const w = ((a % TAU) + TAU) % TAU
  return w > Math.PI ? w - TAU : w
}
const rgbOf = (hex) => [0, 2, 4].map((i) => parseInt(hex.replace('#', '').slice(i, i + 2), 16))

/* the stage's furniture, nominal px */
const BAR_Y = 780 //      the timeline's line — and Continue's, which grows out of it (style.css has it too)
const NAMES_ROOM = 26 //  the wedge's box never goes higher than this under who's playing's row…
const CONTINUE_H = 48 //  …nor lower than Continue (this tall, on the timeline's line — it grows out of it), with WINNERS' line clear of it
const WINNERS_ROOM = 22
const SIDE = 16 //        …nor nearer the sides than this
const WEDGE = Math.PI / 2 // the wedge sits at twelve o'clock (place.js's angles: ccw from three)
const SHADE = 0.89 //     the slit's dark block, black at this
const TRAIL_N = 40 //     a trail's samples, head to tail
const ARROW_IN = 0.1 //   the arrow comes up over the first tenth of the zoom in
const FELL_NAMES_A = 0.35 // a loss's fall playing: the names step back to this (all but the lit one)
const RING_ROOM = 2 //    the lit one's ring, at the side of the wheel, keeps this far in from the stage's edge
const LINE_FROM_NAME = 15 // the lit one's underline (and its line from there) this far under the names' middle: half the 15 px line, then 8
const TRAILS_UNDER_PX = 4 // tickets bigger across than this: the trails run under them, not over

/* ?outcome= takes a word each — the dial's own are phrases */
const OUTCOME = { random: 'random', win: 'only wins', lose: 'only lost' }
const TAIL_WORD = { gradient: 'gradient', red: 'blue to red', glass: 'hot liquid glass', '70s': '70s rainbow' }
const URLS = { intro: true, at: null, seed: null, entropy: null }

export function slitParams(u) {
  SLIT.n = u.int('n', 2, 5000, SLIT.n)
  SLIT.winners = Math.max(1, Math.min(u.int('winners', 1, 5000, SLIT.winners), SLIT.n - 1))
  const o = u.get('outcome')
  if (o && OUTCOME[o]) SLIT.outcome = OUTCOME[o]
  if (u.has('ending')) SLIT.showWinOrLoss = u.get('ending') !== '0'
  const tail = TAIL_WORD[u.get('tail')] // ?tail=gradient|red|glass|70s — the trail's look
  if (tail) SLIT.tail = tail
  /* ?intro=0 opens with the coin just landed on its ticket (the suite's
     harness appends it to every URL that does not say); ?at=<s> freezes the
     story s seconds after the hand-over, and so has no coin to drag either */
  if (u.has('intro')) URLS.intro = u.get('intro') !== '0'
  if (u.has('at')) {
    const v = parseFloat(u.get('at'))
    if (Number.isFinite(v)) {
      URLS.at = Math.max(0, v)
      URLS.intro = false
    }
  }
  if (u.has('seed')) URLS.seed = u.get('seed')
  if (u.has('entropy')) URLS.entropy = u.get('entropy')
  /* what a slower phone is stepped down to (jollity's draw does it by frame
     time, layout.js DPR_CAP): ?dpr=1.5, ?msaa=0. ?maps=1024 builds the coins'
     maps at the size they were before the draw went to 512 */
  const dpr = parseFloat(u.get('dpr'))
  if (Number.isFinite(dpr)) DPR_CAP.max = Math.max(0.5, Math.min(3, dpr))
  if (u.has('msaa')) DPR_CAP.msaa = u.get('msaa') !== '0'
  if (['512', '1024', '2048'].includes(u.get('maps'))) SOLID_LOOK.mapSize = PRIZE_LOOK.mapSize = u.get('maps')
  /* the coin, for this page — COIN is shared, but a page load runs one scene:
     centred, a little smaller, the slit lower (y 654), the
     light starting from where it floats, and swallowed quickly, just under
     the line — it leaves the slit going, not drifting */
  COIN.coinR = SOLID_LOOK.coinR
  COIN.homeY = 422
  COIN.slotBottomPx = 190
  COIN.glowStartPx = 150
  COIN.handoffAt = 1.25
  COIN.swallowMs = 700
}

/* opening: 'slit' (this page: the coin dragged into the slit) or 'flip'
   (flip-scene.js: the coin flipped off a light page, the wheel built on black,
   the coin back down onto its ticket, and only then the spin).
   look: the trail lab's (lab-config.js LOOK) — its trails drawn by the
   shader painter (trail-look/); the two pages pass none */
/* the face: Inter, for who's playing, WINNERS and the rest —
   loaded by this scene alone, so nothing else pays for it */
function loadFace() {
  if (document.getElementById('slit-face')) return
  const l = document.createElement('link')
  l.id = 'slit-face'
  l.rel = 'stylesheet'
  l.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap'
  document.head.appendChild(l)
}

export function createSlit({ dom, loop }, { opening = 'slit', look: lookOpt = null, chainDraw = null } = {}) { // JOLLITY: chainDraw, a real draw
  const app = dom.app
  const flip = opening === 'flip'
  if (!chainDraw) loadFace() // JOLLITY: jollity's own Inter (stage.css), no fetch from Google
  app.classList.add('scene-slit')
  if (flip) app.classList.add('scene-flip')
  const cuesNow = () => (flip ? flipCuesFor(FLIP, SLIT) : cuesFor(SLIT))
  // the flip page: which way the coin went, so it comes back the same way
  let flipHow = null
  const howNow = () => flipHow ?? (FLIP.by === 'tap' ? 'viewer' : 'top')
  /* the backdrop and the slit's light go UNDER the GL while the coin is up
     (it is screen-blended over them); everything else over it */
  const underEl = document.createElement('canvas')
  underEl.id = 'slit-under'
  app.insertBefore(underEl, dom.canvas)
  const canvas = dom.mount('canvas', 'slit')
  // the edge arrows get a canvas of their own, over the names (the legend is DOM, over #slit) —
  // the arrow's own size, moved to where it points (placeArrows), not the stage's
  const arrowsEl = dom.mount('canvas', 'slit-arrows')
  const gu = underEl.getContext('2d')
  const g = canvas.getContext('2d')
  const ga = arrowsEl.getContext('2d')
  const legend = createLegend(app)
  // JOLLITY: the ticker's order (every ticket, round the wheel as the row goes) and its stops (you, then your friends, clockwise)
  let tickRing = null
  let tickOrder = []
  let tickPos = new Map()
  let tickStopsRing = null
  let tickStopsCount = -1
  let tickStopsHeld = false // the visit has begun: a friend found after it is marked, not visited
  let tickStops = []
  let tickX = null
  const tickOrderNow = () => {
    if (tickRing !== ring) {
      tickRing = ring
      const H = hub()
      const round = new Float64Array(layout.n)
      for (let k = 0; k < layout.n; k++) round[k] = roundFrom6(at(k, restPhi), H)
      tickOrder = Array.from({ length: layout.n }, (_, k) => k).sort((a, b) => round[a] - round[b])
      tickPos = new Map(tickOrder.map((k, i) => [k, i]))
    }
    return tickOrder
  }
  const tickStopsNow = () => {
    const n = tickOrderNow().length
    const fr = friendsNow().map((x) => x.k)
    if (tickStopsRing === ring && (tickStopsHeld || tickStopsCount === fr.length)) return tickStops
    if (tickStopsRing !== ring) tickStopsHeld = false
    tickStopsRing = ring
    tickStopsCount = fr.length
    const start = mine >= 0 ? tickPos.get(mine) : fr.length ? tickPos.get(fr[0]) : 0
    const fwd = (k) => (((tickPos.get(k) - start) % n) + n) % n
    const ks = (mine >= 0 ? [mine] : []).concat(fr.slice().sort((a, b) => fwd(a) - fwd(b)))
    tickStops = ks.map((k) => ({ k, j: start + fwd(k) }))
    return tickStops
  }
  // JOLLITY: your friends' row, before who's playing (frame, below): a plain row, it never wraps
  const friendsLegend = createLegend(app, 'jollity-friends', { wrap: false })
  let friendsX = 0 //         the row's offset as drawn, nominal px
  let friendsPlaced = false // …put in place on its first frame, eased from there
  let friendsNA = new Float32Array(0) // each name's alpha, easing
  let friendsLineFor = -1 //  the ticket the line is down to, and since when
  let friendsLineT0 = 0
  let friendsSeen = false // friendsRow 'all': who's playing has been up for your friends: the walk keeps its names in
  let friendsVisit = -1 //  …the friend it is at this frame, and where it slides to for them
  let friendsVisitTo = 0
  let friendsLineK = -1
  const isFriend = (k) => friendsNow().some((fr) => fr.k === k)
  const painter = createPainter()
  const fov = () => COIN.fov

  let view = { W: 390, H: 844, dpr: 1, scale: 1 }
  const Wn = () => view.W / (view.scale || 1)
  const Hn = () => view.H / (view.scale || 1)
  const hub = () => ({ x: Wn() / 2, y: SLIT.hubY })
  const slitY = () => COIN.slotY

  let gl = null
  /* the flip page's GL is a see-through layer, in front of the page while the
     coin is up, reaching FLIP.escapePx past the screen's edges so the coin can
     leave it (flip.js); the slit page's is the opaque one it always was */
  /* …no further than the window has room round the stage, though: past
     that nothing is seen, and on a phone, where the stage is the screen, it
     would be the whole cost of a bigger canvas for nothing */
  function escapePx() {
    if (!flip || !intro?.active) return 0
    const room = Math.max((innerWidth - view.W) / 2, (innerHeight - view.H) / 2, 0)
    return Math.round(Math.min(FLIP.escapePx * view.scale, room))
  }
  /* no bloom: the coin's looks on these pages have no glow, so there is
     nothing for one to do (gl.js, bloom: null). And on this page the GL is
     a see-through WINDOW the size of the coin, moved with it (gl.js,
     window): the coin is the only solid here, a tenth of the screen, and
     every buffer under it — the multisampled ones most — is the window's
     size, not the screen's. The flip's coin flies over you and fills the
     screen at its own peak, so it keeps the whole stage */
  const coinMostR = () => Math.max(SOLID_LOOK.coinR, PRIZE.coinR)
  const ensureGl = () => (gl ??= createGL(dom.canvas, { fov, bloom: null, alpha: true, ...(flip ? { margin: escapePx } : { window: coinMostR }) }))

  /* ── THE DRAW ───────────────────────────────────────────────────────────
     A ticket list from the seed, and its draw: the entropy walked to the
     outcome the dial asks for (rig.js), decided at once — the spin that shows
     it is a closed form from there, so the whole story is known before the
     coin lands, and the coin can be flown to where its ticket WILL be. */
  let gen = 0
  let seed = URLS.seed ?? fresh()
  let baseEntropy = URLS.entropy ?? fresh()
  let want = wantFor(SLIT.outcome)
  let ring = null
  let ranks = null
  let drawNo = 0
  let layout = null
  let fitted = null
  let rim = SLIT.rimPx
  let wedge = null //  { a0, a1, half, reach } — fixed: the winners and the margin
  let box = null //    the wedge's box, unzoomed
  let zfit = null //   the zoom's end
  let mine = -1
  let ticketD = null // how far round from yours each ticket is, 0..1 (the stagger)
  let landing = null
  let warp = null
  let phi0 = 0 //      the wheel before it spins: your slot at six o'clock
  let restPhi = 0

  const winnersNow = () => Math.max(1, Math.min(SLIT.winners, (ring?.n ?? SLIT.n) - (chainDraw ? 0 : 1))) // JOLLITY: everyone can win a real draw
  const wonSlot = (k) => !!(ranks && layout) && k >= 0 && (k - ranks.cut + layout.n) % layout.n < winnersNow() // JOLLITY: nobody's slot never won
  const ready = () => !!(ring && ranks && layout && landing)

  async function deal() {
    const my = ++gen
    ring = ranks = layout = landing = null
    const built = chainDraw ? ringFromValues(chainDraw.values) : await buildRing({ seed, n: SLIT.n }) // JOLLITY: the chain's tickets
    if (my !== gen) return false
    const r = chainDraw ? { no: 1, target: chainDraw.target } /* JOLLITY: the chain's target, not a rigged walk */ : await entropyWalk({ ring: built, base: baseEntropy, from: 1, want, winners: Math.max(1, Math.min(SLIT.winners, built.n - 1)), alive: () => my === gen })
    if (my !== gen) return false
    ring = built
    drawNo = r.no
    ranks = ranksFor(ring, r.target, winnersNow())
    mine = chainDraw?.spectator ? -1 : ring.idxOf[0] // JOLLITY: a spectator has no ticket
    relayout()
    /* the ending (the prize's coin, or the fall) is a real cost to build:
       paid now, at the deal, not on the spin's first frame, where it was a
       hitch — and only the one this draw has (wheel/ending.js, won) */
    if (SLIT.showWinOrLoss) {
      ensureEnding().warm()
      uploaded = false
    }
    return true
  }

  /* the band the wedge must stay inside: the sides, who's playing's row over
     it, Continue over the timeline under it — WINNERS, at the hub, the wedge's
     tip, stays clear of the pill */
  const band = () => ({ x0: SIDE, x1: Wn() - SIDE, y0: SLIT.namesY + NAMES_ROOM, y1: BAR_Y - CONTINUE_H / 2 - WINNERS_ROOM })

  /* THE WEDGE: exactly the winners' share of the wheel wide — the chain's
     own slice, winners × 2π/n — and out wedgePadPx past the outermost of
     them. The width is not a look: every ticket sits one pitch round from the
     next, so a slice exactly that wide holds exactly `winners` ticket centres
     at every angle the wheel passes through, and so lights exactly that many
     as it spins — the same ones it lands on. Any other width (one hugging the
     winners with a margin was tried) holds one more, or one fewer, as the
     wheel turns, and the extra lights go out at the stop. */
  function wedgeFor(rimPx, rb) {
    const w = winnersNow()
    const n = layout.n
    let hi = 0
    for (let i = 0; i < w; i++) hi = Math.max(hi, layout.rad[(ranks.cut + i) % n])
    const rhoMax = Math.max(1, hi * rimPx)
    const half = Math.min(Math.PI - 1e-3, (w * layout.pitch) / 2)
    return { a0: WEDGE - half, a1: WEDGE + half, half, reach: rhoMax + rb + SLIT.wedgePadPx, rhoMax }
  }
  /* UNDER THE WEDGE, with the wheel at phi: slot k sits at k·pitch − φ
     (place.js), so the slice from WEDGE − half holds the slots k with
     k + f in [0, winners) round the wheel, f = (half − φ − WEDGE)/pitch —
     a run of exactly `winners` from k0. Counted as a run from one number
     rather than by testing each angle against both edges, which at the
     instant a ticket crosses could say 'in' at both ends at once */
  function underFrom(phi) {
    const n = layout.n
    const f = (wedge.half - phi - WEDGE) / layout.pitch
    return ((Math.ceil(-f) % n) + n) % n
  }
  const isUnder = (k, k0) => (k - k0 + layout.n) % layout.n < winnersNow()
  const inside = (b, bd) => b.x0 >= bd.x0 - 1e-6 && b.x1 <= bd.x1 + 1e-6 && b.y0 >= bd.y0 - 1e-6 && b.y1 <= bd.y1 + 1e-6

  function relayout() {
    if (!ring || !ranks) return
    const n = ring.n
    const w = winnersNow()
    const H = hub()
    const bd = band()
    /* the wheel fitted first, unzoomed: the biggest rim (up to its dial) whose
       wedge is wholly on the stage, and whose tickets at the sides keep the
       lit one's ring on it — the layout's rings follow the rim, so a few
       rounds, each shrinking it by what overran */
    let r = SLIT.rimPx
    for (let it = 0; it < 8; it++) {
      fitted = fitFor({ kind: 'rings, spread', n, hole: SLIT.hole, rimPx: r, minPx: 2.5, maxPx: SLIT.ballMaxPx, share: 0.5, perRing: 70, ringGap: 2 })
      const side = Wn() / 2 - (fitted.dot / 2 + (SLIT.select ? SLIT.selectGapPx + SLIT.selectLinePx : 0) + RING_ROOM) // the most a side ticket's centre can be from the hub
      if (r > side + 0.25) {
        r = side
        continue
      }
      layout = place({ kind: 'rings, spread', n, rings: fitted.rings, hole: SLIT.hole, ringPosition: 'from edge', ringStep: (2 * fitted.dot) / r })
      wedge = wedgeFor(r, fitted.dot / 2)
      box = wedgeBox({ hub: H, reach: wedge.reach, a0: wedge.a0, a1: wedge.a1, pad: 3 })
      if (inside(box, bd)) break
      const most = reachFit({ hub: H, band: bd, a0: wedge.a0, a1: wedge.a1, pad: 3 })
      r = Math.max(40, (r * (most - (wedge.reach - wedge.rhoMax))) / wedge.rhoMax - 0.5)
    }
    rim = r
    /* the wedge's radius, if the dial sets one: the wheel was fitted to the
       winners' wedge above; this one is held to the band, so WINNER (over the
       box's top) is on the stage whatever the radius */
    if (SLIT.wedgeRadiusPx > 0) {
      wedge.reach = Math.min(SLIT.wedgeRadiusPx, reachFit({ hub: H, band: bd, a0: wedge.a0, a1: wedge.a1, pad: 3 }))
      box = wedgeBox({ hub: H, reach: wedge.reach, a0: wedge.a0, a1: wedge.a1, pad: 3 })
    }
    zfit = zoomFit({ box, band: bd, maxX: SLIT.zoomX })
    ticketD = new Float32Array(n)
    if (flip) {
      /* flipped: one by one ROUND the circle, from the one next to yours all
         the way round to the one on its other side — yours is the coin's */
      const a = (k) => (((layout.theta[k] - layout.theta[mine]) % TAU) + TAU) % TAU
      const order = Array.from({ length: n }, (_, k) => k).filter((k) => k !== mine).sort((p, q) => a(p) - a(q))
      order.forEach((k, i) => (ticketD[k] = order.length > 1 ? i / (order.length - 1) : 0))
      ticketD[mine] = 1
    } else for (let k = 0; k < n; k++) ticketD[k] = Math.abs(signed(layout.theta[k] - layout.theta[Math.max(0, mine)])) / Math.PI // JOLLITY: a spectator's from slot 0
    ensureArrays(n)
    /* the spin, planned whole: from your slot at six o'clock to the winners
       under the wedge, in the flow's time */
    phi0 = layout.theta[Math.max(0, mine)] + Math.PI / 2 // JOLLITY: a spectator's wheel starts from slot 0
    restPhi = layout.targetAngle({ cut: ranks.cut, winners: w, wedgeAngle: WEDGE })
    landing = profileFor({ from: phi0, targetPhi: restPhi, turnsPerS: SLIT.turnsPerS, ...stretchesFor({ totalS: SLIT.autoSpinS, upS: SLIT.upS, downS: SLIT.spinS }) })
    warp = warpFor({ durS: landing.durS, startS: (SLIT.sloMoAtPct / 100) * landing.durS, factor: SLIT.sloMo ? SLIT.sloMoSpeed : 1, blendS: 0.25 })
    buildRow()
  }
  slitActions.relayout = relayout

  /* every ticket's draw this frame — the painter's batch, in typed arrays */
  const T = { count: 0, x: null, y: null, r: null, alpha: null, sq: null, rot: null, trailsUnder: false }
  function ensureArrays(n) {
    if (T.x && T.x.length >= n) return
    for (const k of ['x', 'y', 'r', 'alpha', 'sq', 'rot']) T[k] = new Float32Array(n)
  }

  /* the sizes: every ticket a flat circle — yours 14 px at 420,
     24 px at 8 — and its ring */
  const markR = () => Math.max(0.5, (SLIT.markMinPx ?? 0) / 2, (fitted?.dot ?? 1) / 2) // yours is a ticket like the rest — only its colour says so (JOLLITY: and on a big wheel, never smaller than markMinPx)
  const ringOf = (r) => Math.max(r * 1.6 + 0.8, 11.5)
  /* yours is the legend's YOU, everywhere — the coin on its way in, your
     ticket, its trail, its ring, the arrow, the fall's coin — whatever size
     the tickets are */
  const youColour = () => SLIT.youColour

  /* ── THE CLOCKS ───────────────────────────────────────────────────────── */
  /* the three anchors are loop times, null until they happen — never a
     negative number for "not yet": early in a page's life a real one is
     negative (To Wheel puts the hand-over seconds before the clock's 0) */
  let seqT0 = null // the hand-over; null while the coin is still up
  const now = () => (URLS.at != null && seqT0 != null ? seqT0 + URLS.at : loop.time)
  const seqS = () => (seqT0 == null ? -Infinity : now() - seqT0)
  let spinT0 = null // the spin's real clock began (the slider moves it)
  let phase = 0 //   0..1 through the spin's own clock
  let running = false
  let scrubbing = false
  let scrubbed = false // the timeline has moved the wheel since the coin landed
  let landedAt = null
  let zoomKeep = 1

  const phiNow = () => (spinT0 == null || !landing ? phi0 : motionAngleAt(landing, phase * landing.durS))
  /* the zoom in: its progress, raw and eased */
  function zoomIn() {
    if (!SLIT.zoom || spinT0 == null || !warp) return { raw: 0, z: 0 }
    const r = phase < 1 ? warp.realAt(phase * landing.durS) : warp.realDurS + Math.max(0, now() - (landedAt ?? now()))
    const at = Math.max(0, warp.realDurS + SLIT.zoomAtS)
    const raw = clamp01((r - at) / Math.max(0.001, SLIT.zoomMs / 1000))
    return { raw, z: smooth(raw) }
  }
  /* the wheel's angle `back` real seconds ago, on the spin's own clock — a
     closed form, so a trail can be the way a ticket really came */
  const spinRealNow = () => (phase < 1 ? warp.realAt(phase * landing.durS) : warp.realDurS)
  function phiBack(back) {
    const r = spinRealNow() - back
    return r <= 0 ? phi0 : motionAngleAt(landing, warp.tau(r))
  }

  /* where your ticket is when the coin lands on it, and how fast it is going
     then — from the spin's plan and the cues alone, so the coin's path can be
     solved before it starts: the wheel started spinStartMs from the landing */
  function seatAt(cues) {
    const turning = cues.seat - cues.spin // seconds the wheel has turned when the coin lands
    let phi = phi0
    let omega = 0
    if (turning > 0) {
      const tau = warp.tau(turning)
      phi = motionAngleAt(landing, tau)
      omega = profileOmegaAt(landing, tau) * warp.rate(turning)
    }
    // the canvas's angle (clockwise, y down) of your slot: −(θ − φ)
    return { phi, omega, psi: phi - layout.theta[mine], rho: layout.rad[mine] * rim, r: markR() }
  }

  /* ── THE COIN'S WAY BACK (orbit.js) ────────────────────────────────────
     From the hand-over the solid coin follows the path for handoffMs, going
     flat and cyan under the slit's dark block; then it is gone and the flat
     coin on the canvas IS it — same place, same size, same colour. */
  let hand = null
  let orbit = null
  let orbitKey = ''
  let seat = null
  const defaultHand = () => ({ x: Wn() / 2, y: slitY() + COIN.handoffAt * COIN.coinR, r: COIN.coinR, vy: 200 })
  function orbitNow(cues = cuesNow()) {
    if (!ready()) return null
    seat = seatAt(cues)
    if (flip) {
      /* the flip's way down: from where it hangs, turning over in front of
         you, onto its ticket (drop.js) — from cues.drop, the path's own clock */
      const start = startPose(howNow(), Wn(), Hn())
      const key = ['flip', start.x, start.y, start.r, seat.rho, seat.r, seat.psi, SLIT.hubY, cues.drop, cues.land].join('|')
      if (key !== orbitKey) {
        orbitKey = key
        const d = dropPath({ start, hub: hub(), seat, landS: cues.land })
        orbit = { ...d, at: (s) => d.at(s - cues.drop) }
      }
      return orbit
    }
    const h = hand ?? defaultHand()
    const key = [h.x, h.y, h.r, h.vy, seat.rho, seat.r, seat.psi, seat.omega, Wn(), SLIT.hubY, SLIT.orbitPx, SLIT.orbitCoinPx, SLIT.coinTurnsPerS, cues.circle, cues.spiral].join('|')
    if (key !== orbitKey) {
      orbitKey = key
      orbit = orbitPath({ hub: hub(), from: h, orbitR: SLIT.orbitPx, orbitSize: SLIT.orbitCoinPx, seat, omegaC: SLIT.coinTurnsPerS * TAU, circleS: cues.circle, spiralS: cues.spiral })
    }
    return orbit
  }

  /* ── THE COIN, AND THE SLIT IT GOES INTO (render-utils/coin/) ─────────── */
  let intro = null
  function ride(t, h) {
    if (!ready()) return { x: h.x, y: h.y, r: h.r } // the ticket list still hashing: it waits at the depth
    if (seqT0 == null) {
      seqT0 = t
      hand = { x: h.x, y: h.y, r: h.r, vy: h.vy }
    }
    const s = t - seqT0
    const p = orbitNow().at(s)
    const handoff = cuesNow().handoff
    const f = smooth(s / Math.max(0.001, handoff))
    if (s < handoff) return { x: p.x, y: p.y, r: p.r, tint: youColour(), tintAmount: f, flat: f }
    return { x: p.x, y: p.y, r: p.r, opacity: 0, tint: youColour(), tintAmount: 1, flat: 1, done: true }
  }
  /* the flip's: it hangs until cues.drop (null), then comes down the drop
     path onto its ticket, going your colour, and is done at the landing —
     the disc drawn from there is it */
  function flipRide(t) {
    if (!ready() || seqT0 == null) return null
    const cues = cuesNow()
    const s = t - seqT0
    if (s < cues.drop) return null
    if (s >= cues.seat) return { done: true }
    const p = orbitNow(cues).at(s)
    return { x: p.x, y: p.y, r: p.r, u: p.u, T: cues.land, tint: youColour() }
  }
  function ensureIntro() {
    if (flip)
      intro ??= createFlipIntro({
        gl: ensureGl(),
        app,
        look: { ...SOLID_LOOK },
        // the coin is up, turning over in front of you: the story's clock starts here
        onUp: (t, how) => {
          flipHow = how
          seqT0 = t
        },
        ride: flipRide,
      })
    intro ??= createCoinIntro({ gl: ensureGl(), app, ride, replayButton: false, look: { ...SOLID_LOOK } })
    return intro
  }
  const endIntro = () => intro?.active && intro.end()
  /* THE COIN IS THROUGH: once the intro is over its coin is let go — its
     maps, letters and studio — and the prize's, built without them while
     this one floated, brings them up in its place (frame()). The two coins
     are never held at once. A replay builds a fresh one. */
  let introLast = null // a finished intro's last word, for the suite
  let uploaded = false // the prize's coin has all it waited with
  const uploads = [] //   …and what each step of it cost, ms
  function releaseIntro() {
    const last = { ...intro.debug?.(), phase: 'done', active: false }
    introLast = { ...last, debug: () => ({ ...last }) }
    intro.dispose()
    intro = null
  }

  let glShown = null
  function showGl(on) {
    if (on === glShown) return
    glShown = on
    dom.canvas.style.visibility = on ? 'visible' : 'hidden'
    if (!on) gl?.sleep() // nothing on it: its buffers go until the next coin (gl.js)
  }
  showGl(false)

  /* ── HOW IT ENDS, with the toggle on (wheel/ending.js) ──────────────────
     What the ending needs is where things are on the page; what it hands
     back each frame is how the page is drawn under it. Built the first time
     the toggle is on: with it off (the default) there is no prize coin. */
  let ending = null
  const at = (k, phi) => {
    const H = hub()
    const a = layout.angleAt(k, phi)
    const d = layout.rad[k] * rim
    return { x: H.x + d * Math.cos(a), y: H.y - d * Math.sin(a) }
  }
  let zm = { s: 1, tx: 0, ty: 0, z: 0 }
  const userView = { s: 1, tx: 0, ty: 0 } // JOLLITY: the player's own zoom, over the stage's (lib/draw/wheel/explore.ts)
  const onScreen = (p) => ({ x: zm.s * p.x + zm.tx, y: zm.s * p.y + zm.ty })
  function youOnScreen() {
    const p = onScreen(at(mine, phiNow()))
    return { x: p.x, y: p.y, r: markR() * zm.s }
  }
  function youAtRest() {
    const p = at(mine, restPhi)
    return { x: p.x, y: p.y, r: markR() }
  }
  function othersDrawn(from) {
    const out = []
    const phi = phiNow()
    const r = (fitted.dot / 2) * zm.s
    for (let k = 0; k < layout.n; k++) {
      if (k === mine) continue
      const p = onScreen(at(k, phi))
      const a = clamp01(tA[k] || (wonSlot(k) ? SLIT.winnerA : SLIT.loserA))
      out.push({ k, x: p.x, y: p.y, r, colour: mixHex(SLIT.bg, SLIT.ticketColour, a), keep: false, keepSize: true, dist: Math.hypot(p.x - from.x, p.y - from.y) }) // the win's confetti: the tickets themselves, their own size
    }
    out.sort((a, b) => a.dist - b.dist)
    return out.slice(0, 600)
  }
  function restingOthers() {
    const out = []
    for (let k = 0; k < layout.n; k++) {
      if (k === mine || (FLOW.keepWinners && wonSlot(k))) continue
      out.push({ k, ...at(k, restPhi) })
    }
    return out
  }
  function ensureEnding() {
    ending ??= createEnding({
      gl: ensureGl,
      app,
      canvas,
      // once the wheel has stopped, where your ticket is drawn; before, where it will rest
      mine: () => (ending.begun ? youOnScreen() : youAtRest()),
      others: othersDrawn,
      resting: restingOthers,
      count: () => layout.n,
      tint: youColour,
      colours: () => ['#59C8FF', youColour(), SLIT.ticketColour, youColour()],
      // the prize is the Winners coin (the lab's metal default, at this page's map size: PRIZE_LOOK) with the flow's amount
      look: () => ({ ...PRIZE_LOOK }),
      // a loss: yours goes too, after the others are all off the page
      mineFallsAfterMs: () => SLIT.mineFallsAfterMs,
      // 'Not this time' is this page's own, over who's playing, before the fall (Continue starts it)
      lostHeadline: () => '',
      // a loss zooms out from the moment you are lit (the ending begins there), at this page's own pace
      zoomOutAfterMs: () => 0,
      zoomOutMs: () => SLIT.lossZoomOutMs,
      // a win: the prize over black, the wheel gone under it (the flow's keeps a fifth of it)
      wheelBehindPrize: () => SLIT.wheelBehindPrize,
      // a loss: your coin, once it lies on your slot again, as much of it as your ticket would show — lit or not
      mineOpacity: () => (tA[mine] > 0 ? tA[mine] : 1),
      // the draw is decided at the deal: only its own ending is built
      won: () => (ready() ? wonSlot(mine) : undefined),
      // the intro's coin still up: the prize's waits to bring up its maps until it has gone
      defer: () => !!intro,
    })
    return ending
  }

  /* ── THE TIMELINE (#phase) — the flow's slider, restyled (style.css) ────
     It spans the spin's real seconds, then the fall's. The line only SHOWS
     where the draw is: it takes no hand while the wheel turns or the winners
     are walked through. Once you have been lit it grows into Continue, and
     that is what scrubs it (seek, resume — the pill's drag, below): the
     draw can be gone back over only once it has shown who won. */
  function span() {
    const a = landing && spinT0 != null ? warp.realDurS : 0
    const b = ending?.kind === 'lost' && continued ? ending.lengthS : 0
    return { a, T: a + b }
  }
  function seek(v) {
    const { a, T: total } = span()
    if (total <= 0) return
    const r = v * total
    /* unzoomed by a tap: the zoom is back only once the timeline crosses where it comes in */
    if (unzoomed && warp) {
      const at = warp.realDurS + SLIT.zoomAtS
      const was = sliderValue() * total
      if (was !== r && (was - at) * (r - at) <= 0) unzoomed = false
    }
    running = false
    scrubbed = true
    if (r < a || !ending?.kind) {
      if (ending?.begun) ending.rewind()
      phase = clamp01(warp.tau(Math.min(r, a)) / landing.durS)
      if (phase < 1) landedAt = null
    } else {
      phase = 1
      ending.seek(r - a, loop.time)
    }
  }
  function resume() {
    if (!landing || spinT0 == null || SLIT.pauseOnSlider) return
    if (ending?.begun) return ending.release(loop.time)
    if (phase >= 1 || running) return
    spinT0 = loop.time - warp.realAt(phase * landing.durS)
    running = true
  }
  function sliderValue() {
    const { a, T: total } = span()
    if (total <= 0) return 0
    if (ending?.dismissed) return 1
    return clamp01((phase < 1 || !ending?.begun ? warp.realAt(phase * landing.durS) : a + ending.e) / total)
  }
  const touchable = () => spinT0 != null && seqS() >= cuesNow().seat
  const ph = dom.phase
  if (ph) ph.tabIndex = -1 // the line takes no hand, nor the keyboard: it only shows where the draw is

  /* ── WHO'S PLAYING, AND THE WALK (legend.js, names.js, walk.js) ──────────
     Built with the draw: everyone playing (at most 100) left to right as
     their tickets rest. From the wheel's stop (on the spin's clock, so the
     timeline replays it) the row comes on, the winners are lit one by one
     and you last; then the ending. From the moment the walk starts the
     tickets and the names take taps — and keep taking them, scrubbed back
     into the spin or not. */
  let row = [] //            slots, left to right
  let rowNo = 0 //           bumped with every new row: the plan is made again
  let plan = null
  let planKey = ''
  let rowX = 0 //            the row's offset as drawn, nominal px
  let opened = false //      the row has come on and the walk begun: from here it stays, and takes taps
  let tapped = -1 //         the ticket you tapped (yours too: a tap off the wheel); −1: none — the walk's
  let continued = false //   a loss: Continue pressed, the fall started
  let homeAt = 0 //          …and once it is over, back to the start at this loop time (0: not yet)
  let endFromS = 0 //        when the ending began, s from the stop
  let scrubbedOut = false // JOLLITY: Continue dragged: zoomed out for the rest of the draw
  let unzoomed = false //    a ticket tapped while zoomed in: the zoom eases out, and stays out until the timeline crosses where it comes in
  let zKeep = 1 //           …how much of the zoom is kept, easing
  let fellFromHold = false // a loss, Continue pressed: the hold after the flip let go, straight into the fall (once)
  let friendsA = 0 // JOLLITY: how much of the friends' bar shows, easing
  let inviteA = 0 // JOLLITY: how much of the invitation shows in its place, with no friend in the draw, easing
  let wonShown = false // JOLLITY: a win's prize has been up: a spin played again from the timeline stops on the wheel
  let settledNow = false // JOLLITY: stopped, walked through, its ending up or over: the draw is still
  let scrubAt = 0 // JOLLITY: where the page's hand last put the timeline, 0..1
  let headA = 0 //           Not this time, easing in once the flip is over
  let pillOn = false //      you have been lit: the timeline is Continue now, for the rest of the draw
  let pillT0 = 0 //          …since this loop time
  let tA = new Float32Array(0) // each ticket's alpha as drawn, easing between its states (ticketAlpha)
  let loserLitE = 0 //       how much a ticket that did not win is lit (0..1, eased): WINNERS goes to winnersLoserLitA with it
  let lineFor = -1 //        the lit one whose line is drawn (−1: none)…
  let lineT0 = 0 //          …since this loop time: it draws over lineDrawMs —
  let tapFrom = 'name' //    …down from the name (the walk's, a name tapped), or up from the ticket (a ticket tapped)
  let nA = new Float32Array(0) // …and each name's
  let nIn = new Float32Array(0)
  let nShow = new Float32Array(0) // …as shown: stepped back while a loss's fall plays
  let fellA = 1
  const restZoom = () => zoomAt(zfit, SLIT.zoom ? 1 : 0)
  // JOLLITY: the player's friends (chainDraw.friends: a ticket's index in chainDraw.values, and a colour each), by their slot on this ring; the list grows as their names are read
  let friendsRing = null
  let friendsCount = -1
  let friendKs = []
  const friendsNow = () => {
    if (!chainDraw?.friends?.length || !ring) return []
    if (friendsRing !== ring || friendsCount !== chainDraw.friends.length) {
      friendsRing = ring
      friendsCount = chainDraw.friends.length
      const kOf = new Map()
      for (let k = 0; k < ring.order.length; k++) kOf.set(ring.order[k], k)
      friendKs = chainDraw.friends.map((fr) => ({ k: kOf.get(fr.index), colour: fr.colour })).filter((fr) => fr.k != null && fr.k !== mine)
    }
    return friendKs
  }
  // JOLLITY: a real draw's names are its holders' (chainDraw.nameOf, by the ticket's index in chainDraw.values); a friend's in their colour
  const whoOf = (k) => ({ k, name: k === mine ? 'YOU' : chainDraw ? chainDraw.nameOf(ring.order[k]) : nameFor(seed, k), you: k === mine, colour: k === mine ? null : (friendsNow().find((fr) => fr.k === k)?.colour ?? null) })
  function buildRow() {
    const n = layout.n
    const rowWas = row // JOLLITY: the names' alphas carry over to the new row (below)
    const winners = Array.from({ length: winnersNow() }, (_, i) => (ranks.cut + i) % n)
    const H = hub()
    row = rowFor({ n, mine, winners: [...winners, ...friendsNow().map((fr) => fr.k)], pos: (k) => at(k, restPhi), focus: { x: H.x, y: H.y - wedge.reach / 2 }, hub: H }).filter((k) => k >= 0) // JOLLITY: a spectator has no ticket in the row; the friends are kept in it, as the winners are
    rowNo++
    plan = null
    tapped = -1
    opened = false
    if (tA.length < n) tA = new Float32Array(n)
    // JOLLITY: each name still in the row keeps how much of it showed
    const at0 = new Map(rowWas.map((k, i) => [k, i]))
    const a = new Float32Array(row.length)
    const shown = new Float32Array(row.length)
    row.forEach((k, i) => {
      const o = at0.get(k)
      if (o != null) {
        a[i] = nA[o] ?? 0
        shown[i] = nIn[o] ?? 0
      }
    })
    nA = a
    nIn = shown
    legend.set(row.map(whoOf)) // JOLLITY: whoOf, the chain's names on a real draw
  }
  /* JOLLITY: a ticket picked that is not in who's playing joins it, in its place round the ring
     (rowFor keeps it as it keeps the winners and yours; the row's farthest other goes to make room).
     Each name keeps how far in it was; the new one is in at once (lib/draw/wheel/explore.ts) */
  function joinRow(k) {
    if (row.includes(k)) return
    const H = hub()
    const winners = Array.from({ length: winnersNow() }, (_, i) => (ranks.cut + i) % layout.n)
    const next = rowFor({ n: layout.n, mine, winners: [...winners, ...friendsNow().map((fr) => fr.k), k], pos: (j) => at(j, restPhi), focus: { x: H.x, y: H.y - wedge.reach / 2 }, hub: H }).filter((j) => j >= 0)
    const a = new Float32Array(next.length)
    const shown = new Float32Array(next.length)
    next.forEach((j, i) => {
      const o = row.indexOf(j)
      a[i] = o >= 0 ? nA[o] : 0
      shown[i] = o >= 0 ? nIn[o] : 1
    })
    row = next
    nA = a
    nIn = shown
    legend.set(row.map(whoOf))
  }
  /* the seconds from the wheel's stop: negative while it spins (the spin's
     own clock, so the timeline's scrub moves it), −∞ before it has started */
  function sinceStop() {
    if (!ready() || spinT0 == null) return -Infinity
    if (phase < 1) return spinRealNow() - warp.realDurS
    return landedAt != null ? now() - landedAt : 0
  }
  /* the walk's plan: which names are on the stage as the row comes on —
     placed over the first ticket lit — needs the row laid out, so it is made
     here, the first frame that asks, and again when its dials move */
  function planNow() {
    if (!row.length || !zfit) return null
    const key = [rowNo, SLIT.namesFromStopS, SLIT.namesWalkMs, SLIT.walkMs, SLIT.walkWinnersMaxMs, view.scale, SLIT.zoom, Wn()].join('|')
    if (plan && key === planKey) return plan
    planKey = key
    const zr = restZoom()
    legend.stage(Wn(), view.scale)
    const first = row.find((k) => wonSlot(k)) ?? mine
    const p = at(first, restPhi)
    const x0 = rowXFor(legend.box(row.indexOf(first), view.scale), { x: zr.s * p.x + zr.tx, r: markR() * zr.s }, Wn())
    const visible = row.map((_, i) => {
      const l = legend.leftOf(i, x0)
      return l >= 0 && l + legend.box(i, view.scale)[1] <= Wn()
    })
    plan = walkPlan({ order: row, visible, winners: row.filter((k) => wonSlot(k)), mine, S: SLIT })
    plan.x0 = x0
    if (!friendsSeen) rowX = x0 // JOLLITY: up already for your friends: it stays where it is
    return plan
  }
  /* the wheel takes taps from the walk's start on — not under the prize, nor once a loss's fall has started */
  function tappable() {
    if (!opened || ending?.prizeUp) return false
    return !(ending?.kind === 'lost' && continued)
  }
  /* a tap: the nearest ticket in the row within its radius and 10 px — or, off them all, nobody */
  function tapAt(x, y) {
    const phi = phiNow()
    let best = -1
    let bd = Infinity
    for (const k of row) {
      const p = onScreen(at(k, phi))
      const d = Math.hypot(p.x - x, p.y - y)
      if (d < (k === mine ? markR() : fitted.dot / 2) * zm.s + 10 && d < bd) {
        bd = d
        best = k
      }
    }
    tapped = best >= 0 ? best : NOBODY // off them all: nobody lit, the draw as it landed
    tapFrom = 'ticket' // its line draws up from it to its name
    if (best >= 0 && zm.z > 0.01) unzoomed = true // zoomed in, a ticket tapped: out, to the whole wheel
    return best
  }
  app.addEventListener('pointerdown', (e) => {
    if (!tappable() || e.target.closest?.('#phase, button, .slit-legend-item')) return
    const r = app.getBoundingClientRect()
    tapAt((e.clientX - r.left) / view.scale, (e.clientY - r.top) / view.scale)
  })
  // a name tapped: its ticket, as if the ticket were
  legend.onPick((i) => {
    if (tappable() && row[i] != null) {
      tapped = row[i]
      tapFrom = 'name' // its line draws down from its name to it
    }
  })
  /* A LOSS: Not this time, over the row, once you are lit.
     CONTINUE: once you are lit the timeline grows into it (pillGrowsMs), and
     it stays the timeline — drag along it and it takes you through the draw,
     still a button. Pressed: a loss plays the fall, then goes back to the
     start (the coin into the slit, or flipped); a win goes back at once.
     Over Back to the wheel while the prize is up */
  const lossEl = document.createElement('div')
  lossEl.id = 'slit-loss'
  app.appendChild(lossEl)
  const PILL_H = 48
  const contEl = document.createElement('button')
  contEl.type = 'button'
  contEl.id = 'slit-continue'
  contEl.innerHTML = '<span>Continue</span>'
  app.appendChild(contEl)
  // JOLLITY: the host moves on, once: Continue on a win, the fall played out on a loss
  let chainDoneSent = false
  const chainDone = () => {
    if (chainDoneSent) return
    chainDoneSent = true
    chainDraw.onDone?.()
  }
  function proceed() {
    if (ending?.kind !== 'lost') return chainDraw ? chainDone() : slitActions.toCoin() // JOLLITY: a real draw goes on
    if (continued) return
    continued = true
    tapped = NOBODY // Continue: nobody lit — the draw as it landed, while the fall plays
    // scrubbed back into the spin: to its stop (the walk is then taken to its end — frame())
    if (phase < 1) {
      phase = 1
      running = false
    }
  }
  /* a press is Continue; a drag along it is the timeline's */
  let pillDown = null
  let pillDragged = false
  contEl.addEventListener('pointerdown', (e) => {
    pillDown = { x: e.clientX, drag: false }
    try {
      contEl.setPointerCapture(e.pointerId)
    } catch {}
  })
  contEl.addEventListener('pointermove', (e) => {
    if (!pillDown || !touchable()) return
    if (!pillDown.drag && Math.abs(e.clientX - pillDown.x) < 6) return
    pillDown.drag = true
    tapped = -1 // a hand on the timeline: nobody is lit
    scrubbing = true
    scrubbedOut = true // JOLLITY: the zoom out, from here on
    running = false
    const r = contEl.getBoundingClientRect()
    const v = clamp01((e.clientX - r.left) / Math.max(1, r.width))
    if (ph) ph.value = v.toFixed(3)
    seek(v)
  })
  for (const ev of ['pointerup', 'pointercancel'])
    contEl.addEventListener(ev, () => {
      if (!pillDown) return
      pillDragged = pillDown.drag
      pillDown = null
      if (pillDragged) {
        scrubbing = false
        resume()
      }
    })
  contEl.addEventListener('click', () => {
    if (pillDragged) return (pillDragged = false)
    proceed()
  })
  let contShown = null
  function showContinue(on) {
    if (on === contShown) return
    contShown = on
    contEl.classList.toggle('is-shown', on)
    if (on) chainDraw?.onContinueShown?.() // JOLLITY: the host hears it go up
  }

  /* ── WHERE TO GO IN IT (the panel's buttons)─────────────────────────── */
  function clearRun() {
    ending?.stop()
    app.classList.remove('flow-prize-up')
    spinT0 = null
    running = false
    scrubbing = false
    scrubbed = false
    phase = 0
    landedAt = null
    zoomKeep = 1
    continued = false
    homeAt = 0
    tapped = -1
    opened = false
    pillOn = false
    unzoomed = false
    scrubbedOut = false // JOLLITY
    zKeep = 1
    fellFromHold = false
    headA = 0
  }
  /* TO INSERT COIN — the whole of it again, the same draw */
  slitActions.toCoin = () => {
    ending?.letGo() // the prize's coin goes before the intro's comes up: deal() builds it again if wanted
    clearRun()
    seqT0 = null
    hand = null
    flipHow = null
    URLS.at = null
    ensureIntro().replay()
  }
  /* TO WHEEL — the coin just landed on its ticket, the wheel turning, the same draw */
  slitActions.toWheel = () => {
    clearRun()
    endIntro()
    URLS.at = null
    seqT0 = loop.time - cuesNow().seat
  }
  /* TO OUTCOME — at rest on the winners, everything on, zoomed in */
  slitActions.toOutcome = () => {
    if (!ready()) return
    clearRun()
    endIntro()
    URLS.at = null
    seqT0 = loop.time - cuesNow().spin - warp.realDurS
  }
  /* NEW SEED — a fresh ticket list and stop, dealt with the outcome dial as
     it is now, from the wheel. PLAYERS or WINNERS moved: the same seed, dealt
     again at the new size */
  slitActions.newSeed = () => {
    clearRun()
    endIntro()
    seed = fresh()
    baseEntropy = fresh()
    want = wantFor(SLIT.outcome)
    seqT0 = null
    void deal().then((ok) => ok && slitActions.toWheel())
  }
  slitActions.resize = () => {
    clearRun()
    endIntro()
    seqT0 = null
    void deal().then((ok) => ok && slitActions.toWheel())
  }

  /* a layer at the stage's size in device px — #slit-under only while the
     intro is up (it is nothing but the slit's light under the coin): 0×0
     otherwise, and sized again by the intro's next frame */
  function size(c, on = true) {
    const w = on ? Math.round(view.W * view.dpr) : 0
    const h = on ? Math.round(view.H * view.dpr) : 0
    if (c.width !== w || c.height !== h) {
      c.width = w
      c.height = h
    }
  }
  function fit() {
    if (measure(app, { fov })) gl?.resize()
    view = { W: stage.W, H: stage.H, dpr: stage.dpr, scale: stage.scale }
    size(canvas)
    size(underEl, !!intro?.active)
    const side = Math.ceil(SLIT.arrowPx * view.dpr * view.scale) + 4 // the arrow, either way round, and its edge's AA
    if (arrowsEl.width !== side) arrowsEl.width = arrowsEl.height = side
    Object.assign(arrowsEl.style, { right: 'auto', bottom: 'auto', width: `${(100 * side) / Math.round(view.W * view.dpr)}%`, height: `${(100 * side) / Math.round(view.H * view.dpr)}%` })
    relayout()
  }
  addEventListener('resize', fit)
  fit()

  void deal().then((ok) => {
    if (!ok || URLS.intro || seqT0 != null) return
    seqT0 = URLS.at != null ? loop.time : loop.time - cuesNow().seat
  })
  if (URLS.intro) ensureIntro()

  /* ── THE TRAILS: what a ticket swept ─────────────────────────────────────
     Not a decoration of a fixed length: the way the ticket actually came over
     the last trailMs, traced back through the same closed forms that move it
     — yours along the coin's own path until it landed and the wheel since.
     So it is exactly as wide as the ticket that
     left it (at the size it was then), as long as it went in that time — a
     fast ticket a long one, a slowing one a shortening one, the slow-mo's a
     short one, a still one none — and its colour is its age: the ticket's own
     at the head, a pale yellow, a lavender, nothing at the tail. */
  const bufs = [{ pts: new Float32Array(2 * (TRAIL_N + 1)), ang: new Float32Array(TRAIL_N + 1), wid: new Float32Array(TRAIL_N + 1) }]
  /* yours: the coin's path back to the hand-over (never past it — before
     that it was in the slit), and the wheel since it landed. Angles in the
     coin's unwrapped frame, so the two join without a turn's jump. Its
     length has a dial of its own while the coin circles and spirals in
     (orbitTrailMs), eased to the wheel's from the landing (trailS) */
  function traceYou(s, cues, o, wheelTurning, buf, zoomRaw = 0) {
    const H = hub()
    const T = trailS(s, cues.seat, SLIT.orbitTrailMs, SLIT.trailMs) // circling and spiralling, then the wheel's, eased between
    // on the zoom in it thins away to nothing, quickly (trailZoomThinMs): its width, not its length
    const thin = 1 - (SLIT.trailZoomThinMs > 0 ? ramp(zoomRaw * SLIT.zoomMs, 0, SLIT.trailZoomThinMs) : zoomRaw > 0 ? 1 : 0)
    if (thin <= 1e-3) return 0
    let n = 0
    for (let j = 0; j <= TRAIL_N; j++) {
      const back = (T * j) / TRAIL_N
      const sj = s - back
      if (sj < (flip ? cues.drop : 0)) break // before that it was in the slit (or, flipped, nowhere)
      if (scrubbed || sj >= cues.seat) {
        if (!wheelTurning) break // on a wheel standing still it sweeps nothing
        const phi = phiBack(back)
        const psi = o.psiEnd + (phi - seat.phi)
        buf.pts[2 * j] = H.x + seat.rho * Math.cos(psi)
        buf.pts[2 * j + 1] = H.y + seat.rho * Math.sin(psi)
        buf.ang[j] = psi
        buf.wid[j] = 2 * markR() * thin
      } else {
        const p = o.at(sj)
        buf.pts[2 * j] = p.x
        buf.pts[2 * j + 1] = p.y
        buf.ang[j] = p.psi
        buf.wid[j] = 2 * p.r * thin
      }
      n = j + 1
    }
    return n
  }

  /* ── THE ARROW TO YOUR TICKET (the flow's arrowNow, wheel/scene.js) ─────
     Zoomed in on the wedge, your ticket is often off the stage: a triangle
     on the edge points out at it, square to the edge, sliding along it as the
     wheel turns — only while the whole ticket is past that edge. The edge is
     the one the line from the stage's middle to your ticket leaves by; along
     it the arrow sits where that line crosses, easing (edgeEase) toward the
     ends so it arrives at the corner margin just as it changes edge. */
  function edgeEase(v, len, half, mLo, mHi, k) {
    const lo = mLo + half
    const hi = len - mHi - half
    if (hi - lo <= 2 * k || k <= 0) return Math.max(lo, Math.min(hi, v))
    const ease = (t, m) => 1 - Math.pow(1 - clamp01(t), m)
    const up = hi - k
    if (v > up) return up + k * ease((v - up) / (len - up), (len - up) / k)
    const dn = lo + k
    if (v < dn) return dn - k * ease((dn - v) / dn, dn / k)
    return v
  }
  /* the bottom of what you can see: the stage's, or — zoomed — the floor's
     fade over the timeline (paint.js floor(): black from BAR_Y − 10, half
     gone at BAR_Y − 27), eased in with the zoom as the floor is */
  const visibleH = () => Hn() + (BAR_Y - 27 - Hn()) * zm.z
  function arrowTo(k, phi, a, colour) {
    if (a <= 0 || k < 0) return null
    const p = onScreen(at(k, phi))
    const r = (markR() + 3.5) * zm.s
    const W = Wn()
    // some of it is in view — under the floor's fade it is not, so its centre has to be above it
    if (p.x > -r && p.x < W + r && p.y > -r && p.y < visibleH()) return null
    /* …but the arrow itself sits on the stage's own edges — the bottom one
       is the screen's, under the timeline and the names, not the floor's */
    const H = Hn()
    const dx = p.x - W / 2
    const dy = p.y - H / 2
    const half = SLIT.arrowPx / 2
    const corner = SLIT.arrowCornerPx
    const ek = SLIT.arrowEasePx
    const side = Math.abs(dx) * H > Math.abs(dy) * W ? (dx < 0 ? 'left' : 'right') : dy > 0 ? 'bottom' : 'top'
    if (side === 'left' || side === 'right') {
      const cross = H / 2 + (dy * (W / 2)) / Math.abs(dx)
      return { side, x: side === 'left' ? 0 : W, y: edgeEase(cross, H, half, 0, corner, ek), a, colour }
    }
    const cross = W / 2 + (dx * (H / 2)) / Math.abs(dy)
    const m = side === 'bottom' ? corner : 0
    return { side, x: edgeEase(cross, W, half, m, m, ek), y: side === 'bottom' ? H : 0, a, colour }
  }

  /* the arrows' canvas over the one arrow there is: its top-left, device px of
     the stage, a whole px (so the triangle's pixels are the ones a stage-sized
     canvas had), kept on the stage — and the painter told where it is */
  const arrowAt = { x: 0, y: 0 }
  function placeArrows() {
    const ar = f.arrows.find((a) => a.a > 0.002)
    if (!ar) return arrowAt
    const k = view.dpr * view.scale
    const side = arrowsEl.width
    const W = Math.round(view.W * view.dpr)
    const H = Math.round(view.H * view.dpr)
    const x = Math.max(0, Math.min(W - side, Math.round(ar.x * k - side / 2)))
    const y = Math.max(0, Math.min(H - side, Math.round(ar.y * k - side / 2)))
    if (x !== arrowAt.x || y !== arrowAt.y) {
      arrowAt.x = x
      arrowAt.y = y
      arrowsEl.style.left = `${(100 * x) / W}%`
      arrowsEl.style.top = `${(100 * y) / H}%`
    }
    return arrowAt
  }

  /* ── ONE FRAME ───────────────────────────────────────────────────────── */
  let painted = 0
  let hideCoin = false // the suite's: the coin and its trail off, to read the bowl's pixels on their own
  let underShown = false
  let lastF = null
  let lastEnd = null
  const css = new Map() // custom properties, written only when they move
  const setVar = (k, v) => {
    if (css.get(k) === v) return
    css.set(k, v)
    app.style.setProperty(k, v)
  }
  const f = { markers: [], trails: [], arrows: [], look: null }
  const outBuf = { pts: new Float32Array(2 * (TRAIL_N + 1)), ang: new Float32Array(TRAIL_N + 1), wid: new Float32Array(TRAIL_N + 1) } // the flipped coin's, on its way out

  /* THE BURST: the glow bursting out from behind the black disc, to the
     hub's glow (cues.explode) — on the slit page where its light went out,
     on the flip page just before the coin lands. It sets the frame's circle,
     and its flash and shockwave, into f */
  function burst(s, cues, wheelA) {
    const e = cues.explode
    const eu = clamp01((s - e.at) / e.dur)
    /* how it bursts — out past its size and back down, in two beats (sequence.js) */
    const out = s < e.at ? 0 : burstOut(eu, SLIT)
    if (out <= 0) return
    const RA = SLIT.hubPx + (SLIT.hubAfterPx - SLIT.hubPx) * ramp(s, cues.winner.at, cues.winner.dur)
    const R = Math.max(0.5, SLIT.hubDiscPx + (RA - SLIT.hubDiscPx) * out) // from the disc's edge out: it shows from its first frame
    // it comes up from nothing as it bursts (burstFadeInMs)
    f.circle = { R, t: 2, a: wheelA * ramp(s, e.at, SLIT.burstFadeInMs / 1000), blur: SLIT.glowBlur ? SLIT.glowBlurWheelPx : 0 }
    // the flash: its core and its blue near white, cooling to the gradient's own
    const since = s - e.at
    const fl = SLIT.burstFlash ? SLIT.burstFlashA * (1 - smooth(since / (SLIT.burstFlashMs / 1000))) : 0
    if (fl > 0.002) {
      const toWhite = (c, w) => c.map((v) => v + (255 - v) * w)
      f.glow = { ...f.glow, core: toWhite(f.glow.core, fl), mid: toWhite(f.glow.mid, fl * 0.7), outer: toWhite(f.glow.outer, fl * 0.3) }
    }
    // the shockwave: a thin ring shooting out past the glow, fading
    const ru = since / (SLIT.burstRingMs / 1000)
    if (SLIT.burstRing && ru < 1) {
      const go = 1 - Math.pow(2, -8 * ru)
      f.shock = { R: SLIT.hubDiscPx + (RA * SLIT.burstRingReach - SLIT.hubDiscPx) * go, a: SLIT.burstRingA * (1 - ru) * (1 - ru) * wheelA, w: SLIT.burstRingPx }
    }
  }

  let wordsA = 1 // FLIP THE COIN, eased out as it goes

  function frame(t, dt) {
    if (homeAt && loop.time >= homeAt) chainDraw ? chainDone() : slitActions.toCoin() // a loss played out after Continue: the start again (JOLLITY: a real draw goes on)
    if (intro?.active) intro.update(loop.time)
    if (intro && !intro.active) releaseIntro()
    // …and the prize's coin brings up what it waited with, a step a frame
    if (!intro && ending && !uploaded) {
      const t0 = performance.now()
      uploaded = ending.upload()
      uploads.push(performance.now() - t0) // main-thread ms a step: the suite holds it to no compiles
    }
    const introUp = !!intro?.active
    const cues = cuesNow()
    const s = seqS()
    const H = hub()
    const cx = Wn() / 2
    const sy = slitY()
    const ok = ready()

    /* the spin: it starts on its cue — before the coin is down, by default —
       and runs on its own (slow-mo) clock */
    if (ok && spinT0 == null && s >= cues.spin) {
      spinT0 = seqT0 + cues.spin
      running = true
    }
    if (running && ok) {
      phase = clamp01(warp.tau(now() - spinT0) / landing.durS)
      if (phase >= 1) {
        running = false
        landedAt = spinT0 + warp.realDurS
      }
    }
    const atRest = ok && spinT0 != null && phase >= 1
    if (atRest && landedAt == null) landedAt = now()
    else if (!atRest) landedAt = null

    /* who's playing, and the walk: seconds from the stop, and where it is */
    const pl = ok ? planNow() : null
    // Continue pressed on a loss with the walk not over: it is taken to its end, so the fall starts now
    if (continued && atRest && pl && !ending?.begun && sinceStop() < pl.end) landedAt = now() - pl.end
    const ts = sinceStop()
    const wk = walkAt(pl, ts)
    if (atRest && pl && ts >= pl.start) opened = true
    const free = atRest && wk.phase === 'free'
    settledNow = atRest && !running && !scrubbing && (free || !!ending?.held || !!ending?.dismissed) // JOLLITY

    /* the ending, with the toggle on: decided as the spin starts, begun once
       you have been lit. A loss: the zoom out, your coin's flip — and there
       it HOLDS, Not this time and Continue up; pressed, the others start to
       fall at once (the fall's own pause after the flip skipped) */
    let end = null
    if (SLIT.showWinOrLoss && ok && spinT0 != null) {
      ensureEnding()
      if (!ending.kind) ending.prepare(wonSlot(mine))
    } else if (ending?.kind) ending.stop()
    if (ending?.kind) {
      // a win once you are lit and the walk is over; a loss the moment you are lit (its zoom out from there)
      const go = (free || (ending.kind === 'lost' && atRest && wk.phase === 'you')) && !(ending.kind === 'won' && wonShown) // JOLLITY: a win's prize comes up once
      if (go && !ending.begun) {
        ending.begin(loop.time)
        endFromS = ts
      } else if (!atRest && ending.begun) ending.rewind()
      if (!ending.begun) fellFromHold = false
      if (ending.kind === 'lost' && ending.begun) {
        const mk = ending.lossMarks
        if (!continued) {
          if (!ending.held && ending.e >= mk.flipEnd) ending.seek(mk.flipEnd, loop.time) // held on the flip's end
        } else if (!fellFromHold) {
          fellFromHold = true
          if (ending.e < mk.fallAt) ending.seek(mk.fallAt, loop.time) // straight to the fall
          ending.release(loop.time)
        }
      }
      end = ending.frame(loop.time)
      if (ending.begun) landedAt = loop.time - end.e - endFromS // the walk stays where it ended
      zoomKeep = end.zoomKeep
      // a loss, Continued: the others fall, yours yourCoinFallsAfterOthersMs after — and the moment yours is off the page, back to Insert Coin
      if (ending.kind === 'lost' && continued && ending.begun && !ending.held && !scrubbing && !homeAt && ending.e >= ending.lengthS - 1e-3) homeAt = loop.time
    } else zoomKeep = chainDraw?.spectator && free ? zoomKeep * Math.exp((-dt * 4) / Math.max(0.001, SLIT.zoomMs / 1000)) : 1 // JOLLITY: a spectator's draw, walked through, eases back out to the whole wheel
    lastEnd = end
    app.classList.toggle('flow-prize-up', !!ending?.prizeUp)
    const wheelA = end ? end.wheelAlpha : 1
    const wedgeLeft = 1 - clamp01(end?.wedgeFade ?? 0)
    const ringsLeft = (SLIT.rings ? 1 : 0) * (1 - clamp01(end?.ringsFade ?? 0))

    const zin = zfit && ok ? zoomIn() : { raw: 0, z: 0 }
    // a ticket tapped zoomed in: the zoom eases out over zoomMs, back at once when the timeline crosses its start
    zKeep = unzoomed || scrubbedOut ? zKeep * (SLIT.tapZoomOutMs > 0 ? Math.exp((-dt * 1000 * 4) / SLIT.tapZoomOutMs) : 0) : 1 // JOLLITY: or Continue dragged
    zm = zfit && ok ? zoomAt(zfit, zin.z * zoomKeep * zKeep) : { s: 1, tx: 0, ty: 0, z: 0 }
    if (userView.s !== 1 || userView.tx || userView.ty) zm = { s: zm.s * userView.s, tx: zm.tx * userView.s + userView.tx, ty: zm.ty * userView.s + userView.ty, z: zm.z } // JOLLITY: the player's zoom, on top

    /* ── the frame, described ── */
    const before = seqT0 == null // the coin is still up: the slit as the intro has it
    f.Wn = Wn()
    f.Hn = Hn()
    f.cx = cx
    f.slitY = sy
    f.hub = H
    f.backdrop = !introUp
    f.zoom = zm
    f.floor = { a: zm.z, y: BAR_Y }
    f.markers.length = 0
    f.trails.length = 0
    f.arrows.length = 0
    f.arrowPx = SLIT.arrowPx
    f.trailCircles = SLIT.trailStyle === 'circles' ? SLIT.trailCircles : 0
    f.look = lookOpt ?? TAILS[SLIT.tail] ?? null // the trail lab's own, or this page's tail (gradient: none — the flat trail)
    f.tail = lookOpt ? null : SLIT.tail // a flat one's colours (paint.js FLAT_TAILS)

    f.glow = { heart: SLIT.glowHeartOn ? rgbOf(SLIT.glowHeart) : null, core: rgbOf(SLIT.glowCore), mid: rgbOf(SLIT.glowMid), outer: rgbOf(SLIT.glowOuter), grain: SLIT.glowGrain ? SLIT.glowGrainA : 0 }
    f.bg = SLIT.bg
    f.ticketColour = SLIT.ticketColour
    setVar('--bg', SLIT.bg)
    setVar('--slit-you', SLIT.youColour)
    let m = 0
    let slitA = 0
    let heat = 0
    f.hairPlain = 0
    f.holeDisc = 0
    f.shock = null
    f.flipWords = null
    f.outTrail = null
    if (flip) {
      /* THE FLIP: no slit at all. The page is dark from the first frame and
         stays so; the words under the coin, its trail as it goes */
      f.bowl = null
      f.bowlA = 0
      f.cone = null
      f.hairA = 0
      f.shade = 0
      f.words = null
      const ip = introUp ? intro.phase : 'done'
      wordsA += ((ip === 'rest' || ip === 'drag' ? 1 : 0) - wordsA) * Math.min(1, dt * 12)
      if (introUp && wordsA > 0.002) f.flipWords = { text: FLIP.words, a: wordsA, x: cx, y: FLIP.coinY + SOLID_LOOK.coinR + 25.6 } // its top as far under the coin as INSERT COIN's is under the slit
      if (introUp && SLIT.trail) {
        const c = intro.coinNow
        const n = c.out ? intro.trace(loop.time, FLIP.outTrailMs / 1000, outBuf, TRAIL_N) : 0
        if (n > 1) f.outTrail = { ...outBuf, n, head: rgbOf(SOLID_LOOK.plasticColour), plain: true, a: 1, clip: null }
      }
      /* the black disc is on the hub from the start (below); just before the
         coin lands, the glow bursts out from behind it — the slit's burst */
      f.circle = null
      if (!before && ok) burst(s, cues, wheelA)
    } else {
      /* the slit, from the intro until the hand-over; its own cues after */
      slitA = 1
      let hot = 1
      let chev = 0
      let hint = 0
      if (before) {
        if (introUp) {
          const el = intro.slot.element
          slitA = parseFloat(el.style.opacity) || 0
          hot = intro.slot.hotValue
          const c = parseFloat(el.style.getPropertyValue('--slot-chevron'))
          const h = parseFloat(el.style.getPropertyValue('--slot-hint'))
          chev = Number.isFinite(c) ? c : 1
          hint = Number.isFinite(h) ? h : 1
        } else slitA = 0
      }
      heat = clamp01((hot - COIN.restGlow) / Math.max(0.01, COIN.slotGlow - COIN.restGlow))
      m = before ? 0 : ramp(s, cues.bend.at, cues.bend.dur)
      const bowl = slitA > 0 ? bowlAt({ m, cx, slitY: sy, hubY: H.y, L0: SLIT.slitLengthPx, R0: SLIT.slitCirclePx }) : null
      /* the centre's colour: the hub glows in it; the slit, white while it is
         straight, takes it on — at full brightness — as it starts to bend */
      const tint = before ? 0 : smooth(m / 0.3)
      f.slitRgb = f.glow.core.map((v) => 255 + (v - 255) * tint)
      f.bowl = m < 1 ? bowl : null
      f.bowlA = m < 1 ? 1 : 0
      f.cone = before ? { a: slitA, heat } : { a: 1 - ramp(s, cues.cone.at, cues.cone.dur), heat: 1 }
      f.hairA = before ? slitA * (0.55 + 0.45 * hot) : m < 1 ? 1 : 0
      if (!before && m >= 1) {
        /* the ring is closed: the black hole's first beat — the slit's own
           light, its bowl's gradient and its hairline, collapsing onto the
           hub and fading as it goes: nothing left of it by the dot (collapse) */
        const u = cues.collapse.dur > 0 ? clamp01((s - cues.collapse.at) / cues.collapse.dur) : 1
        const R = SLIT.slitCirclePx * (1 - u * u * (3 - 2 * u)) // eased in and out: it closes on the hub
        f.bowl = u < 1 && bowl ? { ...bowl, R: Math.max(0.5, R), halfW: Math.max(0.5, R) * Math.sin(bowl.alpha) } : null
        /* its light: its gradient as it closed ('gradient'), or fading to leave
           a plain white line ('fades to a line', over cues.line) — and all of
           it fading with the collapse, gone by the dot */
        const fades = SLIT.slitGlow === 'fades to a line'
        const line = fades ? ramp(s, cues.line.at, cues.line.dur) : 0
        const left = 1 - u * u * (3 - 2 * u)
        f.bowlA = u < 1 ? (1 - line) * left : 0
        f.hairA = u < 1 ? left : 0
        f.hairPlain = line
      }
      f.shade = before ? SHADE * slitA * (1 - heat) : 0 // JOLLITY: the dark block goes as the coin goes in, gone by the hand-over
      f.words = before ? { chevron: chev * slitA, hint: hint * slitA } : null

      /* THE BLACK HOLE, where the slit's light went out (above): the black
         disc is there at once, and the glow bursts out from behind it,
         easing out to its size */
      f.circle = null
      if (!before && m >= 1) {
        const c = cues.collapse
        const u = c.dur > 0 ? clamp01((s - c.at) / c.dur) : 1
        burst(s, cues, wheelA)
        f.holeDisc = u >= 1 ? 1 : 0
      }
    }

    /* THE TICKETS' STATE (walk.js's ticketAlpha): a tap lights its ticket
       whenever it comes; turning, or scrubbed back into the spin, the spin's;
       landed, the result until the walk lights its first winner — then the
       walk's, you at its end. Each ticket eases to its state's alpha over
       easeMs, except outside your own while turning: those sweep under the
       wedge as they are, crisp */
    const scrubbedBack = opened && !atRest
    const { state, lit } = stateOf({ tapped: opened || tapped === NOBODY ? tapped : -1, atRest, scrubbedBack, phase: wk.phase, focus: wk.focus })
    const easeA = SLIT.easeMs > 0 ? 1 - Math.exp((-dt * 1000 * 3) / SLIT.easeMs) : 1
    loserLitE += ((state === 'lit' && !wonSlot(lit) ? 1 : 0) - loserLitE) * easeA
    const phi = phiNow()
    const k0 = ok ? underFrom(phi) : 0 // the run of `winners` slots under the wedge right now
    const wedgeOn = !before && s >= cues.wedge.at // lit under the wedge only once there is one (it comes after the hole's burst)
    const alphaOf = (k) => ticketAlpha({ state, k, lit, mine, won: wonSlot(k), under: wedgeOn && isUnder(k, k0), S: SLIT })
    const easeTo = (k, ta) => (state === 'spin' && k !== mine ? (tA[k] = ta) : (tA[k] += (ta - tA[k]) * easeA))

    // the slit's: there once its light has gone to a dot; the flip's: on the hub from the first frame
    f.disc = { R: SLIT.hubDiscPx * (flip ? 1 : (f.holeDisc ?? 0)), a: wheelA, blur: SLIT.hubDiscBlurPx / zm.s }

    /* the wedge — its size never moves; its edge lights up from the hub out
       as it comes on and then stays as it is, whatever the draw does (it
       goes only with the whole wheel, under the prize) — and WINNER over it */
    f.wedge = null
    f.winner = null
    if (ok && !before && s >= cues.wedge.at) {
      const on = ramp(s, cues.wedge.at, cues.wedge.dur)
      const keepLit = wheelA * wedgeLeft
      f.wedge = {
        a0: wedge.a0,
        a1: wedge.a1,
        reach: wedge.reach,
        fill: SLIT.wedgeFillColour,
        fillA: SLIT.wedgeFill * smooth(on * 1.5) * keepLit,
        edgePx: SLIT.wedgeEdgePx,
        grainA: (SLIT.wedgeGrain ? SLIT.wedgeSpeckle : 0) * smooth(on * 1.5) * keepLit,
        reveal: on,
        vis: keepLit,
        tip: colourOf(SLIT.wedgeTip, SLIT.wedgeTipAlpha),
        inner: colourOf(SLIT.wedgeInner, SLIT.wedgeInnerAlpha),
        outer: colourOf(SLIT.wedgeOuter, SLIT.wedgeOuterAlpha),
        edge: colourOf(SLIT.wedgeEdge, SLIT.wedgeEdgeAlpha),
        innerAt: SLIT.wedgeInnerAt,
        outerAt: SLIT.wedgeOuterAt,
        luminosity: SLIT.wedgeLuminosity,
      }
      // WINNERS never goes (only with the whole wheel, under the prize) — held back while a ticket that did not win is lit
      f.winner = { a: (s >= cues.winner.at ? 1 : 0) * wheelA * lerp(1, SLIT.winnersLoserLitA, loserLitE), x: zm.s * H.x + zm.tx, y: zm.s * H.y + zm.ty, text: winnersNow() === 1 ? 'WINNER' : 'WINNERS' }
    }

    /* the tickets, from the spin's cue: yours round the wheel */
    f.tickets = null
    f.bloom = SLIT.ticketBloom ? { a: SLIT.ticketBloomStrength, size: SLIT.ticketBloomSizeX } : null
    const turning = running && spinT0 != null // the wheel is moving: its tickets sweep
    const focus = lit // the lit one: the row slides its name over it
    f.select = null
    if (ok && !before && s >= cues.ticketsAt) {
      const n = layout.n
      const r0 = fitted.dot / 2
      const gone = end?.gone
      const dropOf = end?.dropOf
      let c = 0
      for (let k = 0; k < n; k++) {
        if (k === mine || gone?.has(k)) continue
        const appear = ramp(s, ticketAt(cues, ticketD[k]), cues.ticketIn)
        if (appear <= 0) continue
        const a = easeTo(k, alphaOf(k)[0])
        const d = dropOf ? dropOf(k) : null
        const p = d ?? at(k, phi)
        T.x[c] = p.x
        T.y[c] = p.y
        T.r[c] = r0 * (0.55 + 0.45 * appear)
        T.alpha[c] = a * appear * wheelA
        T.sq[c] = d ? Math.abs(d.sq) : 1
        T.rot[c] = d ? d.rot : 0
        c++
      }
      T.count = c
      T.trailsUnder = fitted.dot > TRAILS_UNDER_PX
      f.tickets = T
    }

    /* JOLLITY: your friends' tickets, a colour each: marked as yours is, from when the tickets
       come on. Before yours, so where two meet yours is on top */
    if (ok && !before && s >= cues.ticketsAt) {
      for (const fr of friendsNow()) {
        if (end?.gone?.has(fr.k)) continue
        const appear = ramp(s, ticketAt(cues, ticketD[fr.k]), cues.ticketIn)
        if (appear <= 0) continue
        const p = (end?.dropOf ? end.dropOf(fr.k) : null) ?? at(fr.k, phi)
        const r = markR()
        f.markers.push({ x: p.x, y: p.y, r, colour: fr.colour, a: appear * wheelA * Math.max(0.6, tA[fr.k] > 0 ? tA[fr.k] : 1), ringR: ringOf(r), ringColour: fr.colour, ringA: ringsLeft, onWheel: true })
      }
    }
    /* yours: the coin on its way back, then your ticket on the wheel —
       the coin lands at the ticket's own place and speed, so they are one */
    let youAt = null
    if (mine >= 0 && ok && !before && !(hideCoin && s < cues.seat) && !(flip && s < cues.drop)) { // JOLLITY: a spectator has no coin, ticket or arrow
      const o = orbitNow(cues)
      const mineA = end ? end.mineAlpha : 1
      // the solid coin is it until then — flipped, all the way down while it is up (frozen with ?at=, there is no solid coin: the disc it is)
      const visible = flip ? (introUp ? 0 : 1) : s >= cues.handoff ? 1 : 0
      const colour = youColour()
      const ringColour = colour
      let p
      let r
      let a
      if (s < cues.seat) {
        p = o.at(s)
        r = p.r
        a = ramp(s, cues.ring.at, cues.ring.dur) * (flip ? 1 : visible) // under the solid coin until the hand-off, then on (flipped: behind it all the way down)
        tA[mine] = 1 // the coin is all there: from the landing it eases to its state's
      } else {
        p = at(mine, phi)
        r = markR()
        a = mineA * wheelA
      }
      if (SLIT.trail && a > 0.002) {
        const n = traceYou(s, cues, o, turning, bufs[0], zin.raw)
        if (n > 1) f.trails.push({ ...bufs[0], n, head: rgbOf(colour), a })
      }
      const ringR = ringOf(r)
      if (s < cues.seat) f.markers.push({ x: p.x, y: p.y, r, colour, a: visible, ringR, ringColour, ringA: (SLIT.rings ? 1 : 0) * visible })
      else {
        f.markers.push({ x: p.x, y: p.y, r, colour, a: mineA * wheelA * easeTo(mine, alphaOf(mine)[0]), ringR, ringColour, ringA: ringsLeft, onWheel: true })
        // the fall's coin wears your ring once it is back on your slot — if you wear one at all (the rings toggle)
        if (SLIT.rings && end && mineA <= 0 && end.mineRing > 0) f.markers.push({ x: p.x, y: p.y, r: 0, colour, a: end.mineRing, ringR, ringColour, ringA: 1 })
      }
      youAt = s < cues.seat ? { x: p.x, y: p.y, r } : onScreen(p)

      /* the arrow to yours, zoomed in */
      const arrowA = clamp01(zin.raw / ARROW_IN) * clamp01((zoomKeep * zKeep - 0.9) / 0.1) * wheelA
      if (arrowA > 0 && s >= cues.seat) {
        const mineArrow = SLIT.edgeArrow ? arrowTo(mine, phi, arrowA * mineA, SLIT.arrowColour) : null
        if (mineArrow) f.arrows.push(mineArrow)
      }
    }

    /* THE LIT ONE: a black disc and a white ring round it, a
       line up to its name — as much of them as it has come up from unlitA
       to litA. Yours, while a loss's coin flips on it (the GL's, under this
       canvas), keeps its ring and line but not the disc or the ticket over
       it; once it has landed back, the ticket is drawn over it again, in your
       colour at full. Not once the fall has it (Continue), nor a confetti'd
       ticket */
    const dropped = lit >= 0 && lit !== mine ? end?.dropOf?.(lit) : null
    if (SLIT.select && lit >= 0 && ok && !before && s >= cues.seat && !end?.gone?.has(lit) && !(dropped && Math.abs(dropped.sq) < 0.999) && !(lit === mine && continued)) {
      const span = SLIT.litA - SLIT.unlitA
      const u = Math.abs(span) > 0.01 ? clamp01((tA[lit] - SLIT.unlitA) / span) : 1
      const you = lit === mine
      const backDown = ending?.kind === 'lost' && !!ending.begun && ending.e >= ending.lossMarks.flipEnd - 1e-6 // the loss's coin has flipped and lies on your slot again
      const shown = you && end ? Math.max(end.mineAlpha, backDown ? 1 : 0) : 1
      const a = u * wheelA
      if (a > 0.002) {
        const p = dropped ?? at(lit, phi)
        const r = you ? markR() : fitted.dot / 2
        f.select = { x: p.x, y: p.y, r, ringR: r + SLIT.selectGapPx / zm.s, w: SLIT.selectLinePx, a, discA: a * shown, colour: you ? youColour() : SLIT.ticketColour, ticketA: tA[lit] * wheelA * shown, under: null, lineTop: SLIT.selectLine ? SLIT.namesY + LINE_FROM_NAME : null }
      }
    }

    /* ── the DOM: who's playing, Not this time, Continue, the timeline ── */
    setVar('--slit-names-y', String(SLIT.namesY))
    // JOLLITY: the friends' row, from just after your coin is down until who's playing takes the line
    const friendsFrom = cues.seat + Math.max(0, SLIT.friendsAfterSeatMs ?? 0) / 1000
    const friendsTo = ok && !before && s >= friendsFrom && friendsNow().length > 0 && !(pl && (opened || wk.phase !== 'off')) && !ending?.prizeUp ? 1 : 0 // JOLLITY: only once a friend is found among the entrants
    friendsVisit = -1 // the friend the full row is at this frame (friendsRow 'all', below)
    friendsLineK = -1 // …and the ticket a friends' line comes down to
    friendsA += (friendsTo - friendsA) * (1 - Math.exp(-dt / 0.15))
    setVar('--jollity-friends', friendsA.toFixed(3))
    // JOLLITY: no friend among the entrants: an invitation on their line over the same stretch (chainDraw.invite,
    // #jollity-invite); a friend found later takes the line back
    const inviteTo = chainDraw?.invite && ok && !before && s >= friendsFrom && friendsNow().length === 0 && !(pl && (opened || wk.phase !== 'off')) && !ending?.prizeUp ? 1 : 0
    inviteA += (inviteTo - inviteA) * (1 - Math.exp(-dt / 0.15))
    setVar('--jollity-invite', inviteA.toFixed(3))
    legend.stage(Wn(), view.scale)
    if (pl && (opened || wk.phase !== 'off')) {
      /* the row: slid — the short way round its ring — so the lit name is
         over its ticket (before the walk, over the first one lit; nobody
         lit, where it is), each name in as the plan says — all of them, once
         it has opened — at its state's alpha */
      const to = focus >= 0 ? rowXFor(legend.box(row.indexOf(focus), view.scale), { x: onScreen(at(focus, phi)).x, r: (focus === mine ? markR() : fitted.dot / 2) * zm.s }, Wn()) : opened ? rowX : pl.x0
      const target = nearestTurn(to, rowX, legend.span)
      const slide = SLIT.nameSlideMs > 0 ? 1 - Math.exp((-dt * 1000 * 4) / SLIT.nameSlideMs) : 1
      rowX += (target - rowX) * slide
      for (let i = 0; i < row.length; i++) {
        const k = row[i]
        nIn[i] = opened || friendsSeen ? 1 : nameIn(pl, i, ts) // JOLLITY: up already for your friends: in
        const [, na0] = alphaOf(k)
        const na = friendsSeen && isFriend(k) ? Math.max(na0, SLIT.friendNameA ?? 0.6) : na0 // JOLLITY: your friends stay highlighted
        nA[i] = nIn[i] < 1 ? na : nA[i] + (na - nA[i]) * easeA
      }
    } else if (SLIT.friendsRow === 'all' && pl && friendsNow().length && friendsA > 0.002) {
      // JOLLITY: your friends on who's playing's own row, before the stop (friendsRow)
      const frs = friendsNow()
      const step = Math.floor(Math.max(0, s - friendsFrom) / Math.max(0.2, (SLIT.friendCycleMs ?? 1200) / 1000))
      const vk = step < frs.length && !(running && spinT0 != null) ? frs[step].k : -1
      const ri = vk >= 0 ? row.indexOf(vk) : -1
      const to = ri >= 0 ? rowXFor(legend.box(ri, view.scale), { x: onScreen(at(vk, phi)).x, r: markR() * zm.s }, Wn()) : rowX
      if (!friendsSeen) rowX = to
      friendsSeen = true
      const slide = SLIT.nameSlideMs > 0 ? 1 - Math.exp((-dt * 1000 * 4) / SLIT.nameSlideMs) : 1
      rowX += (nearestTurn(to, rowX, legend.span) - rowX) * slide
      friendsVisit = ri >= 0 ? vk : -1
      friendsVisitTo = to
      const easeN = 1 - Math.exp(-dt / 0.14)
      for (let i = 0; i < row.length; i++) {
        const k = row[i]
        nIn[i] = friendsA
        nA[i] += ((k === vk ? SLIT.nameLitA : isFriend(k) ? SLIT.friendNameA ?? 0.6 : SLIT.nameA) - nA[i]) * easeN
      }
    } else {
      nIn.fill(0)
      if (pl) rowX = pl.x0
    }
    const litI = f.select ? row.indexOf(lit) : -1
    /* a loss's fall has the stage (Continue pressed): the people playing step back — all but the lit one */
    fellA += ((ending?.kind === 'lost' && continued ? FELL_NAMES_A : 1) - fellA) * (1 - Math.exp(-dt / 0.1))
    if (nShow.length !== nA.length) nShow = new Float32Array(nA.length)
    for (let i = 0; i < nA.length; i++) nShow[i] = i === litI ? nA[i] : nA[i] * fellA
    legend.frame(rowX, view.scale, nIn, nShow)
    legend.lit(SLIT.nameUnderline ? litI : -1)
    // the line only once its name is over it (the row slides there), and the name is on
    if (f.select?.lineTop != null) {
      const l = litI >= 0 ? legend.leftOf(litI, rowX) : 0
      const w = litI >= 0 ? legend.box(litI, view.scale)[1] : 0
      const x = zm.s * f.select.x + zm.tx
      if (litI < 0 || nIn[litI] < 0.99 || x < l - 2 || x > l + w + 2) f.select.lineTop = null
      else if (SLIT.nameUnderline) f.select.under = { x0: l, x1: l + w } // the underline, the canvas's: one path with the line, no gap at the corner
    }
    /* the line draws over lineDrawMs, whole (no fade): down from the
       underline (the walk's, a name tapped), or up from the ticket to it (a
       ticket tapped) — and goes at once, the moment its ticket is no longer lit */
    const lineOn = f.select?.lineTop != null ? lit : -1
    if (lineOn !== lineFor) {
      lineFor = lineOn
      lineT0 = loop.time
    }
    if (f.select && lineOn >= 0) {
      f.select.drawn = SLIT.lineDrawMs > 0 ? clamp01((loop.time - lineT0) / (SLIT.lineDrawMs / 1000)) : 1
      f.select.up = tapped >= 0 && lineOn === tapped && tapFrom === 'ticket' // a ticket tapped: up from it to its name
    }

    /* JOLLITY: friendsRow 'ticker': EVERY NAME round the wheel (chainDraw.ticker, lib/draw/wheel/name-ticker.ts),
       from just after your coin is down: it rests on you, then scrolls fast through everyone in between to each
       friend in turn (round the wheel, clockwise), each landing over its ticket, lit, the line down to it; then
       it stays where it is through the spin, until who's playing takes the line */
    if (chainDraw?.ticker) {
      const tk = chainDraw.ticker
      if (SLIT.friendsRow === 'ticker' && friendsA > 0.002 && layout && ring) {
        const order = tickOrderNow()
        const n = order.length
        const P = tk.pitch
        const stops = tickStopsNow()
        tickStopsHeld = true
        const M = stops.length
        const firstS = Math.max(0.1, (SLIT.tickFirstMs ?? 1000) / 1000)
        const scrollS = Math.max(0.1, (SLIT.tickScrollMs ?? 600) / 1000)
        const holdS = Math.max(0.1, (SLIT.tickHoldMs ?? 750) / 1000)
        const u = Math.max(0, s - friendsFrom)
        let m = 0
        let v = 1
        let held = u
        if (u >= firstS && M > 1) {
          const w = u - firstS
          const seg = Math.floor(w / (scrollS + holdS)) + 1
          if (seg >= M) {
            m = M - 1
            held = holdS + (w - (M - 1) * (scrollS + holdS))
          } else {
            m = seg
            const r = w - (seg - 1) * (scrollS + holdS)
            v = r < scrollS ? r / scrollS : 1
            held = r - scrollS
          }
        }
        const done = M === 0 || u >= firstS + (M - 1) * (scrollS + holdS)
        // a stop's offset: its name's middle over its ticket, kept off the stage's edges
        const xOf = (st) => {
          const tx = onScreen(at(st.k, phi)).x
          return Math.max(24 + P / 2 - 12, Math.min(Wn() - 24 - P / 2 + 12, tx)) - (st.j * P + P / 2)
        }
        const quint = (q) => (q < 0.5 ? 16 * q ** 5 : 1 - (-2 * q + 2) ** 5 / 2)
        if (M && (!done || tickX == null)) tickX = v >= 1 ? xOf(stops[m]) : xOf(stops[m - 1]) + (xOf(stops[m]) - xOf(stops[m - 1])) * quint(v)
        const litK = M && !done && v >= 1 ? stops[m].k : -1
        const litU = clamp01(held / 0.18)
        const fa = SLIT.friendNameA ?? 0.6
        tk.frame({
          x: tickX ?? 0,
          scale: view.scale,
          width: Wn(),
          alpha: friendsA,
          count: n,
          nameAt: (i) => whoOf(order[i]),
          shownAt: (j) => {
            const k = order[((j % n) + n) % n]
            const marked = k === mine || isFriend(k)
            return k === litK ? fa + (SLIT.nameLitA - fa) * litU : marked ? fa : SLIT.nameA
          },
        })
        // the line down to the one it rests on, once it has landed
        if (litK >= 0 && !f.select && SLIT.select && held > 0.12) {
          const a = friendsA * litU * wheelA
          const p = at(litK, phi)
          const r = markR()
          const colour = litK === mine ? youColour() : (friendsNow().find((fr) => fr.k === litK)?.colour ?? SLIT.ticketColour)
          f.select = { x: p.x, y: p.y, r, ringR: r + SLIT.selectGapPx / zm.s, w: SLIT.selectLinePx, a, discA: a, colour, ticketA: a, under: null, lineTop: null, up: false }
          const box = tk.boxAt(stops[m].j)
          if (box && SLIT.selectLine) {
            const x = zm.s * p.x + zm.tx
            f.select.lineTop = SLIT.namesY + LINE_FROM_NAME
            if (SLIT.nameUnderline) f.select.under = { x0: Math.min(box[0], x), x1: Math.max(box[0] + box[1], x) }
            friendsLineK = litK
          }
        }
      } else {
        tk.frame({ x: 0, scale: view.scale, width: Wn(), alpha: 0, count: 0, nameAt: () => ({ name: '' }), shownAt: () => 0 })
        if (friendsTo === 0) tickX = null
      }
    }
    /* JOLLITY: friendsRow 'all': the line down to the friend who's playing is at, once its name is over its ticket, as the walk's */
    if (friendsVisit >= 0 && !f.select && SLIT.select) {
      const k = friendsVisit
      const ri = row.indexOf(k)
      const litU = clamp01((nA[ri] - (SLIT.friendNameA ?? 0.6)) / Math.max(0.01, SLIT.nameLitA - (SLIT.friendNameA ?? 0.6)))
      const a = friendsA * litU * wheelA
      if (a > 0.002) {
        const p = at(k, phi)
        const r = markR()
        f.select = { x: p.x, y: p.y, r, ringR: r + SLIT.selectGapPx / zm.s, w: SLIT.selectLinePx, a, discA: a, colour: friendsNow().find((fr) => fr.k === k)?.colour ?? SLIT.ticketColour, ticketA: a, under: null, lineTop: null, up: false }
        const l = legend.leftOf(ri, rowX)
        const w = legend.box(ri, view.scale)[1]
        const x = zm.s * p.x + zm.tx
        if (SLIT.selectLine && Math.abs(nearestTurn(friendsVisitTo, rowX, legend.span) - rowX) < 0.5 && x >= l - 2 && x <= l + w + 2) {
          f.select.lineTop = SLIT.namesY + LINE_FROM_NAME
          if (SLIT.nameUnderline) f.select.under = { x0: l, x1: l + w }
          friendsLineK = k
        }
      }
    }
    /* JOLLITY: YOUR FRIENDS' ROW (see createLegend above), once your coin is down: name by name, left to right,
       each lit friendCycleMs, its name easing up, the line from it along under the row and down to its ticket.
       The row stands still where they all fit; else it eases on one name at a time, the lit one in the middle,
       its ends kept in. Past the last, all of them, nobody lit, and the row stays where it is: the spin follows */
    const frs = friendsNow()
    friendsLegend.stage(Wn(), view.scale)
    if ((SLIT.friendsRow ?? 'friends') === 'friends' && frs.length && friendsA > 0.002) {
      friendsLegend.set(frs.map((fr) => whoOf(fr.k)))
      const n = frs.length
      const cycle = Math.max(0.2, (SLIT.friendCycleMs ?? 1200) / 1000)
      const step = Math.floor(Math.max(0, s - friendsFrom) / cycle)
      const i = step < n ? step : -1
      const [l0] = friendsLegend.box(0, view.scale)
      const [ln, wn] = friendsLegend.box(n - 1, view.scale)
      const [lf, wf] = friendsLegend.box(i >= 0 ? i : n - 1, view.scale)
      const side = 24 // names.js's SIDE: a name no nearer the stage's edge
      const to = ln + wn - l0 <= Wn() - 2 * side ? (Wn() - (ln + wn - l0)) / 2 - l0 : Math.min(side - l0, Math.max(Wn() - side - (ln + wn), Wn() / 2 - (lf + wf / 2)))
      const slide = SLIT.nameSlideMs > 0 ? 1 - Math.exp((-dt * 1000 * 4) / SLIT.nameSlideMs) : 1
      friendsX = friendsPlaced ? friendsX + (to - friendsX) * slide : to
      friendsPlaced = true
      if (friendsNA.length !== n) friendsNA = new Float32Array(n).fill(SLIT.nameA)
      const easeN = 1 - Math.exp(-dt / 0.14)
      for (let j = 0; j < n; j++) friendsNA[j] += ((i < 0 || j === i ? SLIT.nameLitA : SLIT.nameA) - friendsNA[j]) * easeN
      friendsLegend.frame(friendsX, view.scale, frs.map(() => 1), friendsNA)
      friendsLegend.lit(SLIT.nameUnderline && i >= 0 ? i : -1)
      if (i >= 0 && !f.select && SLIT.select && !(running && spinT0 != null)) {
        const k = frs[i].k
        const litU = clamp01((friendsNA[i] - SLIT.nameA) / Math.max(0.01, SLIT.nameLitA - SLIT.nameA))
        const a = friendsA * litU * wheelA
        if (a > 0.002) {
          const p = at(k, phi)
          const r = markR()
          f.select = { x: p.x, y: p.y, r, ringR: r + SLIT.selectGapPx / zm.s, w: SLIT.selectLinePx, a, discA: a, colour: frs[i].colour, ticketA: a, under: null, lineTop: null, up: false }
          // the line once the row is still: from the name, along under the row to over its ticket, and down
          if (SLIT.selectLine && Math.abs(to - friendsX) < 0.5) {
            const l = friendsLegend.leftOf(i, friendsX)
            const w = friendsLegend.box(i, view.scale)[1]
            const x = zm.s * p.x + zm.tx
            f.select.lineTop = SLIT.namesY + LINE_FROM_NAME
            if (SLIT.nameUnderline) f.select.under = { x0: Math.min(l, x), x1: Math.max(l + w, x) }
            friendsLineK = k
          }
        }
      }
    } else if (friendsTo === 0 && friendsA <= 0.002) friendsPlaced = false
    // JOLLITY: a friends' line (either row) draws down over friendLineDrawMs from the moment it may
    if (friendsLineK !== friendsLineFor) {
      friendsLineFor = friendsLineK
      friendsLineT0 = loop.time
    }
    if (friendsLineK >= 0 && f.select) f.select.drawn = clamp01((loop.time - friendsLineT0) / Math.max(0.05, (SLIT.friendLineDrawMs ?? 300) / 1000))
    legend.live(tappable())
    /* a loss: Not this time over the row once your coin's flip is over (and it stays through the fall) */
    const lost = ending?.kind === 'lost'
    const flipped = lost && !!ending.begun && ending.e >= ending.lossMarks.flipEnd - 1e-6
    headA += ((flipped ? 1 : 0) - headA) * (1 - Math.exp(-dt / 0.14))
    if (lossEl.textContent !== FLOW.lostHeadline) lossEl.textContent = FLOW.lostHeadline
    setVar('--slit-loss-y', String(SLIT.lossHeadY))
    lossEl.style.setProperty('--in', headA.toFixed(2))
    setVar('--slit-bar', (before || !ok ? 0 : ramp(s, cues.bar.at, cues.bar.dur)).toFixed(2))
    if (ph && !scrubbing) {
      const v = sliderValue()
      ph.value = v.toFixed(3)
      setVar('--slit-p', v.toFixed(3))
    } else if (ph) setVar('--slit-p', clamp01(parseFloat(ph.value)).toFixed(3))
    /* CONTINUE: the timeline grows into it once you are lit — the line
       swelling to the pill over pillGrowsMs, filling white as it goes, its
       word fading in once it is pillLettersFromPx tall — and stays it: what
       it is filled to is where the draw is. Gone once a loss's fall starts;
       over Back to the wheel while the prize is up */
    // a loss: once your coin has flipped; a win: just before Back to the wheel (or once back on the wheel); no ending: at once
    const won = ending?.kind === 'won'
    const nearBack = won && !!ending.begun && (ending.dismissed || ending.e >= ending.backShowAt - SLIT.continueBeforeBackMs / 1000)
    if (free && !pillOn && (lost ? flipped : won ? nearBack : true)) {
      pillOn = true
      pillT0 = loop.time
    }
    app.classList.toggle('slit-pill', pillOn)
    showContinue(pillOn && !(lost && continued))
    if (pillOn) {
      const u = SLIT.pillGrowsMs > 0 ? smooth((loop.time - pillT0) / (SLIT.pillGrowsMs / 1000)) : 1
      const h = 3 + (PILL_H - 3) * u
      const v = clamp01(parseFloat(ph?.value ?? '1'))
      const from = Math.min(PILL_H - 1, SLIT.pillLettersFromPx)
      const backEl = document.getElementById('flow-back')
      let y = BAR_Y
      // the prize up: over where Back to the wheel is (or comes), so it is clear of it before it shows
      if (backEl && (ending?.prizeUp || backEl.classList.contains('is-shown'))) y =(backEl.getBoundingClientRect().top - app.getBoundingClientRect().top) / view.scale - 8 - PILL_H / 2
      setVar('--slit-pill-y', y.toFixed(1))
      setVar('--slit-pill-h', h.toFixed(2))
      setVar('--slit-pill-fill', `${((u < 1 ? v + (1 - v) * u : v) * 100).toFixed(2)}%`)
      setVar('--slit-pill-letters', smooth((h - from) / (PILL_H - from)).toFixed(3))
    }

    /* ── paint, then the GL over or under it ── */
    /* the flip's coin leaves the screen: its GL reaches past the stage while it is up, and the stage stops clipping */
    if (flip && gl) {
      const m = escapePx()
      if (m !== gl.margin) gl.resize()
      app.classList.toggle('flip-escape', m > 0)
    }
    const glUp = introUp || !!end?.glUp
    if (gl) showGl(glUp)
    if (introUp) {
      size(underEl)
      painter.under(gu, view, f)
      underShown = true
    } else if (underShown) {
      painter.clearUnder(gu)
      size(underEl, false) // its pixels go with the intro
      underShown = false
    }
    painter.main(g, view, f)
    painter.arrows(ga, view, f, placeArrows())
    lastF = {
      m,
      s,
      slitA,
      heat,
      shade: f.shade,
      you: youAt,
      zoom: { ...zm },
      circle: f.circle && { ...f.circle },
      disc: f.disc && { ...f.disc },
      bowl: f.bowl && { R: f.bowl.R, alpha: f.bowl.alpha, c: { ...f.bowl.c }, straight: f.bowl.straight },
      trails: f.trails.map((t) => ({ a: t.a, n: t.n, head: [t.pts[0], t.pts[1]] })),
      arrows: f.arrows.map((a) => ({ ...a })),
      visibleH: visibleH(),
      wedge: f.wedge && { reveal: f.wedge.reveal, vis: f.wedge.vis, reach: f.wedge.reach },
      winnerA: f.winner?.a ?? 0,
      // the lit one's ring: on the wheel, how much of it, and where its line starts (null: none)
      select: f.select && { x: f.select.x, y: f.select.y, ringR: f.select.ringR, a: f.select.a, lineTop: f.select.lineTop, under: f.select.under, drawn: f.select.drawn ?? 0 },
      // who's playing: the walk's phase, who is lit, the seconds from the stop
      walk: { phase: wk.phase, focus, t: ts, tapped },
      // the flip page's opening: its words' alpha, its trail's samples, the way the coin went
      flip: flip ? { words: f.flipWords?.a ?? 0, outTrail: f.outTrail?.n ?? 0, how: howNow(), circle: f.circle?.a ?? 0, disc: f.disc?.R > 0 ? f.disc.a : 0 } : null,
    }
    painted++
    if (introUp) gl.render(dt)
    else if (end?.glUp) ending.render(dt) // after the paint: the backdrop is this frame's page
  }

  return {
    frame,
    restart: () => slitActions.toCoin(),
    /* lets go of what the page took: the window's resize, the intro's and the
       ending's own (their coins, their listeners), the stage's GL, and the
       actions the panel calls, which would otherwise keep this page alive */
    dispose() {
      removeEventListener('resize', fit)
      intro?.dispose()
      ending?.dispose()
      gl?.composer.dispose()
      gl?.renderer.dispose()
      for (const k of Object.keys(slitActions)) delete slitActions[k]
    },
    /* JOLLITY: names that came after the row was built, put in (lib/draw/wheel/mount.ts) */
    names: { refresh: () => void (row.length && legend.set(row.map(whoOf))) },
    /* JOLLITY: the ticker's visit has begun, its stops held: a friend found after is marked, not visited,
       so the page stops lengthening the stand for them (lib/draw/wheel/mount.ts) */
    friendsHeld: () => tickStopsHeld,
    /* JOLLITY: the timeline, in the page's hand (lib/draw/wheel/explore.ts): where the draw is
       along the spin (0..1), and a drag along it, as the pill's own. Once the coin is down; let go,
       the spin plays on from there */
    timeline: {
      at: () => sliderValue(),
      started: () => spinT0 != null,
      scrub(v) {
        if (!touchable()) return false
        if (ending?.kind === 'won' && ending.begun) wonShown = true
        tapped = -1 // a hand on the timeline: nobody is lit
        scrubbing = true
        scrubbedOut = true
        running = false
        // never the very end, where the ending would begin from: the spin's own stop begins it
        scrubAt = clamp01(v)
        const at = Math.min(scrubAt, 0.9995)
        if (ph) ph.value = at.toFixed(3)
        seek(at)
        return true
      },
      release() {
        if (!scrubbing) return
        scrubbing = false
        // let go at the very end: the spin lands, its stop, the walk and the ending's end; elsewhere it stays where it was let go (pauseOnSlider)
        if (scrubAt >= 0.999 && landing && spinT0 != null && phase < 1 && !running) {
          spinT0 = loop.time - warp.realAt(phase * landing.durS)
          running = true
        } else resume()
      },
      // moving by itself: a hand on it, the spin running, or stopped and still being walked through (paused mid-spin is still)
      busy: () => scrubbing || running || (!settledNow && !(spinT0 != null && phase < 1)),
    },
    debug: () => ({
      slit: {
        get intro() {
          return intro ?? introLast
        },
        /* the prize's coin, built while the intro's floated: whether it has
           brought up its maps and studio, and each step's main-thread ms */
        get upload() {
          return { done: uploaded, steps: [...uploads] }
        },
        /* the GL's window onto the stage (gl.js): where, how big, and how
           often a coin spilled out of it */
        get window() {
          return gl?.window ?? null
        },
        get ready() {
          return ready()
        },
        get painted() {
          return painted
        },
        get s() {
          return seqS()
        },
        get cues() {
          return cuesNow()
        },
        get phase() {
          return phase
        },
        get spun() {
          return spinT0 != null
        },
        /* when the spin started, s on the story's clock (null: not yet) */
        get spinAtS() {
          return spinT0 != null && seqT0 != null ? spinT0 - seqT0 : null
        },
        get landed() {
          return ready() && spinT0 != null && phase >= 1
        },
        get n() {
          return layout?.n ?? 0
        },
        get winners() {
          return winnersNow()
        },
        get loserAlpha() {
          return SLIT.loserA
        },
        get rim() {
          return rim
        },
        get dot() {
          return fitted?.dot ?? 0
        },
        get mine() {
          return mine
        },
        get won() {
          return wonSlot(mine)
        },
        get drawNo() {
          return drawNo
        },
        get seed() {
          return seed
        },
        /* the wedge (fixed) and where the winners are in it, nominal px, unzoomed */
        get wedge() {
          if (!wedge || !ranks) return null
          const w = winnersNow()
          const H = hub()
          const pts = Array.from({ length: w }, (_, i) => {
            const k = (ranks.cut + i) % layout.n
            const p = at(k, restPhi)
            return { x: p.x, y: p.y, rho: Math.hypot(p.x - H.x, p.y - H.y), a: Math.atan2(H.y - p.y, p.x - H.x) }
          })
          return { ...wedge, winners: pts, ballR: fitted.dot / 2, pad: SLIT.wedgePadPx }
        },
        /* the wedge's box as it is drawn now (through the zoom), nominal px */
        get wedgeOnScreen() {
          if (!box) return null
          const H = hub()
          return { x0: zm.s * box.x0 + zm.tx, y0: zm.s * box.y0 + zm.ty, x1: zm.s * box.x1 + zm.tx, y1: zm.s * box.y1 + zm.ty, labelX: zm.s * H.x + zm.tx, labelY: zm.s * H.y + zm.ty }
        },
        get band() {
          return band()
        },
        get stage() {
          return { W: Wn(), H: Hn(), scale: view.scale }
        },
        get frame() {
          return lastF
        },
        get hand() {
          return hand
        },
        /* where the coin lands, and how fast its ticket is going then */
        get seat() {
          return ready() ? seatAt(cuesNow()) : null
        },
        get legend() {
          return legend.debug()
        },
        get ending() {
          return ending ? ending.debug() : null
        },
        get end() {
          return lastEnd
        },
        /* the panel's buttons, for the suite: toCoin, toWheel, toOutcome, newSeed */
        actions: slitActions,
        /* the coin and its trail off (until it lands), so the bowl can be read back alone */
        hideCoin: (v) => (hideCoin = !!v),
        /* the coin's path and the bowl, as the painter draws them */
        orbitAt: (s) => orbitNow()?.at(s) ?? null,
        /* your ticket on the wheel at sequence time s — where the coin must be when it lands */
        ticketAt: (s) => {
          if (!ready()) return null
          const c = cuesNow()
          const turning = s - c.spin
          const phi = turning > 0 ? motionAngleAt(landing, warp.tau(turning)) : phi0
          return at(mine, phi)
        },
        bowlAt: (m) => bowlAt({ m, cx: Wn() / 2, slitY: slitY(), hubY: SLIT.hubY, L0: SLIT.slitLengthPx, R0: SLIT.slitCirclePx }),
        /* how many ticket centres are under the wedge with the wheel at phi — the same
           test that lights them as it spins; and which, at rest, for the winners' check */
        underWedgeAt: (phi) => {
          if (!wedge || !layout) return null
          const k0 = underFrom(phi)
          let c = 0
          for (let k = 0; k < layout.n; k++) if (isUnder(k, k0)) c++
          return c
        },
        get restPhi() {
          return restPhi
        },
        underAtRestAreWinners: () => {
          if (!wedge || !layout) return null
          const k0 = underFrom(restPhi)
          for (let k = 0; k < layout.n; k++) if (isUnder(k, k0) !== wonSlot(k)) return false
          return true
        },
        /* …and that the run counted is the one the wedge covers: every slot in it has its centre in the slice */
        underInSlice: (phi) => {
          if (!wedge || !layout) return null
          const k0 = underFrom(phi)
          let worst = 0
          for (let k = 0; k < layout.n; k++) if (isUnder(k, k0)) worst = Math.max(worst, Math.abs(signed(layout.angleAt(k, phi) - WEDGE)) - wedge.half)
          return worst
        },
        /* every ticket's alpha as painted (before the batching), for the suite */
        ticketAlphas: () => Array.from(T.alpha.subarray(0, T.count)),
        /* WHO'S PLAYING: the row (slots, left to right), the walk's plan, and each
           name's ticket on the stage now (nominal px, through the zoom) */
        get names() {
          if (!row.length) return null
          const phi = phiNow()
          return {
            row: row.slice(),
            steps: plan ? plan.steps.slice() : null,
            nameAt: plan ? Array.from(plan.nameAt) : null,
            start: plan?.start ?? null,
            end: plan?.end ?? null,
            tickets: row.map((k) => ({ k, ...onScreen(at(k, phi)), r: (k === mine ? markR() : fitted.dot / 2) * zm.s, won: wonSlot(k) })),
            alpha: row.map((k) => tA[k]),
            ...legend.debug(),
          }
        },
        /* a tap on the stage, nominal px: the slot it took (−1: you) — or null if the wheel takes none now */
        /* JOLLITY: every ticket where the stage draws it now (nominal px, through the zoom), whose it
           is, and the player's own zoom over the stage's (lib/draw/wheel/explore.ts) */
        ticketsNow: () => {
          if (!layout || !ring) return null
          const phi = phiNow()
          const out = []
          for (let k = 0; k < layout.n; k++) out.push({ k, ...onScreen(at(k, phi)), r: (k === mine ? markR() : fitted.dot / 2) * zm.s, won: wonSlot(k), you: k === mine })
          return out
        },
        whoIs: (k) => (layout && ring && k >= 0 && k < layout.n ? whoOf(k) : null),
        userView,
        get viewScale() {
          return view.scale
        },
        /* JOLLITY: a ticket picked on the page, any of them: lit on the row, as a tapped one is (−1: nobody) */
        pick: (k) => {
          if (!tappable() || !layout || !ring) return false
          if (k < 0 || k >= layout.n) {
            tapped = NOBODY
            return true
          }
          joinRow(k)
          tapped = k
          tapFrom = 'ticket'
          return true
        },
        tap: (x, y) => (tappable() ? tapAt(x, y) : null),
        get tappable() {
          return tappable()
        },
        get continue() {
          const r = contEl.getBoundingClientRect()
          const a = app.getBoundingClientRect()
          const cs = getComputedStyle(contEl.querySelector('span'))
          return {
            shown: !!contShown,
            pill: pillOn,
            top: (r.top - a.top) / view.scale,
            bottom: (r.bottom - a.top) / view.scale,
            height: r.height / view.scale,
            letters: parseFloat(cs.opacity),
            continued,
            home: homeAt > 0,
            lossIn: parseFloat(lossEl.style.getPropertyValue('--in')) || 0,
          }
        },
        pressContinue: () => contEl.click(),
        /* a drag along Continue to v (0..1): the timeline's, as a finger's would be */
        dragContinue: (v) => {
          const r = contEl.getBoundingClientRect()
          const y = r.top + r.height / 2
          const ev = (t, x) => contEl.dispatchEvent(new PointerEvent(t, { bubbles: true, pointerId: 7, clientX: x, clientY: y }))
          ev('pointerdown', r.left + r.width - 2)
          ev('pointermove', r.left + r.width * v + 0.5)
          ev('pointerup', r.left + r.width * v + 0.5)
          contEl.click() // the click a real let-go makes: a drag's is swallowed
        },
        get opened() {
          return opened
        },
        /* the page's table, live — the suite slows the walk down with it, as the panel would */
        config: SLIT,
        /* every ticket but yours, in the order it comes on: { k, at (s, when it starts), angle round from yours (rad, 0..2π) } */
        ticketOrder: () => {
          if (!ready() || !ticketD) return null
          const c = cuesNow()
          const out = []
          for (let k = 0; k < layout.n; k++) if (k !== mine) out.push({ k, at: ticketAt(c, ticketD[k]), angle: (((layout.theta[k] - layout.theta[mine]) % TAU) + TAU) % TAU })
          return out.sort((a, b) => a.at - b.at)
        },
      },
    }),
  }
}

export const scene = {
  id: 'wheel.slit',
  title: 'The draw, through the slit',
  blurb: 'the full flow, flat — the coin into a slit that bends into the wheel’s circle, the coin back round onto its seat, the wedge, the spin; the win or the loss on a toggle',
  href: 'sphere.html?scene=slit',
  sceneParam: 'slit',
  store: 'jollity-slit',
  params: slitParams,
  create: (ctx) => createSlit(ctx),
}
