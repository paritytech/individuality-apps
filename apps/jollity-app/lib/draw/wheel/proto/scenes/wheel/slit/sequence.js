// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE ORDER OF THINGS — when each beat of the Figma's story starts and how
   long it takes, in seconds from the hand-over (the coin at the swallow's
   depth, through the slit). A pure table of the timing dials, read every
   frame so they are live; nothing here knows a canvas.

   Nothing waits for the beat before it to finish: they overlap, so the whole
   reads as one movement rather than a list.

     0        the solid coin goes flat (handoff), under the slit's dark block
     bend     the slit bends into the bowl and closes into the circle (51 → 43)
     circle   the coin circles it (43) …
     collapse …while the closed circle collapses onto the hub, fading as it
              goes: gone by the dot, collapseMs from the moment it closed
     spin     the wheel starts — spinStartMs from the landing, before it by
              default: the tickets come on from yours round to the wedge, the
              timeline comes up (48)
     spiral   the coin spirals in onto its ticket, already turning
     seat     the coin lands on its ticket
     THE BLACK HOLE, where it went out: the black disc there at once, and
       explode  the glow bursting out from behind the disc to the hub's glow
                (explodeMs)
     wedge    the wedge's edge lights up from the hub out, wedgeFromHoleMs
              after the burst
     winner   WINNER (46) — on at once as the wedge finishes lighting, no fade (the hub's glow still eases
              to hubAfterPx over it)
     names    who's playing, and the walk through the winners: from the
              wheel's stop, on the spin's clock — walk.js

   Every ramp is a smoothstep — flat at both ends, so nothing starts or stops
   with a jolt. wheel-slit:timing checks the order and the stagger in node. */

export const ramp = (s, at, dur) => {
  const u = dur > 0 ? Math.max(0, Math.min(1, (s - at) / dur)) : s >= at ? 1 : 0
  return u * u * (3 - 2 * u)
}

/* the table for a set of dials (SLIT): every cue's start and length, s */
export function cuesFor(S) {
  const ms = (v) => Math.max(0, v) / 1000
  const handoff = ms(S.handoffMs)
  const bendAt = ms(S.bendAtMs)
  const bend = Math.max(0.2, ms(S.bendMs))
  const closed = bendAt + bend
  const circle = Math.max(0.3, ms(S.circleMs))
  const spiral = Math.max(0.3, ms(S.spiralMs))
  const seat = circle + spiral
  const spin = Math.max(0.2, seat + Math.max(-2000, Math.min(2000, S.spinStartMs)) / 1000)
  const wedge = Math.max(0.05, ms(S.wedgeMs))
  const winner = Math.max(0.05, ms(S.winnerMs))
  const off = (v) => Math.max(-3000, Math.min(3000, v ?? 0)) / 1000
  // the black hole: the circle collapses to a dot, the disc there with it, and the burst at the dot
  const dotAt = closed + Math.max(0.1, ms(S.collapseMs ?? 660))
  const explode = { at: dotAt, dur: Math.max(0.05, ms(S.explodeMs ?? 1800)) }
  const wedgeAt = Math.max(closed, explode.at + explode.dur + off(S.wedgeFromHoleMs))
  return {
    handoff,
    bend: { at: bendAt, dur: bend },
    cone: { at: bendAt, dur: Math.min(0.4, bend) }, //          the slit's light goes as it bends
    ring: { at: handoff + 0.05, dur: 0.4 }, //                   the coin's trail comes on
    shade: { at: Math.min(closed, handoff + 0.3), dur: 0.35 }, // the slit's dark block, once the coin is out from under it
    collapse: { at: closed, dur: dotAt - closed }, //            the slit's light down to a dot on the hub, the disc round it
    line: { at: closed, dur: ms(S.lineMs ?? 0) }, //          'fades to a line': its glow going, its hairline going plain white
    explode, //                                                 the glow bursting out from behind the disc
    circle,
    spiral,
    seat,
    spin,
    ticketsAt: spin, //  the tickets come on with the spin (the flip's come on with the wheel, before it)
    wedge: { at: wedgeAt, dur: wedge },
    winner: { at: wedgeAt + wedge, dur: winner }, // the moment the wedge's edge is fully lit
    bar: { at: spin, dur: 0.3 },
    sweep: ms(S.ticketsSweepMs),
    ticketIn: Math.max(0.05, ms(S.ticketInMs)),
  }
}

/* ticket k's arrival: d is how far round the wheel it is from yours, 0..1
   (half a turn away is 1, the far side) */
export const ticketAt = (cues, d) => cues.ticketsAt + Math.max(0, Math.min(1, d)) * cues.sweep

/* how far back your trail reaches, s: orbitMs while the coin circles and
   spirals in, wheelMs once it rides the wheel — eased from the one to the
   other from the landing, so it never jumps. The ease takes 1.5× the
   difference (at least 250 ms): the tail, at s − trailS, then never runs
   backward along the path, and never more than twice as fast as time. */
export function trailS(s, seat, orbitMs, wheelMs) {
  const a = orbitMs / 1000
  const b = wheelMs / 1000
  return Math.max(0.01, a + (b - a) * ramp(s, seat, Math.max(0.25, 1.5 * Math.abs(b - a))))
}

/* THE BURST'S SIZE, × the glow's settled size, eu 0 → 1 through it, in two
   beats: out to burstMaxX × its size by burstPeakMs of the burst's explodeMs
   on an ease out back (overshooting it by burstBack's c1, and back; 0: a
   plain ease out), then an ease out (cubic) down to its size by the end */
const easeOutBack = (x, c1) => 1 + (c1 + 1) * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2)
export function burstOut(eu, S) {
  const m = S.burstMaxX ?? 1
  const p = Math.max(0, Math.min(1, (S.burstPeakMs ?? 200) / Math.max(1, S.explodeMs ?? 3000)))
  if (eu <= 0) return 0
  if (eu < p) return m * easeOutBack(eu / p, S.burstBack ?? 0)
  if (p >= 1) return m
  const u = (eu - p) / (1 - p)
  return m + (1 - m) * (1 - Math.pow(1 - u, 3))
}
