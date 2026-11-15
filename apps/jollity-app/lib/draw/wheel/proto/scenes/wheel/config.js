// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE WHEEL's own tables. Terse keys here, readable dial names in panel.js —
   applyWheel() is the seam between the two. */

import { assign, num } from '../../render-utils/dials.js'
import { PLACEMENTS, RING_POSITIONS } from './place.js'

export { PLACEMENTS, RING_POSITIONS }

export const WHEEL = {
  /* the draw — draw.js's, which is the chain's */
  n: 420, //            tickets in the draw
  winners: 6, //        how many the wedge takes
  seed: 'wheel-1', //   the ticket list: value_i = SHA256(domain || seed || i)
  entropy: 'draw-1', // what the wheel stops on: target = SHA256(domain || this)

  /* the layout — place.js */
  placement: 'rings, spread', // one of PLACEMENTS
  rings: 6, //          rings, for the ringed placement
  ringPosition: 'from edge', // one of RING_POSITIONS: packed in from the rim ringGap discs apart, or spread from the hole to the rim
  hole: 0.66, //        the hole in the middle, as a share of the rim
  across: 95, //        the wheel across, as a % of the stage's width
  fit: true, //         toggle: the disc size and the ring count follow the ticket count (place.js's fitFor)
  dotMin: 2.5, //       …the smallest a disc may get, nominal px (a crowded wheel)
  dotMax: 10, //        …the biggest (a sparse one — past this the gaps grow instead)
  dotShare: 0.5, //     …how much of the spacing between two discs a disc fills
  perRing: 70, //       …a ring for every this many tickets (50 → 1 ring, 120 → 2, 200 → 3, 420 → 6)…
  ringGap: 2, //        …but never closer together than this many of their own discs across (1–5) — and, from the edge, exactly this far apart
  dot: 5, //            with fit off: the SMALLEST disc, nominal px — the dial, uncapped
  dotGrow: 1, //        how many times bigger the disc at the rim is than the smallest
  sizeSpacing: true, //  let the disc size set the spiral's spacing, not just even area

  /* the wedge, fixed in space */
  wedgeDeg: 90, //      where it sits, degrees ccw from three o'clock (90 = the top)
  wedge: true, //       draw it at all
  /* how it is drawn (paint.js's paintWedge): a beam of light — white at the
     tip, the wheel's centre, fading out to clear white past the rim, under
     the discs, no speckle and no edge. It runs on past the outermost ring
     (wedgeReach) so the winners sit in its light, not in its fade; how wide
     it is, and so who wins, is the winners' angle alone and never its length.
     The look it used to have is fillAlpha 0.32, no gradient, no noise, a 1 px
     edge at 0.74, reach 1. */
  wedgeSpinning: 0.75, // the whole wedge's strength while the wheel spins, 0..1 — 1 is as dialled (the old look dimmed it to 0.45)
  wedgeOverDiscs: false, // toggle: drawn over the discs (on) or under them (off)
  wedgeCover: 0, //      …and over them, how much of them it hides (0: the fill alone, 1: none of them shows)
  wedgeColour: '#ffffff', // the fill's colour — at the beam's far end, with the gradient on
  wedgeAlpha: 0, //     …and its alpha (0: the beam fades out to nothing)
  wedgeGradient: true, // toggle: radial from the tip, wedgeTipColour there running out to wedgeColour at the far end
  wedgeTipColour: '#b0b0b0', // …the colour at the tip (the wheel's centre)
  wedgeTipAlpha: 1, //  …and its alpha
  wedgeReach: 1.05, //  how far the beam runs, × the outermost ring's radius — past the winners, so they are lit
  wedgeNoise: 0.32, //  speckle over the fill, 0..1 (0: none)
  wedgeNoiseColour: '#000000', // …the specks' colour
  wedgeNoisePx: 0.5, // …how big a speck is, screen px
  wedgeBorderColour: '#ffffff',
  wedgeBorderPx: 0, //  the edge's width, screen px — a hairline however far the zoom is in (0: none)
  wedgeBorderAlpha: 1, // …and its alpha
  loserAlpha: 0.2, //   a disc that did not win, once the wheel has landed
  dimMs: 300, //        …and how long it takes to get there. A constant: long
  //                    enough not to flick, short enough not to be a wait.
  spinAlpha: 0.45, //   every disc outside the wedge while it spins (and before the first go) — under the
  //                    winners' 1, over the losers' loserAlpha
  wedgeLights: true, // toggle: the discs passing under the wedge are lit while it spins — at once, as they enter
  underWedgeAlpha: 1, // …at this alpha
  wedgeFadeMs: 0, //    …easing back to spinAlpha over this once they are past it (0: at once)

  /* the spin: hold it to turn the wheel, let go and it winds down onto the
     winners. Nothing is decided until the let-go. Or, with the SPIN button
     off, it goes by itself once the coin is in (timing.js plans the whole go). */
  spinButton: false, // the cap in the middle; off, the wheel spins by itself after the coin scene
  autoSpinDelayMs: -400, // …that long after the page opens — on the flow, after the coin lands on your slot; negative, that long before it lands, so it lands on a wheel already turning
  constantSpin: false, // toggle: keep it turning as if held, to look at it in motion (off lets it land)
  holdTurnsPerS: 3, //  full speed, held or by itself
  upS: 0.65, //         seconds from standing to full speed
  spinS: 4.4, //          seconds from full speed to the dead stop (the let-go's wind-down)
  autoSpinS: 6.8, //      seconds, start to stop, for a go with no hand on it — the cruise is what is left,
  //                    and shorter than upS + spinS those two shrink to fit it
  turns: 2, //          whole extra turns on top of the let-go's coast — spectacle only
  sloMo: true, //       toggle: the end of the spin in slow motion
  sloMoAtPct: 84, //    …starting this far into the spin's own clock
  sloMoSpeed: 0.15, //  …at this speed (1 = none)

  /* the zoom onto the wedge, as the spin ends */
  zoom: true, //        toggle
  zoomX: 2.4, //        how far in
  zoomAtS: -7.6, //     when: seconds from the end of the spin (−12 … +2; negative is before it stops)
  zoomMs: 1500, //      …and how long the zoom in (and back out) takes

  /* your ticket */
  youColour: '#00ff04', // your disc, your chip, and the coin's tint as it becomes the disc
  pulse: true, //       toggle: a ring pulsing out of your disc
  pulseColour: '#00ff04',
  pulseMs: 1200, //     …once every this long
  pulsePx: 12, //       …growing this far out as it fades
  edgeArrow: true, //   toggle: zoomed in with your disc off screen, a triangle on the screen's edge points out at it
  edgeArrowFriends: true, // …and one to each friend's disc the same way, in their colour, yours on top
  edgeArrowPx: 40, //   …its long side, along the edge, nominal px (a right triangle: half that deep)
  edgeArrowCornerPx: 48, // …and it never gets nearer a bottom corner than this, nominal px…
  edgeArrowEasePx: 144, // …easing toward that (and the top) from this far before it, still moving the whole way
  rigWin: false, //     toggle: every draw is one your ticket wins (the entropy is chosen, never the seed)

  /* who's playing */
  friends: 2, //        how many of the roster are in (a third chip overruns 390 px)
  chipsTopPx: 72, //    the chips row, nominal px from the top of the stage
  colorEach: true, //   a colour each, or one colour for all of them

  /* the insert-coin scene in front of the draw — the FLOW page's
     (render-utils/coin/, flight and all).
     The wheel page itself opens straight on the wheel. */
  intro: true, //       the flow: the coin first (?intro=0 opens on the wheel)

  /* show */
  numbers: false, //    the ticket number beside each disc
  trail: false, //      the ticket order, drawn through the layout
  wake: true, //        a wake behind you and the people you are watching
  wakeS: 0.55, //       …how many seconds of travel it is long
}

