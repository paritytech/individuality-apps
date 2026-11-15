// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE SLIT, BENDING INTO THE CIRCLE — one curve the whole way, never a
   circle laid over a slit.

   The slit is a straight hairline, `L0` long, at slitY. To become the circle
   it bends: it is always an ARC of a circle, its lowest point pinned where
   the coin went in, and two things grow with the progress m (0..1):

     its half-angle  α = π·m          0 is a straight line, π a closed ring
     its length      L = L0 + (2πR0 − L0)·m

   so its radius R = L / 2α starts at infinity (the straight slit), falls
   monotonically, and at m = 1 is exactly R0 = slitY − hubY: the closed circle
   sits on the hub, and from there on only its radius changes. The ends rise
   as it bends (a U, then the Figma's half-bowl near m = ½, frame 51) and meet
   at the top (frame 43).

   What is LIT is the circular segment between the arc and its chord: a
   sliver a hair thick at first — the slit opening — then the bowl, then the
   whole disc. The hairline is drawn along the arc itself.

   Everything is nominal stage px, y DOWN. An arc point is
   c + R·(sin φ, cos φ) for φ ∈ [−α, α] — φ = 0 is the bottom. No imports,
   so the suite checks it in node (wheel-slit:bowl). */

const TAU = Math.PI * 2
/* below this half-angle the arc is drawn as the straight line it nearly is:
   its ends sag L·α/4 (a third of a px at the slit's length), and R is past
   ten thousand px — no canvas arc to trust out there */
export const STRAIGHT_BELOW = 0.008

/* the bowl at progress m:
     cx, slitY  the slit's centre — the bottom, at every m (unless R0 moves it)
     hubY       where the closed circle's centre is
     L0         the straight slit's length
     R0         the closed circle's radius (default slitY − hubY: its bottom
                is the slit). Any other and the bottom slides from the slit
                to hubY + R0 as it bends, so the circle still closes on the hub
   → { m, alpha, L, R, c, R0, straight, chordY, halfW } — halfW is the
     chord's half-width (the ends' x from cx) */
export function bowlAt({ m, cx, slitY: y0, hubY, L0, R0: r0 }) {
  const u = Math.max(0, Math.min(1, m))
  const R0 = Math.max(1, r0 ?? y0 - hubY)
  const slitY = y0 + (hubY + R0 - y0) * u
  const alpha = Math.PI * u
  const L = L0 + (TAU * R0 - L0) * u
  if (alpha < STRAIGHT_BELOW) {
    return { m: u, alpha, L, R: Infinity, c: { x: cx, y: -Infinity }, R0, straight: true, chordY: slitY, halfW: L / 2 }
  }
  const R = L / (2 * alpha)
  const c = { x: cx, y: slitY - R }
  return { m: u, alpha, L, R, c, R0, straight: false, chordY: c.y + R * Math.cos(alpha), halfW: R * Math.sin(alpha) }
}

/* the arc's point at arc-length fraction f (−1 left end … 0 bottom … 1 right end) */
export function bowlPoint(b, f) {
  if (b.straight) return { x: b.c.x + (f * b.L) / 2, y: b.chordY }
  const phi = f * b.alpha
  return { x: b.c.x + b.R * Math.sin(phi), y: b.c.y + b.R * Math.cos(phi) }
}

/* how far (x, y) is from the arc itself, px — the hairline's curve */
export function distToArc(b, x, y) {
  if (b.straight) {
    const dx = Math.max(0, Math.abs(x - b.c.x) - b.L / 2)
    return Math.hypot(dx, y - b.chordY)
  }
  const dx = x - b.c.x
  const dy = y - b.c.y
  // the angle from the bottom, signed: inside the arc's span the nearest point is radial
  const phi = Math.atan2(dx, dy)
  if (Math.abs(phi) <= b.alpha) return Math.abs(Math.hypot(dx, dy) - b.R)
  const e1 = bowlPoint(b, -1)
  const e2 = bowlPoint(b, 1)
  return Math.min(Math.hypot(x - e1.x, y - e1.y), Math.hypot(x - e2.x, y - e2.y))
}

/* is (x, y) inside the lit segment — between the arc and its chord? */
export function inSegment(b, x, y, pad = 0) {
  if (b.straight) return Math.abs(x - b.c.x) <= b.L / 2 + pad && Math.abs(y - b.chordY) <= pad
  const d = Math.hypot(x - b.c.x, y - b.c.y)
  if (d > b.R + pad) return false
  // on the arc's side of the chord: the segment's axis points down, from c to the bottom
  return y - b.c.y >= b.R * Math.cos(b.alpha) - pad
}
