// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE SPIN'S CLOCK — the automatic spin, planned whole, and the slow-mo that
   remaps the time it plays over.

   landing.js answers the let-go: a hand was on the wheel, it lets go at some
   angle and speed, and the wind-down is solved from there. This file answers
   the go with no hand on it — the panel's Draw again, and the wheel with its
   SPIN button off — where the whole spin is known before it starts: up to
   speed over upS, a cruise, and the same wind-down curve down to a dead stop.

   The one import is landing.js, which takes none, so this still loads bare in
   node. */

import { integrals, wheelAngleAt } from './landing.js'

const TAU = Math.PI * 2
const wrap = (a) => ((a % TAU) + TAU) % TAU
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
/* the spin-up's shape: smoothstep in SPEED, so there is no jerk at either
   end, and this is its integral — which is also the 'ease' wind-down's F */
const smooth = (x) => x * x * (3 - 2 * x)
const smoothInt = (x) => x * x * x - (x * x * x * x) / 2

/* THE AUTOMATIC SPIN, solved once and never nudged.

   Where landingFor keeps the duration and retargets the TOTAL — so the speed
   can step at the let-go — this keeps every duration exact and retargets the
   SPEED instead. The turn is ω·K, K being the three stretches' own areas
   (upS/2 + cruiseS + downS·(1 − F(1))), and ω is the speed nearest the dial
   that makes ω·K land the run under the wedge a whole number of turns on.
   Every stretch meets the next at the same speed, so nothing steps anywhere,
   and the spin takes exactly upS + cruiseS + downS — which is what lets the
   slow-mo and the zoom be timed against its end. */
export function profileFor({ from, targetPhi, turnsPerS, upS, cruiseS, downS, curve = 'ease', over = 1.70158 }) {
  const F = integrals[curve] ?? integrals.ease
  const up = Math.max(0.05, upS)
  const cruise = Math.max(0, cruiseS)
  const down = Math.max(0.2, downS)
  const K = up / 2 + cruise + down * (1 - F(1, over))
  const base = wrap(targetPhi - from)
  const want = Math.max(0.01, turnsPerS) * TAU
  let k = Math.max(0, Math.round((want * K - base) / TAU))
  if (base + TAU * k < 1e-6) k = 1 // already on it: one whole turn, never a spin of nothing
  const total = base + TAU * k
  return { kind: 'profile', from, total, omega: total / K, upS: up, cruiseS: cruise, downS: down, durS: up + cruise + down, curve, over }
}

/* THE THREE STRETCHES of a go that has to take `totalS`: up and down at
   their own dials and the cruise whatever is left — or, when the total is
   shorter than up + down alone, both shrunk in proportion and no cruise. The
   total is the dial you asked for, so it is the one that is always kept. */
export function stretchesFor({ totalS, upS, downS }) {
  const up = Math.max(0.05, upS)
  const down = Math.max(0.2, downS)
  const total = Math.max(0.25, totalS)
  if (up + down <= total) return { upS: up, cruiseS: total - up - down, downS: down }
  const k = total / (up + down)
  return { upS: up * k, cruiseS: 0, downS: down * k }
}

/* the profile's angle τ seconds in, clamped to its two ends like wheelAngleAt */
export function profileAngleAt(p, tau) {
  const F = integrals[p.curve] ?? integrals.ease
  const t = clamp(tau, 0, p.durS)
  const w = p.omega
  if (t <= p.upS) return p.from + w * p.upS * smoothInt(t / p.upS)
  let a = (w * p.upS) / 2
  if (t <= p.upS + p.cruiseS) return p.from + a + w * (t - p.upS)
  a += w * p.cruiseS
  if (t >= p.durS) return p.from + p.total // exactly, not to within a float
  const u = (t - p.upS - p.cruiseS) / p.downS
  return p.from + a + w * p.downS * (u - F(u, p.over))
}

/* …and its speed, from the same closed form (the wind-down's by a centred
   difference of F, which is exact enough and keeps F the only definition) */
export function profileOmegaAt(p, tau) {
  const F = integrals[p.curve] ?? integrals.ease
  const t = clamp(tau, 0, p.durS)
  if (t <= p.upS) return p.omega * smooth(t / p.upS)
  if (t <= p.upS + p.cruiseS) return p.omega
  const u = (t - p.upS - p.cruiseS) / p.downS
  const h = 1e-5
  const f = (F(Math.min(1, u + h), p.over) - F(Math.max(0, u - h), p.over)) / (Math.min(1, u + h) - Math.max(0, u - h))
  return p.omega * Math.max(0, 1 - f)
}

/* either kind of go, answered the same way — the scene holds one of these
   and does not care which */
export const motionAngleAt = (m, tau) => (m.kind === 'profile' ? profileAngleAt(m, tau) : wheelAngleAt(m, tau))

/* THE SLOW-MO: a remap from real seconds since the go to the spin's own
   seconds. 1:1 up to startS, then eased over blendS down to `factor` (the
   same smoothstep, in speed), and held there to the stop. It only remaps the
   CLOCK — the spin is still the spin, so where the wheel stops cannot move —
   and the phase slider keeps measuring spin time. A startS below zero means
   the slow-mo was already running when this warp was made (a re-solve
   mid-spin): it starts at `factor`, with no blend.

   factor 1 is the identity, which is what a warp with the toggle off is. */
export function warpFor({ durS, startS, factor = 1, blendS = 0.25 }) {
  const f = clamp(factor, 0.05, 1)
  const dur = Math.max(1e-6, durS)
  if (f >= 1 || startS >= dur) {
    return { startS, factor: 1, realDurS: dur, tau: (r) => clamp(r, 0, dur), realAt: (t) => clamp(t, 0, dur), rate: () => 1 }
  }
  const s = Math.max(0, startS)
  const B = startS < 0 ? 0 : Math.max(0, Math.min(blendS, (2 * (dur - s)) / (1 + f)))
  const tauB = s + (B * (1 + f)) / 2 // spin time at the end of the blend
  const realDurS = s + B + (dur - tauB) / f
  const tau = (r) => {
    if (r <= 0) return 0
    if (r <= s) return r
    if (r <= s + B) {
      const x = (r - s) / B
      return s + B * (x + (f - 1) * smoothInt(x))
    }
    return Math.min(dur, tauB + f * (r - s - B))
  }
  const realAt = (t) => {
    const c = clamp(t, 0, dur)
    if (c <= s) return c
    if (c > tauB) return s + B + (c - tauB) / f
    // inside the blend: tau is monotonic in x, so a bisection is exact enough
    let lo = 0
    let hi = 1
    for (let i = 0; i < 48; i++) {
      const mid = (lo + hi) / 2
      if (s + B * (mid + (f - 1) * smoothInt(mid)) < c) lo = mid
      else hi = mid
    }
    return s + B * ((lo + hi) / 2)
  }
  const rate = (r) => (r < s ? 1 : r < s + B ? 1 + (f - 1) * smooth((r - s) / B) : f)
  return { startS, factor: f, realDurS, tau, realAt, rate }
}
