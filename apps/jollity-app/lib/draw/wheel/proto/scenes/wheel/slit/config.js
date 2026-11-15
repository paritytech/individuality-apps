// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE DRAW, THROUGH THE SLIT — its own tables. Terse keys here,
   readable dial names in panel.js; applySlit() is the seam between the two.

   The spin, the zoom's timing and the endings' words are the flow's (WHEEL
   and FLOW, wheel/config.js), COPIED in at load and never written back: this
   page reads SLIT alone, so a dial here cannot move the wheel's page or the
   flow's. Everything else is the Figma's (Jollity-Lottery › Section 1,
   405×858 frames, scaled to the 390×844 stage by its height). */

import { assign } from '../../../render-utils/dials.js'
import { GOOD_LUCK_LOOK, BASE_LOOK } from '../../../render-utils/coin/look/look.js'
import { WHEEL, OUTCOMES } from '../config.js'
import { TAIL_KINDS } from './trail-look/look.js'

export { OUTCOMES, TAIL_KINDS }
export const TRAIL_STYLES = ['line', 'circles']
export const SLIT_GLOWS = ['gradient', 'fades to a line']

export const SLIT = {
  /* the draw */
  n: 42, //                   tickets in the draw (the panel's; the flow plays 420)
  winners: 5, //               …and how many the wedge takes
  outcome: 'random', //        one of OUTCOMES: the chain's odds, or a draw you win, or one you lose (the flow's is random)
  showWinOrLoss: true, //      toggle: the flow's ending — the prize, or the zoom out and the fall — once it lands (off: it holds on the wedge)
  pauseOnSlider: true, //     toggle: a hand on the timeline leaves the spin paused where it lets go

  /* the stage, nominal px */
  hubY: 422, //                the wheel's centre, from the top (the Figma's: the middle)
  rimPx: 185, //               the outermost ring's radius, at most (the flow's: 95% of the width) — less where the lit one's ring would leave the stage at the sides
  hole: 0.66, //               the rings' hole, × the rim
  slitLengthPx: 164, //        the slit's hairline, end to end (the Figma's 168 at 405)
  slitCirclePx: 240, //        the circle the slit bends into, closed, radius (232 would be the slit's own distance from the hub, 654 − 422) — it closes on the hub at any size
  hubPx: 218, //               the hub's glow, radius — the slit's circle, settled (Section 7: 209 at 405, 1.18 × the tickets' ring)
  hubAfterPx: 212, //          …and once WINNER is up
  hubDiscPx: 76, //            the black disc in the middle, under WINNERS (Section 7: 73 of the glow's 209)…
  hubDiscBlurPx: 4, //         …its edge blurred this much (the Figma's layer blur), screen px
  glowHeartOn: false, //       toggle: the glow's very middle in a red (Ellipse 10, 469:6007: #FF0004 to .23 of it, running into the core by .37) — under the disc all but a breath of it, warming the core's inner edge
  glowHeart: '#ff0004', //     …this red
  glowCore: '#dbeff2', //      the glow, from the disc out (Section 7's Ellipse 10): its bright core…
  glowMid: '#1f7098', //       …the blue half way out…
  glowOuter: '#182336', //     …and the navy it fades out in — the slit, as it bends, takes on the core
  glowGrain: false, //         toggle: the Figma's grain over the glow, dark and light specks
  glowGrainA: 1, //            …this strong, 0..1 (1: the Figma's)
  bg: '#080808', //            the page behind it all — the host's dark ground
  glowBlur: false, //           toggle: the centre's light (the closed slit's rim, then the hub's glow) blurred, by the three below
  glowBlurCirclingPx: 0, //    …while the coin circles, px
  glowBlurSpirallingPx: 0, // …while it spirals in
  glowBlurWheelPx: 0, //       …and on the wheel, from the landing (0: the Figma's ramp as it is)
  glowBlurEaseMs: 0, //      …each change from one to the next taking this long

  /* the coin's way back: never a stop — out of the slit, round the circle,
     and in onto its ticket on a wheel that is already turning */
  circleMs: 2000, //           circling the slit's circle (from the hand-over)
  spiralMs: 1800, //           …then spiralling in onto its ticket
  coinTurnsPerS: 1.85, //      how fast it circles, turns a second (the spiral then meets the wheel's own speed)
  orbitPx: 275, //             how far out it circles
  orbitCoinPx: 52, //          …and the coin's radius as it does
  spinStartMs: -200, //        the wheel starts this long before the coin lands on it (−2000…2000; positive: after)

  /* the look */
  ballMaxPx: 27.6, //          the biggest a ticket gets, across (few of them: frame 50)
  ticketBloom: false, //       toggle: a soft glow of light round each ticket on the wheel, in its colour…
  ticketBloomStrength: 0.18, // …this bright (0: none)
  ticketBloomSizeX: 2.8, //    …reaching this many × the ticket's radius out
  rings: false, //             toggle: a ring round your ticket (frames 44–50)
  trail: true, //              toggle: a trail behind your ticket — the way it came
  tail: 'blue to red', // one of TAIL_KINDS: the trail's whole look — the Figma's gradient or blue to red (flat, on the page's own canvas: the draw's), or the trail lab's hot liquid glass or 70s rainbow (a shader on a WebGL context of its own, loaded only when chosen)
  trailMs: 430, //             …yours, in the Figma's colours: how long ago its tail was — the way your ticket came over the last this long, so slow is short and still is none
  orbitTrailMs: 300, //        …yours while the coin circles and spirals in, before it lands — from the landing it eases to trailMs
  trailZoomThinMs: 150, //     …and on the zoom onto the wedge it thins away to nothing, this long into the zoom (0: at once)
  trailStyle: 'line', //       one of TRAIL_STYLES: a line (one ribbon), or circles — the trail lab's (these two pages draw a line)…
  trailCircles: 8, //          …this many of them (its resolution), 2–40
  edgeArrow: true, //          toggle: zoomed in with your ticket off the stage, an arrow on the edge points at it (the flow's)
  arrowPx: 40, //              the arrow's long side, nominal px (the flow's)
  arrowCornerPx: 48, //        …never nearer a bottom corner than this
  arrowEasePx: 144, //         …easing toward its ends from this far
  arrowColour: '#00e1ff', //   …in this colour (its own, not yours)

  /* THE TICKETS: their colour, and how much of each shows — one rule
     (ticketAlpha, walk.js). Every ticket is in one state; being yours only
     changes the colour, except youLostA */
  ticketColour: '#ffffff', //  every ticket but yours
  youColour: '#00bcf5', //     yours: your ticket, the coin on its way in, its trail, its ring, YOU (the arrow has its own, arrowColour)
  spinOutA: 0.2, //            spinning: a ticket outside the wedge, not yours (the Figma's .4, dimmed)…
  spinUnderA: 1, //            …and one under it
  spinYouA: 1, //              …and yours, wherever it is (its trail reads wrong behind a see-through ticket)
  loserA: 0.1, //              landed, nobody lit: a ticket that did not win, not yours…
  youLostA: 0.4, //            …yours, if it did not
  winnerA: 1, //               …a winner (yours too, if it won)
  litA: 1, //                  one lit (the walk's, you at its end, or one you tapped): it…
  unlitA: 0.1, //              …and every other ticket that did not win, not yours…
  unlitYouA: 0.2, //           …yours, if it did not…
  unlitWinnerA: 0.6, //        …and a winner (yours too, if it won), held to this
  winnersLoserLitA: 0.5, //    WINNERS never goes: held to this while a ticket that did not win is lit
  nameLitA: 1, //              the names: the lit one…
  nameA: 0.15, //              …and the rest
  easeMs: 150, //              each ticket and name easing from one state to the next
  select: true, //             toggle: the lit one ringed (Section 7) — a black disc, a white ring…
  selectGapPx: 5, //           …this far out from the ticket (26 → 36 in the Figma)
  selectLinePx: 1, //          …the ring and the line, this wide
  selectLine: true, //         toggle: …a line from its name down to the ring…
  lineDrawMs: 100, //          …drawn down from the underline over this (gone at once when it is not lit)
  nameUnderline: true, //      toggle: the lit name underlined

  /* the wedge: its SIZE is the winners' — exactly their share of the wheel
     wide (so exactly that many tickets are under it at every angle), and
     wedgePadPx out past the outermost of them — and it never grows or
     shrinks; what moves is how lit its edge is */
  wedgePadPx: 4,
  wedgeRadiusPx: 202, //       its radius, px — 0: out to the winners and wedgePadPx past them. Never past where WINNER still fits above it on the stage
  wedgeFillColour: '#000000', // its fill (Ellipse 3, 469:6008: black at .32 over the hub's glow)…
  wedgeFill: 0.32, //          …this much of it, 0..1
  wedgeLuminosity: true, //    toggle: laid over what is under it as light only, keeping that colour (the Figma's luminosity blend; off: plain over)
  wedgeGrain: true, //         toggle: the grain over it (the Figma's noise: black specks at .25 on half the screen's px)…
  wedgeSpeckle: 0.32, //       …clipped this much, 0..1 (0.32: the Figma's, which clips it by the fill) — in screen px, fine at any zoom
  wedgeEdgePx: 2, //           its edge, this wide, all inside it (the Figma's 4 px stroke, masked to the inside)
  /* its edge's gradient, the Figma's four stops, straight up the wedge's
     middle from the tip to the arc (not round: a point's light goes by how
     far up the middle it lies, so the arc's corners, lower down, fade) */
  wedgeTip: '#ffffff', //      at the tip (the hub): white at .5…
  wedgeTipAlpha: 0.5,
  wedgeInner: '#000000', //    …running to black at .1…
  wedgeInnerAlpha: 0.1,
  wedgeInnerAt: 0.37, //       …this far up, 0..1 of its radius…
  wedgeOuter: '#ffffff', //    …then up to white at .05…
  wedgeOuterAlpha: 0.05,
  wedgeOuterAt: 0.66, //       …this far up…
  wedgeEdge: '#ffffff', //     …and to white at .5 on the arc's middle
  wedgeEdgeAlpha: 0.5,

  /* the order of things, seconds from the coin going through the slit */
  handoffMs: 300, //           the solid coin becomes the flat one (under the slit's shade)
  bendAtMs: 50, //             the slit starts to bend…
  bendMs: 900, //              …into a bowl, and closes into the circle over this
  wedgeMs: 300, //             the wedge's edge lighting up from the hub out
  winnerMs: 500, //            WINNER coming up (at once, the moment the wedge has lit): the hub's glow easing to hubAfterPx over this
  ticketsSweepMs: 0, //        the tickets appearing, from yours round the wheel (0: all at once)
  ticketInMs: 300, //          …each over this
  mineFallsAfterMs: 600, //    a loss: your coin falls too, this long after the last of the others is off the page
  /* the black hole: the closed slit's light collapses to a dot, the black
     disc is round it, and the glow bursts out from behind it */
  slitGlow: 'gradient', //     one of SLIT_GLOWS: as it collapses, the bowl's gradient as it closed — or its glow fading, leaving a plain white line; either way gone by the dot
  lineMs: 0, //              'fades to a line': the glow gone and the line plain this long after the circle closes
  collapseMs: 660, //          the closed circle down to a dot over this, fading out as it goes (the disc and the burst there)
  /* THE BURST: the glow bursting out from behind the disc in two beats —
     out to burstMaxX × its size by burstPeakMs on an ease out back, then an
     ease out down to its size by the end (sequence.js burstOut) */
  explodeMs: 3000, //          the whole burst, from behind the disc to its size
  burstFadeInMs: 200, //       the glow coming up from nothing as it bursts, over this (0: there at once)
  burstMaxX: 2.2, //           its biggest, × its size…
  burstPeakMs: 200, //         …this long in…
  burstBack: 0, //             …overshooting it on the way and coming back to it this much (the ease out back's c1; 1.70158 the usual; 0: a plain ease out)
  burstFlash: true, //         toggle: its core flashes near white as it bursts, then cools to the gradient's colours…
  burstFlashMs: 400, //        …over this
  burstFlashA: 0.62, //        …this white, 0..1
  burstRing: true, //          toggle: a shockwave — a thin bright ring shooting out past the glow, fading…
  burstRingMs: 3000, //        …over this
  burstRingReach: 4, //        …out to this × the glow's radius
  burstRingPx: 3, //           …this wide, px
  burstRingA: 1, //            …from this bright
  wedgeFromHoleMs: -1440, //   the wedge lighting up this long after the burst (negative: before it ends — never before the circle closes)

  /* WHO'S PLAYING, once it lands: a row of names along the top (legend.js),
     left to right as their tickets are; then the winners lit one by one, left
     to right, and you last (walk.js) — win or lose. How much of each ticket
     and name shows is THE TICKETS', above */
  namesY: 183, //              the row's middle, from the top, nominal px (Section 7: 37 over the wedge's arc)
  namesFromStopS: -0.5, //     it starts coming on this long from the wheel's stop (−2…0: before it)…
  namesWalkMs: 600, //         …the names on the stage one by one, all of them over this long — the rest with the last of them
  nameSlideMs: 250, //         the row sliding to put a name over its ticket
  walkMs: 600, //              each winner lit in turn, then you, this long each…
  walkWinnersMaxMs: 2500, //   …but the winners all in this at most, shared evenly between them
  wheelBehindPrize: 0, //      a win: how much of the wheel shows under the prize, 0..1 (0: black, the prize alone)
  lossHeadY: 131, //            a loss: 'Not this time', over the row, its middle from the top
  pillGrowsMs: 200, //         once you are lit, the timeline grows into Continue over this long…
  pillLettersFromPx: 30, //    …its word fading in as it grows past this tall (of 48)

  /* the spin and the zoom — the flow's, copied */
  autoSpinS: WHEEL.autoSpinS,
  upS: WHEEL.upS,
  spinS: WHEEL.spinS,
  turnsPerS: WHEEL.holdTurnsPerS,
  sloMo: WHEEL.sloMo,
  sloMoAtPct: WHEEL.sloMoAtPct,
  sloMoSpeed: WHEEL.sloMoSpeed,
  zoom: true, //               toggle: the zoom onto the wedge as the spin ends
  zoomX: 2.4, //               …at most this far in — less when the wedge would not fit (the flow's is WHEEL.zoomX)
  zoomAtS: WHEEL.zoomAtS,
  zoomMs: WHEEL.zoomMs,
  tapZoomOutMs: 200, //        zoomed in, a ticket tapped: the zoom eases out to the whole wheel over this
  lossZoomOutMs: 750, //       a loss: the zoom out to the whole wheel, from the moment you are lit, over this (then your coin's flip)
  continueBeforeBackMs: 250, // a win: Continue grows in this long before Back to the wheel comes up
}

