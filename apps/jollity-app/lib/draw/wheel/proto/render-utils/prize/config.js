// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE PRIZE REVEAL'S DIALS (render-utils/prize/). Distances are nominal stage
   px (390×844), times are ms. Live: the reveal reads this every frame, so a
   dial moves the reveal where it is rather than restarting it.

   The wheel plays it on these defaults, the same deal the coin has. To
   promote a look, paste it here. */
import { assign } from '../dials.js'

export const PRIZE = {
  /* the jump: off the host's disc, up in an arc, to rest in the middle */
  jumpMs: 1150, //       disc → rest
  arcPx: 177, //         how far the arc rises above the straight line
  restY: 360, //         where it comes to rest, px from the top
  coinR: 102, //         …and how big it is there
  coinThick: 15, //      the fall's coin (render-utils/fall/), at the prize's proportions — the prize's own is the lab's
  spinTurns: 4, //       whole turns about its upright axis on the way (whole, so it lands face-on)
  spinMs: 1940, //       …over this long, slowing onto its face
  bobPx: 4, //           then it floats: this far…
  bobMs: 2600, //        …once every this long

  /* the light on the fall's coin (render-utils/fall/). The prize's coin is
     the coin lab's, lit as the lab lights it (coin/lucky.js); its finish and
     lettering are in coin/look/ */
  keyLight: 1.7, //      the light up and to the left of it
  fillLight: 1.1, //     the even fill

  /* the type */
  headlineAtMs: 650, //  the headline comes up…
  chipAtMs: 1250, //     …the chip after it
  textFadeMs: 420, //    …each over this, rising textRisePx as it does
  textRisePx: 10,
  headlineY: 168, //     the headline's middle, px from the top
  chipGapPx: 34, //      the chip, this far under the coin

  /* the confetti, thrown up from the coin as it lands */
  confetti: true, //     toggle
  confettiCount: 420,
  confettiAtMs: 590, //  when it goes up, from wherever the coin has got to
  confettiSpeedPx: 950, // how hard it is thrown, px/s
  confettiSpreadDeg: 30, // the cone it is thrown in, either side of straight up
  gravityPx: 3240, //    px/s²
  drag: 2.13, //          per second: how fast the air takes the speed off it
  confettiMs: 6000, //   how long a piece lives (the last quarter of it, fading)
  confettiSizePx: 9.5,
  /* what it is made of: paper, or DISCS — the host's own discs round the one
     the coin came off, which come away with it, circle it on the way up and
     burst off it (the host passes them to play() as `others`) */
  confettiKind: 'discs', // one of CONFETTI_KINDS
  confettiColours: 'one colour', // one of CONFETTI_COLOURS: the host's, or monochrome
  confettiColour: '#ffffff', // the one colour, for 'one colour'
  discGatherMs: 1530, //  off their places and onto the ring round the coin
  discRingPx: 20, //     the ring: this far out from the coin's edge…
  discRingDepthPx: 80, // …and this deep
  discTurnsPerS: 0.45, // how fast they circle it
  discBurstAtMs: 3190, // when they fly off it (the coin is home at jumpMs)…
  discBurstPx: 740, //   …thrown out from its middle this hard, px/s, on top of the speed they had going round
  /* the squeeze before the burst: the ring pulls in on the coin, turning
     faster as it tightens, holds, and lets go */
  discSqueeze: true, //  toggle
  discSqueezeMs: 300, // how long it takes to pull in…
  discSqueezeHoldMs: 0, // …then held in, this long before the burst
  discSqueezeScale: 0.75, // the ring's gap from the coin's edge, pulled in, as a share of its own (0: tight on the rim)
  discSqueezeSpin: 3, // how many times faster it goes round, pulled in (1: no faster)
}

export const CONFETTI_KINDS = ['paper', 'discs']
export const CONFETTI_COLOURS = ['palette', 'one colour', 'the tint', 'silver']

export function applyPrizeDials(c = {}) {
  assign(PRIZE, c, {
    jumpMs: 'jumpMs',
    jumpArcPx: 'arcPx',
    restsAtPx: 'restY',
    coinRadiusPx: 'coinR',
    coinThicknessPx: 'coinThick',
    spinTurns: 'spinTurns',
    spinMs: 'spinMs',
    floatBobPx: 'bobPx',
    floatBobMs: 'bobMs',
    keyLight: 'keyLight',
    fillLight: 'fillLight',
    headlineAtMs: 'headlineAtMs',
    chipAtMs: 'chipAtMs',
    typeFadeMs: 'textFadeMs',
    typeRisesPx: 'textRisePx',
    headlineFromTopPx: 'headlineY',
    chipUnderCoinPx: 'chipGapPx',
    confettiPieces: 'confettiCount',
    confettiAtMs: 'confettiAtMs',
    confettiThrowPxPerS: 'confettiSpeedPx',
    confettiSpreadDeg: 'confettiSpreadDeg',
    gravityPxPerS2: 'gravityPx',
    airDragPerS: 'drag',
    confettiLivesMs: 'confettiMs',
    confettiSizePx: 'confettiSizePx',
    discGatherMs: 'discGatherMs',
    discRingPx: 'discRingPx',
    discRingDepthPx: 'discRingDepthPx',
    discTurnsPerS: 'discTurnsPerS',
    discBurstAtMs: 'discBurstAtMs',
    discBurstPx: 'discBurstPx',
    discSqueezeMs: 'discSqueezeMs',
    discSqueezeHoldMs: 'discSqueezeHoldMs',
    discSqueezeScale: 'discSqueezeScale',
    discSqueezeSpin: 'discSqueezeSpin',
  })
  if (c.confetti != null) PRIZE.confetti = !!c.confetti
  if (c.discSqueeze != null) PRIZE.discSqueeze = !!c.discSqueeze
  // the selects and the colours are strings: assign() would make them NaN
  const pick = (key, list) => {
    if (list.includes(c[key])) PRIZE[key] = c[key]
  }
  pick('confettiKind', CONFETTI_KINDS)
  pick('confettiColours', CONFETTI_COLOURS)
  if (typeof c.confettiColour === 'string') PRIZE.confettiColour = c.confettiColour
  PRIZE.spinTurns = Math.max(0, Math.round(Number(PRIZE.spinTurns) || 0))
  PRIZE.confettiCount = Math.max(0, Math.min(600, Math.round(Number(PRIZE.confettiCount) || 0)))
}