/* THE WHOLE DRAW (flow/): the wheel spins by itself and ends on
   the prize or the fall. Everything the wheel draws is WHEEL's, tuned on the
   wheel's own page; the prize and the fall are PRIZE's and FALL's, tuned on
   the won and lost pages. What is here is only what the flow itself adds —
   the words and the timings the won and lost pages hold for themselves,
   copied from theirs (a scene never imports another). */
export const OUTCOMES = ['random', 'only wins', 'only lost']
export const FLOW = {
  outcome: 'random', //  one of OUTCOMES — the seed selector; a new value deals a new seed
  pauseOnSlider: false, // toggle: a hand on the slider pauses the flow where it leaves it (off: let go and it plays on)
  spinAfterMs: 700, //   the wheel on its own this long, then it goes
  /* a draw you won: the prize (render-utils/prize/) — won/config.js's words */
  prizeAfterMs: 700, //  from the landing, the zoom in by then
  wonFadeMs: 600, //     …and as it comes up, the wedge and the winners' rings fade out over this
  backAfterBurstMs: 1000, // "Back to the wheel", this long after the confetti bursts
  backCoinMs: 900, //    …and pressed, the coin flicked up and back down onto your disc over this
  backHopPx: 160, //     …this high
  backFlips: 2, //       …this many half-turns end over end (whole ones land it face-on)
  backUiFadeMs: 300, //  the rest of the win (the words, the confetti) out over this…
  backWheelInMs: 100, // …then the wheel back in over this, where the spin left it
  backLabel: 'Back to the wheel',
  wheelBehindPrize: 0.2, // the wheel's alpha under the coin
  amount: 50,
  prefix: '$', //         before the amount on the chip
  unit: 'CASH', //        under it on the coin; after it, in small caps, on the chip
  wonHeadline: 'You won',
  kicker: 'Prize Draw',
  /* a draw you lost: the zoom back out, then the fall (render-utils/fall/) —
     lost/config.js's */
  zoomOutAfterMs: 700, // from the landing
  zoomOutMs: 1500,
  lostHeadline: 'Not this time',
  keepWinners: true, //  toggle: the winners (rings and all) and the wedge stay on the wheel while the rest fall
}
export const flowActions = {}
export function applyFlow(p) {
  if (p.pauseOnSlider != null) FLOW.pauseOnSlider = !!p.pauseOnSlider
  if (p.winnersAndWedgeStay != null) FLOW.keepWinners = !!p.winnersAndWedgeStay // live: ending.js re-primes the fall
  if (p.wedgeLengthXWheel != null) WHEEL.wedgeReach = Math.max(1, Math.min(4, Number(p.wedgeLengthXWheel) || 1)) // live: the painter reads it each frame
  /* how many are playing and how many win: the same seed, a new ticket list
     of that length (or a new run of winners) — so the draw is dealt again,
     from the wheel. The same values are nothing */
  const n = p.players != null ? Math.max(2, Math.min(5000, Math.round(Number(p.players)) || WHEEL.n)) : WHEEL.n
  const w = p.winners != null ? Math.max(1, Math.min(n, Math.round(Number(p.winners)) || WHEEL.winners)) : Math.min(WHEEL.winners, n)
  if (n !== WHEEL.n || w !== WHEEL.winners) {
    WHEEL.n = n
    WHEEL.winners = w
    flowActions.resize?.()
  }
  // the seed selector: a different value is a new seed, the same one is nothing
  if (OUTCOMES.includes(p.seed) && p.seed !== FLOW.outcome) {
    FLOW.outcome = p.seed
    flowActions.newSeed?.()
  }
}
export const flowSnapshot = () => ({})
export const flowSame = () => true
export const FLOW_FOLDERS = []
export const FLOW_OPEN = new Set()

