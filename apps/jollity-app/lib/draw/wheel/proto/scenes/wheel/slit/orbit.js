// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE COIN'S WAY BACK — from going down through the slit to riding its
   ticket on a wheel that is already turning, as one closed form of time
   with no corner in it, and never a stop.

   It is the swallow carried on: the coin leaves the slit's depth going
   straight DOWN at the speed the swallow ended at, swings out and round into
   a circle just outside the ring the slit became — speeding up to its own
   pace as it goes — circles, and spirals in to meet its ticket, which is
   already turning with the wheel: it arrives exactly where the ticket is, at
   exactly the ticket's speed, so from that instant the wheel simply carries
   it on.

   Polar about the hub, y DOWN, ψ clockwise from three o'clock (six o'clock
   is π/2), unwrapped — the coin only ever goes clockwise, the way the wheel
   turns (SPIN −1):

     circling  ψ' rises from 0 to ω (smoothstep in speed, over upS) and holds;
               ρ is a Hermite out of the swallow (slope: its speed) to the
               circle's radius (slope 0) over half the circling, then holds
     spiral    ψ is a cubic Hermite from (ψ, ω) to the ticket's (angle, speed)
               at the landing — a whole number of extra turns chosen so its
               speed only ever blends between the two plus a bump, never
               backwards; ρ a quintic smootherstep down to the ticket's
               radius, flat at both ends

   So the velocity is continuous everywhere, and at the landing it IS the
   ticket's. wheel-slit:orbit checks it in node. */

import { integrals } from '../landing.js'

const TAU = Math.PI * 2
const clamp01 = (v) => Math.max(0, Math.min(1, v))
const smooth = (u) => u * u * (3 - 2 * u)
const quintic = (u) => u * u * u * (u * (6 * u - 15) + 10)
const smoothInt = integrals.ease // ∫ smoothstep: the spin-up's own shape (timing.js's)

/* hub        { x, y } — the circle's centre, which is the wheel's
   from       { x, y, r, vy } — the coin at the swallow's depth, and how fast it was going down
   orbitR     the circle it circles on, radius
   orbitSize  the coin's radius while it circles
   seat       its ticket at the landing: { rho, r, psi, omega } — distance from
              the hub, the ticket's radius, its angle and its speed (rad/s,
              ≥ 0: 0 for a wheel not yet turning)
   omegaC     how fast it circles, rad/s
   circleS    seconds circling (from the hand-over), spiralS seconds spiralling in
   upS        the spin-up, within the circling */
export function orbitPath({ hub, from, orbitR, orbitSize, seat, omegaC, circleS = 1.5, spiralS = 1.3, upS = 0.45 }) {
  const circle = Math.max(0.3, circleS)
  const spiral = Math.max(0.3, spiralS)
  const up = Math.max(0.05, Math.min(upS, circle * 0.8))
  /* the radius comes in over longer than the speed comes up: the circle is
     nearer the hub than the swallow's depth, and pulled in over the spin-up
     alone the coin would all but stop and turn back; over this it swings out
     and round instead */
  const T1 = Math.max(up, Math.min(circle, circle * 0.55))
  const w = Math.max(0, omegaC)
  const ws = Math.max(0, seat.omega ?? 0)
  const dur = circle + spiral

  const dx0 = from.x - hub.x
  const dy0 = from.y - hub.y
  const psi0 = Math.atan2(dy0, dx0) // π/2: straight under the hub
  const rho0 = Math.hypot(dx0, dy0)
  const v0 = Math.max(0, (from.vx ?? 0) * Math.cos(psi0) + (from.vy ?? 0) * Math.sin(psi0))

  /* circling: the angle on the spin-up's own curve, then steady */
  const U = (t) => (t < up ? up * smoothInt(t / up) : up / 2 + (t - up))
  const psiCircle = (t) => psi0 + w * U(t)
  const psiC = psiCircle(circle)

  /* the spiral's end: the ticket's angle, a whole number of turns on, picked
     so the average speed is at least the mean of the two ends — the Hermite's
     speed is then their blend plus a bump, and never goes backwards */
  const want = psiC + (spiral * (w + ws)) / 2
  const psiEnd = seat.psi + TAU * Math.ceil((want - seat.psi) / TAU)
  const dPsi = psiEnd - psiC

  function psiAt(t) {
    if (t <= 0) return psi0
    if (t < circle) return psiCircle(t)
    if (t >= dur) return psiEnd + ws * (t - dur) // past the landing: the wheel's (the scene takes over there)
    const u = (t - circle) / spiral
    const u2 = u * u
    const u3 = u2 * u
    return psiC * (2 * u3 - 3 * u2 + 1) + spiral * w * (u3 - 2 * u2 + u) + psiEnd * (-2 * u3 + 3 * u2) + spiral * ws * (u3 - u2)
  }
  function omegaAt(t) {
    if (t <= 0) return 0
    if (t < circle) return t < up ? w * smooth(t / up) : w
    if (t >= dur) return ws
    const u = (t - circle) / spiral
    return (dPsi / spiral) * 6 * u * (1 - u) + w * (3 * u * u - 4 * u + 1) + ws * (3 * u * u - 2 * u)
  }

  /* ρ: out of the swallow at its own (radial) speed to the circle over the
     spin-up — a cubic Hermite, which may swing a little past the swallow's
     depth before it comes in — then the circle, then the spiral in */
  function rhoAt(t) {
    if (t <= 0) return rho0 + v0 * t
    if (t < T1) {
      const u = t / T1
      const u2 = u * u
      const u3 = u2 * u
      return rho0 * (2 * u3 - 3 * u2 + 1) + T1 * v0 * (u3 - 2 * u2 + u) + orbitR * (-2 * u3 + 3 * u2)
    }
    if (t < circle) return orbitR
    return orbitR + (seat.rho - orbitR) * quintic(clamp01((t - circle) / spiral))
  }
  function sizeAt(t) {
    if (t < T1) return from.r + (orbitSize - from.r) * smooth(clamp01(t / T1))
    if (t < circle) return orbitSize
    return orbitSize + (seat.r - orbitSize) * quintic(clamp01((t - circle) / spiral))
  }

  /* where it is at t seconds from the hand-over, nominal px — with ψ, ρ,
     its radius, its speed, and how far into the spiral it is (0 → 1) */
  function at(t) {
    const psi = psiAt(t)
    const rho = rhoAt(t)
    return {
      x: hub.x + rho * Math.cos(psi),
      y: hub.y + rho * Math.sin(psi),
      r: sizeAt(t),
      psi,
      rho,
      omega: omegaAt(t),
      settle: quintic(clamp01((t - circle) / spiral)),
    }
  }
  /* the time ψ was at a given angle (ψ never goes back): for the trail */
  function timeAtPsi(psi) {
    if (psi <= psi0) return 0
    if (psi >= psiEnd) return dur
    let lo = 0
    let hi = dur
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2
      if (psiAt(mid) < psi) lo = mid
      else hi = mid
    }
    return (lo + hi) / 2
  }

  return { at, psiAt, omegaAt, rhoAt, timeAtPsi, durS: dur, circleS: circle, spiralS: spiral, upS: up, inS: T1, psi0, psiEnd, orbitR }
}