/* THE COIN, SOLID — the lab's Good luck coin (GOOD_LUCK_LOOK, played by
   lucky.js): plastic in your blue, GOOD LUCK in 3D letters on a spiral on
   its front, the logo on its back. lucky.js has no bloom and no rim glints, so
   its glow and glints are the lab's alone. A little smaller here (80, the
   lab's is 100). Each coin takes a COPY, since words() writes into the look
   it was given.

   Both coins on this page engrave at 512² where the lab's are 1024²: a coin
   here is at most ~440 device px across, so 512 is about a texel a pixel, and
   each coin holds a quarter of the memory. ?maps=1024 builds them as they
   were (scene.js). */
export const SOLID_LOOK = {
  ...GOOD_LUCK_LOOK,
  coinR: 80,
  plasticColour: '#00ade6', // your blue: lit as it is, it reads about as SLIT.youColour (#00bcf5; the light lifts its red a little) — the lab's teal, #49b692, read as #49c69e
  // GOOD LUCK is on its front now (the look's): it starts on it, face-on — no half turn (lucky.js faceBack)
  mapSize: '512',
}
/* the prize's coin: the coin lab's Winners coin (metal), at this page's map size */
export const PRIZE_LOOK = { ...BASE_LOOK, mapSize: '512' }

/* the scene fills these in create(); the panel's buttons and applySlit()
   below call them. Empty until then, so a dial moved before the first frame
   is a no-op rather than a crash. */