/* the wheel is monochrome; the people in it are not. Yours is the sphere's
   own green (WHEEL.youColour, a dial, starts here), and the friends take the
   rest of the family palette. */
export const YOU = '#00ff04'
export const PALETTE = ['#ff2a2a', '#ffa200', '#ffe600', '#00ffd5', '#2a6bff', '#c050ff', '#ff3dc0']
export const FRIEND_ONE = '#29dbff' // when they are not given a colour each

/* the reading layer — the order trail and the slot numbers. Not white: they
   are notes ON the wheel, and have to be told apart from the discs. */
export const INK = '#09E409'

/* the cast, in the order they join — the sphere's roster, copied rather than
   imported (a scene never imports another scene). Names only: a chip here
   carries a name and a colour and nothing else, because a chip that also said
   "won" would be naming a winner. */
export const ROSTER = ['May', 'jonas', 'Cliffhanger', 'Daniel', 'mightywoosh', 'Ana', 'toby', 'Priya', 'Wolf']

/* …and for anyone you pick off the wheel yourself: one short, ordinary bird.
   Nobody in a prize draw has a name yet, and a bird is a placeholder that
   reads as a person without pretending to be one. */
export const BIRDS = [
  'Robin', 'Wren', 'Finch', 'Sparrow', 'Swallow', 'Martin', 'Swift', 'Heron', 'Egret', 'Stork',
  'Crane', 'Goose', 'Duck', 'Teal', 'Swan', 'Gull', 'Tern', 'Puffin', 'Auk', 'Owl',
  'Hawk', 'Kite', 'Falcon', 'Merlin', 'Kestrel', 'Eagle', 'Osprey', 'Buzzard', 'Raven', 'Crow',
  'Rook', 'Jackdaw', 'Magpie', 'Jay', 'Starling', 'Thrush', 'Blackbird', 'Dipper', 'Pipit', 'Wagtail',
  'Warbler', 'Chiffchaff', 'Siskin', 'Linnet', 'Bunting', 'Lark', 'Nightjar', 'Cuckoo', 'Woodpecker', 'Kingfisher',
]

