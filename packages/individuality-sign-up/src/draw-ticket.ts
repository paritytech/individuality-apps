// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * WHO A PRIZE-DRAW TICKET IS FOR (#167). `Game.claim_airdrop` pays a winner
 * only once this game is applied, only if they are recognized
 * (`Recognized` or `ExternallyRecognized`: pallet-score `is_recognized`) or
 * have reached personhood by then, and only before their next game. A winning
 * ticket that cannot claim is not drawn again: its prize goes back at
 * finalization. So a candidate this game cannot make a member would only
 * take a prize from a player who could claim it, and their sign-up goes
 * without a ticket; they watch the draw instead. On paseo, games 276–281,
 * 8 of the 30 prizes went to such tickets.
 *
 * A win adds the run: after `Attended(k)` the next attended game adds `k + 1`,
 * and after `Absent` it adds 1 (pallet-score `set_attendance`). The pallet
 * also caps the score, but it refuses any threshold above that cap, so the
 * cap never decides whether the threshold is reached and is left out here.
 * The threshold itself is the chain's (`Score.PersonhoodThreshold`).
 *
 * Only a participant who is not recognized, has not reached personhood, and
 * whom this game cannot carry to the threshold is left out; a suspended one
 * is judged by the score like any other.
 */
/** The fields of a `Score.Participants` row a ticket is judged by. */
export interface ScoreStanding {
  score: number
  streak: { type: "Attended" | "Absent"; count: number }
  recognition: { type: string }
  reached_personhood: boolean
}

/** pallet-score `Recognition::is_recognized`: what the claim takes in place
 *  of reached personhood */
const RECOGNIZED: ReadonlySet<string> = new Set(["Recognized", "ExternallyRecognized"])

/** How many attended games still stand between a participant (or a player
 *  with no score row yet) and the threshold. */
export function gamesToMembership(row: Pick<ScoreStanding, "score" | "streak"> | undefined, threshold: number): number {
  let score = row?.score ?? 0
  let run = row?.streak.type === "Attended" ? row.streak.count : 0
  let games = 0
  while (score < threshold) {
    run += 1
    score += run
    games += 1
  }
  return games
}

/** Whether a ticket bought with this sign-up could ever be paid: the player is
 *  a member already, or this game can make them one. */
export function drawTicketCanPay(row: ScoreStanding | undefined, threshold: number): boolean {
  if (row && (RECOGNIZED.has(row.recognition.type) || row.reached_personhood)) return true
  return gamesToMembership(row, threshold) <= 1
}
