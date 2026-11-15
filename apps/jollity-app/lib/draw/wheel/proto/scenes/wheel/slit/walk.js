// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE WALK — once the wheel stops, who's playing comes on, and the winners
   are lit one by one, left to right — you among them where you are, if you
   won — and then you, last, win or lose. A closed form of the seconds from
   the stop (t; negative before it), so the timeline's scrub replays it and
   ?at= freezes it. Pure: the suite checks it in node.

     names   the row comes on from namesFromStopS (−2…0): the names on the
             stage one by one, all of them over namesWalkMs, the rest with
             the last of them; each over NAME_IN
     walk    from the later of the stop and the last name in: each winner
             walkMs, left to right — but all of them in walkWinnersMaxMs at
             most, shared evenly between them…
     you     …then you, walkMs
     free    then it stays on you — the ending's turn (the prize, or Not
             this time), and Continue */

export const NAME_IN = 0.3 // a name's fade and rise, s

/* the plan, made once per row: order is the row (left to right), visible
   which of them are on the stage when it comes on, winners and mine the
   draw's. Seconds from the stop */
export function walkPlan({ order, visible, winners, mine, S }) {
  const from = Math.max(-2, Math.min(0, S.namesFromStopS))
  const shown = visible.filter(Boolean).length
  const every = shown > 1 ? Math.max(0, S.namesWalkMs) / 1000 / (shown - 1) : 0
  const nameAt = new Float32Array(order.length)
  let j = 0
  for (let i = 0; i < order.length; i++) if (visible[i]) nameAt[i] = from + every * j++
  const last = from + every * Math.max(0, j - 1)
  for (let i = 0; i < order.length; i++) if (!visible[i]) nameAt[i] = last
  const isWinner = new Set(winners)
  const steps = order.filter((k) => isWinner.has(k))
  steps.push(mine)
  const youStep = Math.max(0.1, S.walkMs / 1000)
  const most = (S.walkWinnersMaxMs ?? Infinity) / 1000 // the winners' whole walk, at most
  const nWon = steps.length - 1
  const step = nWon > 0 ? Math.min(youStep, Math.max(0.05, most) / nWon) : youStep // each winner's: walkMs, or the most shared evenly
  const start = Math.max(0, last + NAME_IN)
  return { order, nameAt, steps, step, youStep, from, start, end: start + nWon * step + youStep }
}

/* where the walk is t s from the stop: { phase, focus (a slot, or −1), i (the step) } */
export function walkAt(plan, t) {
  if (!plan || t < plan.from) return { phase: 'off', focus: -1, i: -1 }
  if (t < plan.start) return { phase: 'names', focus: -1, i: -1 }
  const you = plan.steps.length - 1
  const i = Math.floor((t - plan.start) / plan.step)
  if (i < you) return { phase: 'walk', focus: plan.steps[i], i }
  const onYou = plan.start + you * plan.step
  return { phase: t < onYou + plan.youStep ? 'you' : 'free', focus: plan.steps[you], i: you }
}

/* how far name i has come on, 0..1 */
export const nameIn = (plan, i, t) => {
  const u = Math.max(0, Math.min(1, (t - plan.nameAt[i]) / NAME_IN))
  return u * u * (3 - 2 * u)
}

/* THE OPACITIES — one rule. Every ticket is in one state, and its alpha
   is that state's; being yours changes only its colour, except spinYouA
   and youLostA:
     spin    the wheel turning (or scrubbed back into it): under the wedge
             spinUnderA, outside it spinOutA — yours spinYouA, wherever it is
     result  landed, nobody lit: a winner winnerA, a loser loserA, yours —
             if it lost — youLostA
     lit     one lit (the walk's, you at its end, or a tap): it litA, every
             other ticket unlitA — yours, if it lost, unlitYouA — but a
             winner (yours too, if it won) unlitWinnerA
   The names: the lit one nameLitA, the rest nameA. Returns [ticket, name] */
export function ticketAlpha({ state, k, lit, mine, won, under, S }) {
  if (state === 'lit') return k === lit ? [S.litA, S.nameLitA] : [won ? S.unlitWinnerA : k === mine ? S.unlitYouA : S.unlitA, S.nameA]
  if (state === 'spin') return [k === mine ? S.spinYouA : under ? S.spinUnderA : S.spinOutA, S.nameA]
  return [won ? S.winnerA : k === mine ? S.youLostA : S.loserA, S.nameA]
}

/* which state the draw is in: a tap lights its ticket whenever it comes; else
   still turning (or scrubbed back) is the spin; landed, the walk lights one
   from its first winner on — before that (the names coming on), the result.
   tapped NOBODY: a tap off every ticket, or Continue — nobody lit, whatever
   the walk is doing: the result (the spin, scrubbed back) */
export const NOBODY = -2
export function stateOf({ tapped, atRest, scrubbedBack, phase, focus }) {
  if (tapped >= 0) return { state: 'lit', lit: tapped }
  if (scrubbedBack || !atRest) return { state: 'spin', lit: -1 }
  if (tapped === NOBODY) return { state: 'result', lit: -1 }
  if (focus >= 0 && phase !== 'names' && phase !== 'off') return { state: 'lit', lit: focus }
  return { state: 'result', lit: -1 }
}