/* the scene fills these in create(); the panel's buttons and applyWheel()
   below call them. Empty until then, so a dial moved before the first frame
   is a no-op rather than a crash. */
export const wheelActions = {}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

const hex = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)

export function applyWheel(p) {
  const w = p.wheel ?? {}
  const before = {
    n: WHEEL.n,
    seed: WHEEL.seed,
    placement: WHEEL.placement,
    rings: WHEEL.rings,
    hole: WHEEL.hole,
    winners: WHEEL.winners,
    grow: WHEEL.dotGrow,
    sizeSpacing: WHEEL.sizeSpacing,
    dot: WHEEL.dot,
    across: WHEEL.across,
    fit: WHEEL.fit,
    ringRule: `${WHEEL.perRing}|${WHEEL.ringGap}`,
    // from the edge the rings are ringGap discs apart, so the disc size moves them too
    edge: `${WHEEL.ringPosition}|${WHEEL.ringGap}|${WHEEL.fit}|${WHEEL.dot}|${WHEEL.dotMin}|${WHEEL.dotMax}|${WHEEL.dotShare}`,
    slo: `${WHEEL.sloMo}|${WHEEL.sloMoAtPct}|${WHEEL.sloMoSpeed}`,
  }

  assign(WHEEL, w, {
    tickets: 'n',
    winners: 'winners',
    rings: 'rings',
    innerHoleShareOfRim: 'hole',
    wheelWidthPct: 'across',
    discSizePx: 'dot',
    discGrowsOutward: 'dotGrow',
    loserAlpha: 'loserAlpha',
  })
  /* the wedge has a folder of its own: the frame, and where it sits */
  const wd = p.wedge ?? {}
  if (wd.showWedge != null) WHEEL.wedge = !!wd.showWedge
  if (wd.fillGradient != null) WHEEL.wedgeGradient = !!wd.fillGradient
  if (wd.wedgeOverDiscs != null) WHEEL.wedgeOverDiscs = !!wd.wedgeOverDiscs
  for (const [dial, key] of [['fillColour', 'wedgeColour'], ['tipColour', 'wedgeTipColour'], ['noiseColour', 'wedgeNoiseColour'], ['borderColour', 'wedgeBorderColour']]) if (hex(wd[dial])) WHEEL[key] = wd[dial]
  assign(WHEEL, wd, {
    wedgeAngleDeg: 'wedgeDeg',
    fillAlpha: 'wedgeAlpha',
    tipAlpha: 'wedgeTipAlpha',
    wedgeLengthXWheel: 'wedgeReach',
    hidesDiscsUnder: 'wedgeCover',
    wedgeWhileSpinning: 'wedgeSpinning',
    noise: 'wedgeNoise',
    noiseSpeckPx: 'wedgeNoisePx',
    borderPx: 'wedgeBorderPx',
    borderAlpha: 'wedgeBorderAlpha',
  })

  // a select is a string and a toggle is a boolean: both would go to NaN
  // through assign()'s num(), so they are read straight
  if (typeof w.ticketPlacement === 'string' && PLACEMENTS.includes(w.ticketPlacement)) WHEEL.placement = w.ticketPlacement
  if (w.fitDiscsToTickets != null) WHEEL.fit = !!w.fitDiscsToTickets
  if (typeof w.ringPosition === 'string' && RING_POSITIONS.includes(w.ringPosition)) WHEEL.ringPosition = w.ringPosition
  assign(WHEEL, w, { smallestDiscPx: 'dotMin', biggestDiscPx: 'dotMax', discShareOfSpacing: 'dotShare', ticketsPerRing: 'perRing', ringsApartDiscs: 'ringGap' })
  if (w.discSizeSetsSpacing != null) WHEEL.sizeSpacing = !!w.discSizeSetsSpacing
  if (w.lightUnderWedge != null) WHEEL.wedgeLights = !!w.lightUnderWedge
  assign(WHEEL, w, { discAlphaWhileSpinning: 'spinAlpha', underWedgeAlpha: 'underWedgeAlpha', wedgeLightFadeMs: 'wedgeFadeMs' })

  /* a top-level toggle, under the Reset button: the scene reconciles it
     every frame, so there is nothing to call */
  if (p.constantSpin != null) WHEEL.constantSpin = !!p.constantSpin

  const s = p.spin ?? {}
  if (s.spinButton != null) WHEEL.spinButton = !!s.spinButton
  if (s.sloMo != null) WHEEL.sloMo = !!s.sloMo
  assign(WHEEL, s, {
    spinsByItselfAfterMs: 'autoSpinDelayMs',
    spinSpeedTurnsPerS: 'holdTurnsPerS',
    spinUpS: 'upS',
    windDownS: 'spinS',
    totalSpinS: 'autoSpinS',
    extraWholeTurns: 'turns',
    sloMoFromPctOfSpin: 'sloMoAtPct',
    sloMoSpeedX: 'sloMoSpeed',
  })

  const z = p.zoom ?? {}
  if (z.zoomOntoWedge != null) WHEEL.zoom = !!z.zoomOntoWedge
  assign(WHEEL, z, { zoomX: 'zoomX', zoomAtSFromSpinEnd: 'zoomAtS', zoomMs: 'zoomMs' })

  const y = p.yourTicket ?? {}
  const wasYou = WHEEL.youColour
  if (hex(y.yourColour)) WHEEL.youColour = y.yourColour
  if (y.pulseAroundYou != null) WHEEL.pulse = !!y.pulseAroundYou
  if (hex(y.pulseColour)) WHEEL.pulseColour = y.pulseColour
  assign(WHEEL, y, { pulseEveryMs: 'pulseMs', pulseGrowsPx: 'pulsePx' })
  if (y.yourTicketAlwaysWins != null) WHEEL.rigWin = !!y.yourTicketAlwaysWins
  if (y.arrowToYouOffScreen != null) WHEEL.edgeArrow = !!y.arrowToYouOffScreen
  assign(WHEEL, y, { arrowSizePx: 'edgeArrowPx' })

  const f = p.whosPlaying ?? {}
  const wasCast = `${WHEEL.friends}|${WHEEL.colorEach}|${wasYou}`
  assign(WHEEL, f, { friends: 'friends', chipsFromTopPx: 'chipsTopPx' })
  if (f.colourEachFriend != null) WHEEL.colorEach = !!f.colourEachFriend
  if (f.arrowsToFriendsOffScreen != null) WHEEL.edgeArrowFriends = !!f.arrowsToFriendsOffScreen

  const sh = p.show ?? {}
  if (sh.ticketNumbers != null) WHEEL.numbers = !!sh.ticketNumbers
  if (sh.orderTrail != null) WHEEL.trail = !!sh.orderTrail
  if (sh.trailForYouAndFriends != null) WHEEL.wake = !!sh.trailForYouAndFriends
  assign(WHEEL, sh, { trailSeconds: 'wakeS' })

  WHEEL.n = clamp(Math.round(num(WHEEL.n)) || 2, 2, 5000)
  WHEEL.winners = clamp(Math.round(num(WHEEL.winners)) || 1, 1, WHEEL.n)
  WHEEL.rings = clamp(Math.round(num(WHEEL.rings)) || 1, 1, 40)
  WHEEL.friends = clamp(Math.round(num(WHEEL.friends)), 0, ROSTER.length)
  WHEEL.hole = clamp(num(WHEEL.hole), 0, 0.92)
  WHEEL.dotGrow = clamp(num(WHEEL.dotGrow), 1, 10)
  WHEEL.dotMin = clamp(num(WHEEL.dotMin), 0.5, 60)
  WHEEL.dotMax = clamp(num(WHEEL.dotMax), WHEEL.dotMin, 60)
  WHEEL.dotShare = clamp(num(WHEEL.dotShare), 0.05, 1.5)
  WHEEL.perRing = clamp(num(WHEEL.perRing), 5, 1000)
  WHEEL.ringGap = clamp(num(WHEEL.ringGap), 1, 5)
  WHEEL.wedgeAlpha = clamp(num(WHEEL.wedgeAlpha), 0, 1)
  WHEEL.wedgeTipAlpha = clamp(num(WHEEL.wedgeTipAlpha), 0, 1)
  WHEEL.wedgeReach = clamp(num(WHEEL.wedgeReach), 1, 4)
  WHEEL.wedgeCover = clamp(num(WHEEL.wedgeCover), 0, 1)
  WHEEL.wedgeSpinning = clamp(num(WHEEL.wedgeSpinning), 0, 1)
  WHEEL.wedgeNoise = clamp(num(WHEEL.wedgeNoise), 0, 1)
  WHEEL.wedgeNoisePx = clamp(num(WHEEL.wedgeNoisePx), 0.5, 12)
  WHEEL.wedgeBorderPx = clamp(num(WHEEL.wedgeBorderPx), 0, 20)
  WHEEL.wedgeBorderAlpha = clamp(num(WHEEL.wedgeBorderAlpha), 0, 1)
  WHEEL.across = clamp(num(WHEEL.across), 20, 100)
  WHEEL.wakeS = clamp(num(WHEEL.wakeS), 0.02, 1.2)
  WHEEL.zoomX = clamp(num(WHEEL.zoomX), 1, 12)
  WHEEL.zoomAtS = clamp(num(WHEEL.zoomAtS), -12, 2)
  WHEEL.zoomMs = clamp(num(WHEEL.zoomMs), 0, 5000)
  WHEEL.pulseMs = clamp(num(WHEEL.pulseMs), 100, 10000)
  WHEEL.pulsePx = clamp(num(WHEEL.pulsePx), 0, 80)
  WHEEL.edgeArrowPx = clamp(num(WHEEL.edgeArrowPx), 8, 96)
  WHEEL.spinAlpha = clamp(num(WHEEL.spinAlpha), 0, 1)
  WHEEL.underWedgeAlpha = clamp(num(WHEEL.underWedgeAlpha), 0, 1)
  WHEEL.wedgeFadeMs = clamp(num(WHEEL.wedgeFadeMs), 0, 5000)
  WHEEL.autoSpinDelayMs = clamp(num(WHEEL.autoSpinDelayMs), -8000, 5000) // negative: before the coin lands (held to the flight's length)
  WHEEL.holdTurnsPerS = clamp(num(WHEEL.holdTurnsPerS), 0.05, 12)
  WHEEL.upS = clamp(num(WHEEL.upS), 0.05, 5)
  WHEEL.spinS = clamp(num(WHEEL.spinS), 0.2, 30)
  WHEEL.autoSpinS = clamp(num(WHEEL.autoSpinS), 0.5, 60)
  WHEEL.sloMoAtPct = clamp(num(WHEEL.sloMoAtPct), 0, 100)
  WHEEL.sloMoSpeed = clamp(num(WHEEL.sloMoSpeed), 0.05, 1)

  /* what has to be rebuilt, and nothing more — a dial never resets the scene.
     A new ticket count or a new seed is a different ticket list, so the ring
     is re-hashed and the draw is run again; everything else keeps the draw it
     has. A placement, a ring count or a hole only moves the discs, and the
     landing is re-solved so the wheel stays sitting on its own winners. */
  /* who is playing is a live change too: the row re-reads its cast, nobody's
     seat moves, and the draw on screen is untouched. chipsFromTopPx needs
     nothing at all — the scene syncs it to the row every frame. */
  if (wasCast !== `${WHEEL.friends}|${WHEEL.colorEach}|${WHEEL.youColour}`) wheelActions.recast?.()


  /* the slow-mo is live mid-spin: the clock is re-anchored where it is, so
     the wheel carries on from the same angle at the new speed. The spin's
     other timings are read at the next go — a spin already under way keeps
     the one it was planned with. */
  if (before.slo !== `${WHEEL.sloMo}|${WHEEL.sloMoAtPct}|${WHEEL.sloMoSpeed}`) wheelActions.retime?.()

  /* the disc size is a layout input once discSizeSetsSpacing is on — the
     ladder solves for the slack that fits n discs of that size — so all three
     size dials have to re-lay the wheel out as well as re-draw it */
  const sized = WHEEL.sizeSpacing && !WHEEL.fit && (before.grow !== WHEEL.dotGrow || before.dot !== WHEEL.dot || before.across !== WHEEL.across)
  /* with fit on, the ring count follows the count — so the toggle re-lays the
     wheel out, and the size dials only re-draw it (the discs are one size, so
     the spacing law has nothing to read) */
  const moved =
    before.fit !== WHEEL.fit ||
    (WHEEL.fit && before.ringRule !== `${WHEEL.perRing}|${WHEEL.ringGap}`) ||
    before.placement !== WHEEL.placement ||
    before.rings !== WHEEL.rings ||
    before.hole !== WHEEL.hole ||
    before.sizeSpacing !== WHEEL.sizeSpacing ||
    sized ||
    (WHEEL.placement === 'rings, spread' && before.edge !== `${WHEEL.ringPosition}|${WHEEL.ringGap}|${WHEEL.fit}|${WHEEL.dot}|${WHEEL.dotMin}|${WHEEL.dotMax}|${WHEEL.dotShare}`)
  if (before.n !== WHEEL.n || before.seed !== WHEEL.seed) wheelActions.reticket?.()
  else if (moved || before.winners !== WHEEL.winners) wheelActions.relayout?.()
}

