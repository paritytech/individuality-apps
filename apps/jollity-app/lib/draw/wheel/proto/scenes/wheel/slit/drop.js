// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE COIN'S WAY DOWN, FLIPPED — from where it hangs, turning over in front
   of you (flip.js's hangPose), onto its ticket on a wheel standing still.
   Its size goes as a thing going away from you does — 1/r eased, not r — so
   a big coin hanging close shrinks fast at first and settles gently; it
   speeds up out of the hang and slows onto the ticket.

   The same shape as orbit.js's orbitPath, so the scene's markers and its
   trail take either: at(s) → { x, y, r, psi, settle }, s in seconds from the
   start of the drop, and psiEnd. ψ is not an angle round the hub here (the
   way down is not round anything): it is how far along the way it has come,
   ending at the seat's own angle, so it only ever grows — which is all the
   trail asks of it — and the wheel's ψ carries on from it after the landing. */

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const smooth = (u) => u * u * (3 - 2 * u)
const PSI_PER_PX = 1 / 2000 // ψ per px of the way still to go: small, so the trail reads it as a straight one

export function dropPath({ start, hub, seat, landS }) {
  const end = { x: hub.x + seat.rho * Math.cos(seat.psi), y: hub.y + seat.rho * Math.sin(seat.psi) }
  const R0 = Math.max(seat.r, start.r)
  const T = Math.max(0.05, landS)
  const left = (x, y, r) => Math.hypot(end.x - x, end.y - y) + Math.abs(r - seat.r)
  const psiEnd = seat.psi
  function at(s) {
    const u = clamp01(s / T)
    const e = smooth(u)
    const x = start.x + (end.x - start.x) * e
    const y = start.y + (end.y - start.y) * e
    const r = 1 / (1 / R0 + (1 / seat.r - 1 / R0) * e)
    return { x, y, r, psi: psiEnd - left(x, y, r) * PSI_PER_PX, settle: clamp01((u - 0.6) / 0.4), u }
  }
  return { at, psiEnd, durS: T, start, end, startR: R0 }
}
