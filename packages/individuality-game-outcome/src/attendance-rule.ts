// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A player's attendance in the game the chain holds, from their `Game.Players`
 * row: decided, and which way, or still open, with what it would take to pass.
 *
 * The rule is the Game pallet's `determine_attendance`, and the verdict at the
 * close is `process_player_attendance_outcome`'s
 * (paritytech/individuality-community, `pallets/game/src/lib.rs`). The pallet
 * subtracts with `saturating_sub`, so every `− 1` here stops at 0 too: a player
 * who reported and can receive no votes at all (`expected_max_vote_weight` 0)
 * ATTENDS, where a plain `yes − 1` would say they failed.
 *
 * The tallies and `expected_max_vote_weight` are already weighted, so the rule
 * needs no weights of its own.
 *
 * The answer means something only while the row belongs to the game the chain
 * holds, in Reporting or PlayerProcess. PlayerProcess clears the enactment and
 * resets or archives the row, and from then on `Score.Participants` holds the
 * result. `attendanceInGame` checks that before it answers; `attendanceStatus`
 * answers for any row it is given.
 */
/** what the rule reads of `Game.Game` */
export interface GameSlot {
  index: number
  state: { type: string }
}

export type AttendanceStatus = "attended" | "notAttended" | "pending"

export interface Attendance {
  /** decided by the chain's enactment, or by the votes in so far; `pending`
   *  while the votes still to come could swing it, or while the player has
   *  not reported (an unreported player is never decided as attended) */
  status: AttendanceStatus
  /** the least `Person` weight, of the weight still to come, after which the
   *  votes alone pass the player: 0 once they do, null once they cannot. A
   *  weight, not a count of votes: a recognized co-player's vote weighs more. */
  personWeightNeeded: number | null
  /** the verdict PlayerProcess applies if reporting closes on the votes in
   *  now: the enactment where there is one, else `registered && sent_report &&
   *  yes − 1 ≥ no` */
  atClose: boolean
}

/** the fields of `Game.Players(player)` the rule reads */
export interface AttendanceRow {
  registered: boolean
  sent_report: boolean
  /** weighted `Person` votes received */
  yes_person: number
  /** weighted `NotPerson` votes received */
  no_not_person: number
  /** the most weight this player can receive: their co-players' vote weights over every round */
  expected_max_vote_weight: number
  /** the pallet's early enactment, once it decided the player */
  early_attendance_enactment: { attendance: boolean } | null
}

/** `a.saturating_sub(b)` on the pallet's unsigned integers */
const sat = (a: number, b: number) => Math.max(a - b, 0)

export function attendanceStatus(row: AttendanceRow): Attendance {
  const enacted = row.early_attendance_enactment
  if (enacted) {
    return {
      status: enacted.attendance ? "attended" : "notAttended",
      personWeightNeeded: enacted.attendance ? 0 : null,
      atClose: enacted.attendance,
    }
  }
  const yes = row.yes_person
  const no = row.no_not_person
  const atClose = row.registered && row.sent_report && sat(yes, 1) >= no
  if (!row.registered) return { status: "notAttended", personWeightNeeded: null, atClose }

  const remaining = sat(row.expected_max_vote_weight, yes + no)
  const personWeightNeeded = weightToPass(yes, no, remaining)
  // every vote still to come Person, and the player still fails
  if (sat(yes + remaining, 1) < no) return { status: "notAttended", personWeightNeeded, atClose }
  // every vote still to come NotPerson, and a player who reported still passes
  if (row.sent_report && sat(yes, 1) >= no + remaining) return { status: "attended", personWeightNeeded, atClose }
  return { status: "pending", personWeightNeeded, atClose }
}

/**
 * The player's attendance in game `gameIndex`, or null while the row speaks
 * for no verdict there: the chain holds another game or none, the game is not
 * yet (or no longer) holding votes, or the player is not registered in it.
 * PlayerProcess resets a kept row to unregistered, so a processed player reads
 * null too, and `Score.Participants` has the answer.
 */
export function attendanceInGame(
  game: GameSlot | undefined,
  row: AttendanceRow | undefined,
  gameIndex: number,
): Attendance | null {
  if (game?.index !== gameIndex) return null
  if (game.state.type !== "Reporting" && game.state.type !== "PlayerProcess") return null
  if (!row?.registered) return null
  return attendanceStatus(row)
}

/**
 * The least `x` of `remaining` with `yes + x − 1 ≥ no + remaining − x`: the
 * worst case passes once `x` more Person weight is in. Past 0 the subtraction
 * no longer saturates, so `2x ≥ no + remaining + 1 − yes` solves it; more
 * than `remaining` is exactly the case where even every vote to come cannot
 * pass the player.
 */
function weightToPass(yes: number, no: number, remaining: number): number | null {
  if (sat(yes, 1) >= no + remaining) return 0
  const x = Math.ceil((no + remaining + 1 - yes) / 2)
  return x <= remaining ? x : null
}
