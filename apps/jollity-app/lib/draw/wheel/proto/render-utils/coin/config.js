// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE COIN'S DIALS. Distances are nominal stage px (390×844); the whole scene
   scales with the frame like everything else. Live: the coin and the slot read
   this every frame — a dial moves things, nothing resets (replay() replays).

   Not here: the settle and the other tickets belong to whatever the coin is
   handed over to, so they live with that host (the wheel has its own two).

   The coin itself is the coin lab's Lucky coin (look/look.js LUCKY_LOOK,
   played by lucky.js): its look — thickness, letters, colours, light — is
   that table's, and only its size is a dial here. It is bigger than the
   sphere's 56, so the slot's mouth and glow are grown with it (× 100/56) and
   the coin still fits through the slit.

   fov and bloom are here because a coin without a sphere has nobody to borrow
   a camera from: both are the Lucky coin's, as the lab shows it (its lens, and
   its glint glow of 0 — no bloom). Not dials — nothing on the page changes
   them. */
import { assign } from '../dials.js'
import { NOMINAL } from '../layout.js'
import { LUCKY_LOOK } from './look/look.js'

export const COIN = {
  launchDelayMs: 400, //   the coin waits below the edge this long
  launchMs: 1480, //       …then rises to homeY over this, slowing to a stop at the top
  slotInAtMs: 740, //      the slit — glow, hairline, chevron, hint, dark block — comes up (300 ms, fixed) this long after the rise begins
  chevronPx: 22, //        the down chevron's size
  launchTurns: 10, //      whole flips on the way up (rounded to land face-on); it rises straight, no sway
  homeY: 394, //           where it levitates (px from the top)
  coinR: LUCKY_LOOK.coinR, // the coin's radius (the Lucky coin's, 100); its thickness is the look's, × this
  coinLight: 3, //         how hard the slit lights the coin from below as it comes in (0 while it floats, falling off with distance)
  coinFill: 1, //          not the intro's any more (the lab's studio lights it): coin.js's slitLight, for its other hosts
  bobDelayMs: 100, //      levitation: a beat still at home after the launch lands, before it bobs…
  bobPx: 9, //             …how far it bobs…
  bobMs: 1800, //          …one bob's period…
  bobCurve: 'inOut', //    …and the curve of each half-bob: inOut | in | out | linear
  turnHalfTurnPx: 390, //  drag sideways: this far is half a turn about the upright, and let go it settles on the nearer face (the lab's hand: 390 is the stage's width)
  flick: false, //         toggle: a fast finger flicks the coin into a spin instead of dragging it
  flickSpeedPx: 1600, //   a finger faster than this (px/s) is flicking: the coin does not follow it, and spins on release
  flickGain: 0.02, //      rad/s of spin per px/s of flick
  spinTauMs: 300, //       the spin's decay time constant (the sweep is rounded to half-turns, so it lands face-on)
  homeK: 250, //           the spring that brings the coin home after a release…
  homeC: 8, //             …and its damping
  springBack: true, //     toggle: let go short of the slot, the coin springs back home; off, the slot takes it from wherever it was let go
  slotBottomPx: 160, //    the slot mouth, px up from the bottom of the stage
  /* …and as everything that places it reads it: px from the top. The stage
     is 844 nominal px tall at any window (the scale is its height's), so the
     bottom is always there. Set, it moves the dial. */
  get slotY() {
    return NOMINAL.H - this.slotBottomPx
  },
  set slotY(v) {
    this.slotBottomPx = NOMINAL.H - v
  },
  slotWidthPx: 264, //     the mouth's width (the hairline and the dark block)
  glowWidthPx: 218, //     the glow's own width (its box is 1.5× this, 0.8× tall)
  capturePx: -40, //       gap (coin's bottom edge → mouth) at which the slot takes it, mid-drag or on release
  glowStartPx: 265, //     the slot's light starts growing from this gap down
  restGlow: 0.37, //       the glow's alpha with nothing near it…
  slotGlow: 1, //          …and with the coin at the mouth (0..1)
  shadeA: 0.8, //          the dark block under the mouth (bg colour): its alpha — the coin dims behind it instead of being cut
  swallowMs: 1400, //      the swallow: from the catch down to the hand-over depth over this, leaving at the drag's speed and slowing
  handoffAt: 2.45, //       the swallow's depth: the host takes over when the coin's centre is this far under the mouth (× coinR); the glow is at its max there
  hitPadPx: 16, //         the coin's hit target reaches this far past its edge
  /* the flight (flight.js): from the swallow to the disc it becomes on the
     wheel, and the wheel coming up behind it — the coin page lands it on a
     stand-in, the flow page on the real wheel, both on these */
  flightTurns: 4, //       whole turns about the wheel's centre, after the swallow
  flightMs: 2600, //       …over this long, arriving at rest on the disc
  flightFadeMs: 600, //    the rest of the wheel, coming up once it lands
  /* the stage the coin is rendered on, when it brings its own — the lab's
     lens, so the perspective on the tumble is the one the coin was looked at in */
  fov: LUCKY_LOOK.lens,
  bloom: { intensity: LUCKY_LOOK.glow, threshold: 1, radius: 0.5 },
}
export const BOB_CURVES = ['inOut', 'in', 'out', 'linear']

