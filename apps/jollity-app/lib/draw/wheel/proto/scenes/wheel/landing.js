// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE LANDING — solved in closed form, shared by every placement.

   A ringed layout (one ring filled before the next, at the on-ring pitch
   2pi/per) was tried and dropped: it cannot show the wedge as a pie slice,
   and one case — a run wrapping n-1 -> 0 through the short last ring — is
   uncoverable by any rotation.

   No imports at all: every tunable is a parameter with a default, so the file
   stays checkable with `node -e`. */

const TAU = Math.PI * 2
const wrap = (a) => ((a % TAU) + TAU) % TAU

/* the integral of the wind-down's own speed curve, written out here: this
   file takes no imports at all by design.
   Exported for timing.js, whose wind-down is the same curve. */
export const integrals = {
  linear: (u) => (u * u) / 2,
  ease: (u) => u * u * u - (u * u * u * u) / 2,
  bounce: (u, over = 1.70158) => {
    const c1 = over
    const c3 = c1 + 1
    return u + (c3 * (Math.pow(u - 1, 4) - 1)) / 4 + (c1 * (Math.pow(u - 1, 3) + 1)) / 3
  },
}

/* the wind-down's shape:
   (u - F(u)) / (1 - F(1)) - full speed at u=0, dying to a dead stop (zero
   slope) exactly at u=1, WHATEVER the total distance turns out to be. That
   last part is what this file leans on: the total can be retargeted without
   retiming the die-down. */
export function wheelRollProgress(curve, u, over = 1.70158) {
  const F = integrals[curve] ?? integrals.ease
  return (u - F(u, over)) / Math.max(0.05, 1 - F(1, over))
}

/* solved once, when the wheel is set going - never re-solved, never nudged.

   wheelRollProgress is the time-shape: full speed at u=0, dying to a dead
   stop (zero slope) exactly at u=1, WHATEVER the total distance turns out to
   be. That is what this leans on - the total can be retargeted without
   retiming the die-down, so the landing is exact AND a pure function of
   elapsed time, which is what makes scrubbing it backwards honest.

   thetaRelease/omega0 are the wheel's own angle and speed at the instant it
   is let go. Set going by a button rather than by a gesture, omega0 is 0 and
   the whole turn is the gap to the target plus the spectacle turns.

   The trade-off, stated rather than hidden: `total` will not generally equal
   what a free coast from omega0 would have turned, so the angular speed can
   step at the instant of release. Holding duration AND curve fixed while
   retargeting the total is what keeps "the wheel always takes about durS to
   stop" true - matching the release speed exactly would mean solving a
   bespoke duration per spin instead. The wedge's promise - fixed, on-chain,
   exact - outranks a smooth handoff off a physically arbitrary hold. */
export function landingFor({ targetPhi, thetaRelease, omega0 = 0, durS, curve = 'ease', over = 1.70158, extraTurns = 0 }) {
  const F = integrals[curve] ?? integrals.ease
  const dNatural = durS * omega0 * (1 - F(1, over))
  const extra = wrap(targetPhi - thetaRelease - dNatural)
  const total = dNatural + extra + TAU * Math.max(0, Math.round(extraTurns))
  return { thetaRelease, total, durS, curve, over }
}


/* the wheel's absolute angle τ seconds after the let-go (τ < 0 or > durS is
   clamped to the endpoints — before release the caller has no landing to
   ask this of yet; after it, the wheel is at rest exactly on the target). */
export function wheelAngleAt(landing, tau) {
  const u = Math.min(1, Math.max(0, tau / Math.max(1e-6, landing.durS)))
  return landing.thetaRelease + landing.total * wheelRollProgress(landing.curve, u, landing.over)
}
