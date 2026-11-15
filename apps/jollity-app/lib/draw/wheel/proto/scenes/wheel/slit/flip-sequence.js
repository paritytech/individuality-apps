// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE ORDER OF THINGS, FLIPPED — the flip page's cues, in seconds from the
   coin getting up (hanging, or flying on over you). The same fields as
   sequence.js's cuesFor, so the scene reads either table the same way; the
   slit's own beats (the bend, its light, its dark block) have no place here
   and are left out.

     0         the coin is up (the page dark all along, the black disc on the hub)
     ticketsAt the wheel's tickets start coming on, one by one round the
               circle from the one next to yours all the way round, the
               last just as the coin lands — so the coin closes the circle
     drop      the coin starts back down onto its ticket (landMs before…)
     explode   the glow bursts out from behind the disc, as the slit's
               does — burstBeforeLandMs before…
     seat      …it lands: backAtMs, the moment everything after is counted from
     spin      the wheel starts — spinFromLandMs from the landing (negative: before)
     wedge     the wedge comes on — wedgeFromLandMs from the landing — and
               WINNERS once it is lit

   wheel-flip:timing checks the order in node. */

import { ramp } from './sequence.js'

export { ramp }

export function flipCuesFor(F, S) {
  const ms = (v) => Math.max(0, v) / 1000
  const off = (v) => Math.max(-2000, Math.min(2000, v)) / 1000
  const seat = Math.max(0.2, ms(F.backAtMs))
  // the way down: landMs long, ending at the landing — but not starting before the coin is up
  const drop = Math.max(0, seat - Math.max(0.2, ms(F.landMs)))
  const land = seat - drop
  // the tickets: from their start to the landing, the last fully on as the coin lands
  const ticketIn = Math.min(0.3, seat / 3)
  const ticketsAt = Math.min(ms(F.ticketsAtMs), seat - ticketIn)
  const sweep = Math.max(0, seat - ticketIn - ticketsAt)
  // the wheel may start before the coin is down, but not before it has started back
  const spin = Math.max(drop + 0.05, seat + off(F.spinFromLandMs))
  const wedgeAt = Math.max(0, seat + off(F.wedgeFromLandMs))
  const wedge = Math.max(0.05, ms(S.wedgeMs))
  const winner = Math.max(0.05, ms(S.winnerMs))
  return {
    wheel: { at: ticketsAt, dur: Math.max(0.05, seat - ticketsAt) }, // the wheel comes on over the sweep
    explode: { at: Math.max(0, seat - Math.min(2, ms(F.burstBeforeLandMs))), dur: Math.max(0.05, ms(S.explodeMs)) }, // the slit's burst, just before the landing
    ticketsAt,
    sweep,
    ticketIn,
    drop,
    land,
    seat,
    spin,
    wedge: { at: wedgeAt, dur: wedge },
    winner: { at: wedgeAt + wedge, dur: winner },
    ring: { at: drop, dur: 0.3 }, // the coin's trail comes on
    bar: { at: spin, dur: 0.3 },
  }
}