/* the coin's dials into COIN. A host calls this from its own apply(), with
   the panel's coin folder: the dials are named for what they do to the scene,
   in units; the config keys stay terse. The toggle and the bob curve are the
   only things that are not a number, and assign() runs everything through
   Number(), so they are read by hand. */
export function applyCoinDials(c = {}) {
  assign(COIN, c, {
    coinLaunchDelayMs: 'launchDelayMs',
    launchMs: 'launchMs',
    launchFlips: 'launchTurns',
    slitAppearsAtMs: 'slotInAtMs',
    chevronPx: 'chevronPx',
    floatAtPx: 'homeY',
    coinRadiusPx: 'coinR',
    coinLitFromSlit: 'coinLight',
    floatBobPx: 'bobPx',
    floatBobMs: 'bobMs',
    floatBobDelayMs: 'bobDelayMs',
    dragSidewaysHalfTurnPx: 'turnHalfTurnPx',
    flickIfFasterThanPxPerS: 'flickSpeedPx',
    flickSpinStrength: 'flickGain',
    flickSpinFadeMs: 'spinTauMs',
    springBackStiffness: 'homeK',
    springBackDamping: 'homeC',
    slotFromBottomPx: 'slotBottomPx',
    slotWidthPx: 'slotWidthPx',
    glowWidthPx: 'glowWidthPx',
    slotCatchesWithinPx: 'capturePx',
    glowWakesWithinPx: 'glowStartPx',
    glowAlphaAtRest: 'restGlow',
    glowAlphaAtSlot: 'slotGlow',
    slitShadeAlpha: 'shadeA',
    swallowMs: 'swallowMs',
    swallowToDepth: 'handoffAt',
    spinsToYourDisc: 'flightTurns',
    placeYourDiscMs: 'flightMs',
    wheelFadesInMs: 'flightFadeMs',
  })
  COIN.flightTurns = Math.max(0, Math.min(12, Number(COIN.flightTurns) || 0))
  COIN.flightMs = Math.max(200, Math.min(8000, Number(COIN.flightMs) || 2600))
  COIN.flightFadeMs = Math.max(0, Math.min(3000, Number(COIN.flightFadeMs) || 0))
  if (c.letGoSpringsBack != null) COIN.springBack = !!c.letGoSpringsBack
  if (c.flick != null) COIN.flick = !!c.flick
  if (typeof c.floatBobCurve === 'string' && BOB_CURVES.includes(c.floatBobCurve)) COIN.bobCurve = c.floatBobCurve
}