export const slitActions = {}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const hex = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)

export function applySlit(p) {
  /* the look: live, the painter reads SLIT every frame */
  const l = p.look ?? {}
  const fitKey = () => `${SLIT.zoomX}|${SLIT.wedgePadPx}|${SLIT.wedgeRadiusPx}|${SLIT.namesY}|${SLIT.rimPx}|${SLIT.selectGapPx}|${SLIT.selectLinePx}|${SLIT.select}`
  const before = fitKey()
  assign(SLIT, l, {
    yourTrailMsOfTravel: 'trailMs',
    yourTrailMsCirclingAndSpiralling: 'orbitTrailMs',
    yourTrailThinsAwayOnZoomMs: 'trailZoomThinMs',
    zoomAtMostX: 'zoomX',
    centreBlurCirclingPx: 'glowBlurCirclingPx',
    centreBlurSpirallingPx: 'glowBlurSpirallingPx',
    centreBlurOnWheelPx: 'glowBlurWheelPx',
    centreBlurTransitionMs: 'glowBlurEaseMs',
    centreGrain: 'glowGrainA',
    centreDiscBlurPx: 'hubDiscBlurPx',
  })
  SLIT.hubDiscBlurPx = clamp(SLIT.hubDiscBlurPx, 0, 30)
  if (l.centreGlowBlur != null) SLIT.glowBlur = !!l.centreGlowBlur
  if (l.centreGrainOn != null) SLIT.glowGrain = !!l.centreGrainOn
  SLIT.glowGrainA = clamp(SLIT.glowGrainA, 0, 1)
  for (const k of ['glowBlurCirclingPx', 'glowBlurSpirallingPx', 'glowBlurWheelPx']) SLIT[k] = clamp(SLIT[k], 0, 80)
  SLIT.glowBlurEaseMs = clamp(SLIT.glowBlurEaseMs, 0, 4000)
  // a select is a string and a toggle a boolean: assign()'s num() would make both NaN, so they are read straight
  if (l.centreRedOn != null) SLIT.glowHeartOn = !!l.centreRedOn
  for (const [dial, key] of [['centreRedColour', 'glowHeart'], ['centreCoreColour', 'glowCore'], ['centreMidColour', 'glowMid'], ['centreOuterColour', 'glowOuter'], ['backgroundColour', 'bg']]) if (hex(l[dial])) SLIT[key] = l[dial] // live: the painter reads them every frame
  if (l.ringRoundYou != null) SLIT.rings = !!l.ringRoundYou
  if (l.trails != null) SLIT.trail = !!l.trails
  if (TAIL_KINDS.includes(l.tail)) SLIT.tail = l.tail // live: the painter reads it every frame
  if (SLIT_GLOWS.includes(l.slitGlow)) SLIT.slitGlow = l.slitGlow
  if (l.zoomOntoWedge != null) SLIT.zoom = !!l.zoomOntoWedge
  /* the arrow to yours: whether, and its colour — live, read every frame */
  const ar = p.arrow ?? {}
  if (ar.toYou != null) SLIT.edgeArrow = !!ar.toYou
  if (hex(ar.colour)) SLIT.arrowColour = ar.colour
  SLIT.zoomX = clamp(SLIT.zoomX, 1, 4)
  SLIT.trailZoomThinMs = clamp(SLIT.trailZoomThinMs, 0, 3000)
  /* the tickets: their colours, the rule's alphas, and the lit one's look */
  const tk = p.tickets ?? {}
  for (const [dial, key] of [['ticketColour', 'ticketColour'], ['yourColour', 'youColour']]) if (hex(tk[dial])) SLIT[key] = tk[dial]
  assign(SLIT, tk.spinning ?? {}, { outsideWedge: 'spinOutA', underWedge: 'spinUnderA', yours: 'spinYouA' })
  assign(SLIT, tk.result ?? {}, { loser: 'loserA', youLost: 'youLostA', winner: 'winnerA' })
  assign(SLIT, tk.oneLit ?? {}, { lit: 'litA', everythingElse: 'unlitA', yours: 'unlitYouA', winnerTickets: 'unlitWinnerA', winnersWhileALoserIsLit: 'winnersLoserLitA' })
  assign(SLIT, tk.names ?? {}, { lit: 'nameLitA', notLit: 'nameA' })
  assign(SLIT, tk, { changesEaseMs: 'easeMs' })
  const sl = tk.selected ?? {}
  assign(SLIT, sl, { ringGapPx: 'selectGapPx', ringAndLineWidthPx: 'selectLinePx', lineDrawsDownMs: 'lineDrawMs' })
  SLIT.lineDrawMs = clamp(SLIT.lineDrawMs, 0, 2000)
  if (sl.ring != null) SLIT.select = !!sl.ring
  if (sl.lineToName != null) SLIT.selectLine = !!sl.lineToName
  if (sl.nameUnderline != null) SLIT.nameUnderline = !!sl.nameUnderline
  for (const k of ['spinOutA', 'spinUnderA', 'spinYouA', 'loserA', 'youLostA', 'winnerA', 'litA', 'unlitA', 'unlitYouA', 'unlitWinnerA', 'winnersLoserLitA', 'nameLitA', 'nameA']) SLIT[k] = clamp(SLIT[k], 0, 1)
  SLIT.easeMs = clamp(SLIT.easeMs, 0, 1000)
  SLIT.selectGapPx = clamp(SLIT.selectGapPx, 0, 30)
  SLIT.selectLinePx = clamp(SLIT.selectLinePx, 0.5, 4)
  /* the tickets' glow */
  const tl = p.ticketLook ?? {}
  assign(SLIT, tl, { glowStrength: 'ticketBloomStrength', glowSizeXRadius: 'ticketBloomSizeX' })
  if (tl.glow != null) SLIT.ticketBloom = !!tl.glow
  SLIT.ticketBloomStrength = clamp(SLIT.ticketBloomStrength, 0, 3)
  SLIT.ticketBloomSizeX = clamp(SLIT.ticketBloomSizeX, 1, 12)
  /* the burst: how it bursts */
  const bu = p.burst ?? {}
  for (const [dial, key] of [['flash', 'burstFlash'], ['shockwave', 'burstRing']]) if (bu[dial] != null) SLIT[key] = !!bu[dial]
  assign(SLIT, bu, {
    lastsMs: 'explodeMs',
    biggestXGlow: 'burstMaxX',
    biggestAtMs: 'burstPeakMs',
    overshootPastBiggest: 'burstBack',
    fadesInMs: 'burstFadeInMs',
    flashMs: 'burstFlashMs',
    flashWhite: 'burstFlashA',
    shockwaveMs: 'burstRingMs',
    shockwaveReachXGlow: 'burstRingReach',
    shockwaveWidthPx: 'burstRingPx',
    shockwaveAlpha: 'burstRingA',
  })
  SLIT.burstMaxX = clamp(SLIT.burstMaxX, 1, 6)
  SLIT.burstPeakMs = clamp(SLIT.burstPeakMs, 0, 3000)
  SLIT.burstBack = clamp(SLIT.burstBack, 0, 4)
  SLIT.explodeMs = clamp(SLIT.explodeMs, 50, 3000)
  SLIT.burstFadeInMs = clamp(SLIT.burstFadeInMs, 0, 3000)
  SLIT.burstFlashMs = clamp(SLIT.burstFlashMs, 10, 2000)
  SLIT.burstFlashA = clamp(SLIT.burstFlashA, 0, 1)
  SLIT.burstRingMs = clamp(SLIT.burstRingMs, 50, 3000)
  SLIT.burstRingReach = clamp(SLIT.burstRingReach, 1, 4)
  SLIT.burstRingPx = clamp(SLIT.burstRingPx, 0.5, 12)
  SLIT.burstRingA = clamp(SLIT.burstRingA, 0, 1)
  /* who's playing, and the walk: live, read every frame */
  const wp = p.whosPlaying ?? {}
  assign(SLIT, wp, {
    rowFromTopPx: 'namesY',
    rowFromStopS: 'namesFromStopS',
    namesWalkMs: 'namesWalkMs',
    rowSlidesMs: 'nameSlideMs',
    tapZoomsOutMs: 'tapZoomOutMs',
    lossZoomsOutMs: 'lossZoomOutMs',
    winContinueBeforeBackMs: 'continueBeforeBackMs',
    eachWinnerLitMs: 'walkMs',
    allWinnersAtMostMs: 'walkWinnersMaxMs',
    notThisTimeFromTopPx: 'lossHeadY',
    timelineGrowsIntoContinueMs: 'pillGrowsMs',
    continueWordFromHeightPx: 'pillLettersFromPx',
  })
  SLIT.namesFromStopS = clamp(SLIT.namesFromStopS, -2, 0)
  SLIT.namesWalkMs = clamp(SLIT.namesWalkMs, 0, 3000)
  SLIT.pillGrowsMs = clamp(SLIT.pillGrowsMs, 0, 2000)
  SLIT.pillLettersFromPx = clamp(SLIT.pillLettersFromPx, 3, 47)
  SLIT.walkMs = clamp(SLIT.walkMs, 100, 3000)
  SLIT.walkWinnersMaxMs = clamp(SLIT.walkWinnersMaxMs, 100, 10000)
  SLIT.nameSlideMs = clamp(SLIT.nameSlideMs, 0, 1500)
  SLIT.tapZoomOutMs = clamp(SLIT.tapZoomOutMs, 0, 3000)
  SLIT.lossZoomOutMs = clamp(SLIT.lossZoomOutMs, 0, 4000)
  SLIT.continueBeforeBackMs = clamp(SLIT.continueBeforeBackMs, 0, 3000)
  /* the wedge: its size is the winners' and the margin; the rest is how its edge is lit */
  const wd = p.wedge ?? {}
  assign(SLIT, wd, {
    pastWinnersPx: 'wedgePadPx',
    wheelRadiusPx: 'rimPx',
    radiusPx: 'wedgeRadiusPx',
    fill: 'wedgeFill',
    grain: 'wedgeSpeckle',
    edgeWidthPx: 'wedgeEdgePx',
    tipAlpha: 'wedgeTipAlpha',
    innerAlpha: 'wedgeInnerAlpha',
    innerAt: 'wedgeInnerAt',
    outerAlpha: 'wedgeOuterAlpha',
    outerAt: 'wedgeOuterAt',
    edgeAlpha: 'wedgeEdgeAlpha',
    edgeLightsUpMs: 'wedgeMs',
  })
  SLIT.wedgeInnerAt = clamp(SLIT.wedgeInnerAt, 0, 1)
  SLIT.wedgeOuterAt = clamp(SLIT.wedgeOuterAt, 0, 1)
  if (wd.luminosity != null) SLIT.wedgeLuminosity = !!wd.luminosity
  for (const [dial, key] of [['fillColour', 'wedgeFillColour'], ['tipColour', 'wedgeTip'], ['innerColour', 'wedgeInner'], ['outerColour', 'wedgeOuter'], ['edgeColour', 'wedgeEdge']]) if (hex(wd[dial])) SLIT[key] = wd[dial]
  SLIT.wedgeEdgePx = clamp(SLIT.wedgeEdgePx, 0.5, 6)
  if (wd.grainOn != null) SLIT.wedgeGrain = !!wd.grainOn
  SLIT.wedgePadPx = clamp(SLIT.wedgePadPx, 0, 80)
  SLIT.rimPx = clamp(SLIT.rimPx, 60, 260)
  SLIT.wedgeRadiusPx = clamp(SLIT.wedgeRadiusPx, 0, 600)
  if (fitKey() !== before) slitActions.relayout?.() // the wedge and the zoom's fit are solved once per layout (the names' row and Continue bound it)
  /* the coin's way back and the order of things: live too — both are tables of these */
  const t = p.timing ?? {}
  assign(SLIT, t, {
    slitBendsMs: 'bendMs',
    coinCirclesMs: 'circleMs',
    coinSpiralsInMs: 'spiralMs',
    coinTurnsPerS: 'coinTurnsPerS',
    coinCircleRadiusPx: 'orbitPx',
    slitCircleRadiusPx: 'slitCirclePx',
    wheelStartsFromLandingMs: 'spinStartMs',
    ticketsAppearOverMs: 'ticketsSweepMs',
    yourCoinFallsAfterOthersMs: 'mineFallsAfterMs',
    slitToDotMs: 'collapseMs',
    slitBecomesLineMs: 'lineMs',
    wedgeFromBurstMs: 'wedgeFromHoleMs',
  })
  SLIT.collapseMs = clamp(SLIT.collapseMs, 100, 10000)
  SLIT.lineMs = clamp(SLIT.lineMs, 0, 5000)
  SLIT.wedgeFromHoleMs = clamp(SLIT.wedgeFromHoleMs, -3000, 3000)
  SLIT.mineFallsAfterMs = clamp(SLIT.mineFallsAfterMs, 0, 5000)
  SLIT.circleMs = clamp(SLIT.circleMs, 300, 6000)
  SLIT.spiralMs = clamp(SLIT.spiralMs, 300, 6000)
  SLIT.coinTurnsPerS = clamp(SLIT.coinTurnsPerS, 0.1, 6)
  SLIT.spinStartMs = clamp(SLIT.spinStartMs, -2000, 2000)
  SLIT.bendMs = clamp(SLIT.bendMs, 200, 4000)
  SLIT.slitCirclePx = clamp(SLIT.slitCirclePx, 60, 420)
  if (p.showWinOrLoss != null) SLIT.showWinOrLoss = !!p.showWinOrLoss // live: the scene reconciles it every frame
  if (p.pauseOnSlider != null) SLIT.pauseOnSlider = !!p.pauseOnSlider
  /* how many are playing and how many win: the same seed, a new ticket list
     of that length (or a new run of winners) — so the draw is dealt again */
  const n = p.players != null ? clamp(Math.round(Number(p.players)) || SLIT.n, 2, 5000) : SLIT.n
  const w = p.winners != null ? clamp(Math.round(Number(p.winners)) || SLIT.winners, 1, n - 1) : Math.min(SLIT.winners, n - 1)
  if (n !== SLIT.n || w !== SLIT.winners) {
    SLIT.n = n
    SLIT.winners = w
    slitActions.resize?.()
  }
  // the seed selector: a different value is a new seed, the same one is nothing
  if (OUTCOMES.includes(p.seed) && p.seed !== SLIT.outcome) {
    SLIT.outcome = p.seed
    slitActions.newSeed?.()
  }
}
export const slitSnapshot = () => ({})
export const slitSame = () => true
export const TICKET_FOLDERS = ['tickets', 'spinning', 'result', 'oneLit', 'names', 'selected', 'ticketLook']
export const SLIT_FOLDERS = [...TICKET_FOLDERS, 'look', 'arrow', 'burst', 'whosPlaying', 'wedge', 'timing']
export const SLIT_OPEN = new Set()
