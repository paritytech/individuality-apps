// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE FALL'S DIALS (render-utils/fall/). Distances are nominal stage px
   (390×844), times are ms. Live: the outro reads this every frame, so a dial
   moves it where it is rather than restarting it.

   The flow plays it on these defaults, the same deal the prize has. To
   promote a look, paste it here. The words it shows are the host's. */

export const FALL = {
  /* the coin: off the host's disc, end over end, and back onto it */
  flipMs: 900,
  flipTurns: 3, //      halves count: the coin is blank both sides
  flipUpPx: 90, //      how high above the disc it jumps
  flipPeakPx: 26, //    its radius at the top of the jump
  landAsDisc: true, //  toggle: it lands back at the size of the disc it came off (off: at flipLandPx)
  flipLandPx: 9, //     …and once it is back on the disc, with landAsDisc off

  /* the headline, from the landing */
  headY: 168, //        its middle, px from the top
  fadeMs: 420, //       coming up over this, rising as it does

  /* every other disc, falling off the page */
  fall: true, //        toggle
  fallAfterMs: 600, //  this long after the coin lands
  fallOrder: 'from yours out', // one of FALL_ORDERS
  fallStaggerMs: 900, // the first to go to the last
  fallKickPx: 260, //   px/s, each one thrown up as it goes…
  fallSpreadDeg: 50, // …in a cone this wide either side of straight up
  fallGravityPx: 2600, // px/s²
  fallDrag: 1.2, //     per second: how fast the air takes the speed off them
  fallTumble: true, //  toggle: they turn over as they fall
}

/* the order the discs fall in — 'from yours out' is nearest the coin first */
export const FALL_ORDERS = ['from yours out', 'random', 'top first', 'all at once']

export const FALL_KEYS = new Set(Object.keys(FALL))
