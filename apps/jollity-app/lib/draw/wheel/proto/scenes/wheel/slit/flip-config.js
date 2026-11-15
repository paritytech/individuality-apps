// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE DRAW, FLIPPED — the flip's own tables. The page is the
   slit's (scene.js, with opening 'flip'), so everything from the landing on
   — the wheel, the spin, the zoom, the ending — reads SLIT, and the panel's
   look and wedge folders are the slit's own, through applySlit. What is here
   is what the slit page has no use for: the flip itself,
   and the order of things from the flip to the wedge. */

import { assign } from '../../../render-utils/dials.js'
import { applySlit, slitActions, TICKET_FOLDERS } from './config.js'

/* how you flip it: swipe it up off the top, or tap it and it jumps at you */
export const FLIP_BY = ['swipe up', 'tap']

export const FLIP = {
  by: 'tap', //                  one of FLIP_BY
  words: 'FLIP THE COIN', //    the words under the coin, in INSERT COIN's type (the page is the slit's dark ground, SLIT.bg, from the first frame — it never changes)
  coinY: 400, //                the coin at rest, its centre from the top, nominal px

  /* the flip */
  bobPx: 6, //                  the coin at rest floats up and down this far…
  bobMs: 2400, //               …once every this long
  swipeMinPxS: 500, //          swipe up: a let-go at least this fast upward flips it…
  swipeMinPx: 60, //            …or a drag at least this far up
  flyPxS: 1700, //              …thrown up at least this fast (faster if your finger was), slowing to a stop where it hangs
  flipTurnsPerS: 2.5, //        it turns over this many times a second as it goes
  hopPx: 120, //                tap: it hops up this far…
  jumpMs: 750, //               …and comes at you over this

  /* where it hangs, turning over in front of you, while the page comes on behind it */
  swipeHangY: 150, //           swiped: its centre, from the top, nominal px…
  swipeHangPx: 56, //           …and its radius (it went away from you: smaller)
  tapHangY: 422, //             tapped: its centre…
  tapHangPx: 150, //            …and its radius (it came at you: big)
  outTrailMs: 140, //           the trail behind it on its way up: the last this long of the way it went

  /* past the screen */
  escapePx: 0, //               while it is up, the coin is drawn this far past the screen's edges (nominal px; 0: cropped by the device frame)
  flyOver: true, //             toggle: instead of hanging, it keeps coming at you and flies on over your head, out of sight…
  overMs: 540, //               …taking this long…
  hideAtMs: 790, //             …hidden this long into the flight (or at its end, if that comes first; 0: at once)…
  overReturnPx: 730, //         …and comes back down from over you, this big at first (its radius), onto its ticket

  /* the order of things — ms from the moment it is up (hanging, or flying on over you) */
  backAtMs: 2700, //            the coin is back on its ticket — what follows is counted from here…
  landMs: 1490, //              …having come down from where it hangs (or from over you) over this long
  ticketsAtMs: 650, //          the wheel's tickets start coming on one by one round the circle, from the one next to yours — the last as it lands
  spinFromLandMs: -240, //      the wheel starts spinning this long after the coin lands (negative: before)
  wedgeFromLandMs: 400, //      the wedge, and WINNERS once it is lit, this long after the coin lands (negative: before)
  burstBeforeLandMs: 150, //    the glow bursting out from behind the black disc (there from the start, at the hub) — the slit's burst — this long before the coin lands
}

/* this page's own defaults for dials it shares with the slit page (SLIT):
   written over SLIT when the page boots (flip-scene.js), and the panel's
   defaults — so the slit page keeps its own */
export const FLIP_SLIT = {
  outcome: 'random',
  trailMs: 500,
  orbitTrailMs: 660,
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/* the page's buttons are the slit's (the scene fills them in create()) */
export const flipActions = slitActions

export function applyFlip(p) {
  /* the shared dials — the draw, the look, the wedge — as on the slit page;
     the draw's are in their own folder here, which the slit page has at the top */
  const d = p.draw ?? {}
  applySlit({ ...p, ...d })
  if (FLIP_BY.includes(d.flipBy)) FLIP.by = d.flipBy
  /* the flip: the order of things, from flying over you to the wedge */
  const f = p.flip ?? {}
  if (f.flyOverYou != null) FLIP.flyOver = !!f.flyOverYou
  assign(FLIP, f, {
    flyOverYouMs: 'overMs',
    hideCoinAtMs: 'hideAtMs',
    comesBackAtMs: 'backAtMs',
    ticketsStartAtMs: 'ticketsAtMs',
    comesBackFromOverYouRadiusPx: 'overReturnPx',
    wheelSpinsFromLandingMs: 'spinFromLandMs',
    wedgeFromLandingMs: 'wedgeFromLandMs',
    glowBurstsBeforeLandingMs: 'burstBeforeLandMs',
  })
  FLIP.overMs = clamp(FLIP.overMs, 150, 4000)
  FLIP.hideAtMs = clamp(FLIP.hideAtMs, 0, 4000)
  FLIP.backAtMs = clamp(FLIP.backAtMs, 200, 10000)
  FLIP.ticketsAtMs = clamp(FLIP.ticketsAtMs, 0, 10000)
  FLIP.overReturnPx = clamp(FLIP.overReturnPx, 20, 1200)
  FLIP.spinFromLandMs = clamp(FLIP.spinFromLandMs, -2000, 2000)
  FLIP.wedgeFromLandMs = clamp(FLIP.wedgeFromLandMs, -2000, 2000)
  FLIP.burstBeforeLandMs = clamp(FLIP.burstBeforeLandMs, 0, 2000)
  /* the rest: the gesture, where it hangs, the page, the screen's edges */
  const x = p.flipDetails ?? {}
  assign(FLIP, x, {
    swipeAtLeastPxPerS: 'swipeMinPxS',
    swipeOrDragUpPx: 'swipeMinPx',
    leavesAtLeastPxPerS: 'flyPxS',
    turnsOverPerS: 'flipTurnsPerS',
    tapHopsUpPx: 'hopPx',
    tapComesAtYouMs: 'jumpMs',
    trailMsOfTravel: 'outTrailMs',
    restBobPx: 'bobPx',
    swipedHangsAtYPx: 'swipeHangY',
    swipedHangsRadiusPx: 'swipeHangPx',
    tappedHangsAtYPx: 'tapHangY',
    tappedHangsRadiusPx: 'tapHangPx',
    drawnPastScreenEdgesPx: 'escapePx',
    coinComesDownOverMs: 'landMs',
  })
  FLIP.escapePx = clamp(FLIP.escapePx, 0, 1200)
  FLIP.swipeHangPx = clamp(FLIP.swipeHangPx, 8, 300)
  FLIP.tapHangPx = clamp(FLIP.tapHangPx, 8, 600)
  FLIP.flyPxS = clamp(FLIP.flyPxS, 200, 6000)
  FLIP.jumpMs = clamp(FLIP.jumpMs, 150, 4000)
  FLIP.outTrailMs = clamp(FLIP.outTrailMs, 0, 1000)
  FLIP.landMs = clamp(FLIP.landMs, 200, 5000)
}
export const flipSnapshot = () => ({})
export const flipSame = () => true
export const FLIP_FOLDERS = ['draw', 'flip', 'flipDetails', ...TICKET_FOLDERS, 'look', 'arrow', 'burst', 'whosPlaying', 'wedge']
export const FLIP_OPEN = new Set(['draw', 'flip'])