/* the panel is rebuilt when one of these changes shape — the ring count only
   means something under a ringed placement, so it comes and goes with it. */
export const wheelSnapshot = () => ({
  placement: WHEEL.placement,
  ringPos: WHEEL.ringPosition,
  fit: WHEEL.fit,
  wedge: WHEEL.wedge,
  gradient: WHEEL.wedgeGradient,
  over: WHEEL.wedgeOverDiscs,
  wake: WHEEL.wake,
  spinButton: WHEEL.spinButton,
  sloMo: WHEEL.sloMo,
  wedgeLights: WHEEL.wedgeLights,
  pulse: WHEEL.pulse,
  zoom: WHEEL.zoom,
  edgeArrow: WHEEL.edgeArrow,
})
export const wheelSame = (a, b) =>
  a.placement === b.placement && a.ringPos === b.ringPos && a.fit === b.fit && a.wedge === b.wedge && a.gradient === b.gradient && a.over === b.over && a.wake === b.wake && a.spinButton === b.spinButton && a.sloMo === b.sloMo && a.wedgeLights === b.wedgeLights && a.pulse === b.pulse && a.zoom === b.zoom && a.edgeArrow === b.edgeArrow

export const WHEEL_FOLDERS = ['wheel', 'wedge', 'spin', 'zoom', 'yourTicket', 'whosPlaying', 'show']
export const WHEEL_OPEN = new Set(['wheel', 'wedge', 'spin', 'zoom', 'yourTicket', 'whosPlaying'])
