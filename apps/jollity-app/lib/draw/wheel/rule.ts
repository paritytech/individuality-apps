// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE DRAW RULE, checked against the chain before the wheel may show it.
 *
 * The airdrop pallet of the individuality runtime (`draw_winners_authorized`): every entry is a 32-byte slot
 * in `Airdrop.Registrations`, kept in ascending order; the entropy captured at
 * draw time (`Airdrop.EventEntropy`) is a cut in that order, and the winners
 * are the next `effective_winners` slots from it, clockwise, wrapping round —
 * `iter_prefix_from(target)` chained with `iter_prefix`. The draw code's
 * `ranksFor` is the same rule (lib/draw/wheel/proto/scenes/wheel/draw.js), so
 * the wheel lands where the chain did.
 *
 * The wheel only ever SHOWS the chain's result, never decides it: `won` and
 * the winners come from storage. This file answers one question — would the
 * wheel, run on these tickets and this target, land on exactly those winners?
 * If not (a rule change, a partial read), the page shows the plain result
 * instead of a wheel that contradicts it.
 */

/** a slot as the wheel compares it: 64 lowercase hex chars, no prefix */
export const slotHex = (hex: string): string => hex.replace(/^0x/i, "").toLowerCase()

/** the slots the rule picks, in the order it picks them */
export function winnersByRule(tickets: readonly string[], target: string, winners: number): string[] {
  const sorted = tickets.map(slotHex).sort()
  const n = sorted.length
  if (n === 0 || winners <= 0) return []
  const cut = slotHex(target)
  // first slot >= target; equal-length lowercase hex sorts as the number does
  let lo = 0
  let hi = n
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if ((sorted[mid] as string) >= cut) hi = mid
    else lo = mid + 1
  }
  return Array.from({ length: Math.min(winners, n) }, (_, i) => sorted[(lo + i) % n] as string)
}

export interface WheelCheck {
  ok: boolean
  /** why the wheel cannot show this draw, for the debug sheet */
  reason: string | null
  /** the refusal as a fixed word, for telemetry */
  code: "not-in-draw" | "winners-disagree" | "result-disagree" | null
}

/**
 * Can the wheel tell THIS draw truthfully? The player's ticket must be in it
 * (or, with no ticket, they watch as a spectator and must not have won), the
 * rule must pick exactly the chain's winners, and it must agree with the
 * chain's `won`.
 */
export function checkWheel(draw: {
  tickets: readonly string[]
  target: string
  winners: number
  mine: string
  winningTickets: readonly string[]
  won: boolean
}): WheelCheck {
  const mine = slotHex(draw.mine)
  const tickets = draw.tickets.map(slotHex)
  // no ticket = a SPECTATOR: they watch the draw, and the chain must agree
  // they did not win it
  if (!mine && draw.won) return { ok: false, reason: "the chain says the player won, but they hold no ticket", code: "result-disagree" }
  if (mine && !tickets.includes(mine)) return { ok: false, reason: "the player's ticket is not in the draw", code: "not-in-draw" }
  const picked = winnersByRule(tickets, draw.target, draw.winners)
  const chain = new Set(draw.winningTickets.map(slotHex))
  if (picked.length !== chain.size || picked.some((slot) => !chain.has(slot)))
    return { ok: false, reason: `the rule picks ${picked.length} winners the chain does not agree with`, code: "winners-disagree" }
  if (mine && picked.includes(mine) !== draw.won) return { ok: false, reason: "the rule and the chain disagree on the player's result", code: "result-disagree" }
  return { ok: true, reason: null, code: null }
}
