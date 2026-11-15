// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A player's verdict in the game the chain still holds, before the game
 * settles, in the screens' own words. ./attendance-watch.ts feeds it the game
 * and the player's `Game.Players` row.
 *
 * The pallet decides a player the moment the votes still to come can no
 * longer change the outcome, and writes `Score.Participants` right then
 * (#1096). Until it does, the votes in so far say which way it leans. When a
 * row speaks for a verdict is ./attendance-rule.ts's `attendanceInGame`.
 */
import { attendanceInGame, type AttendanceRow, type GameSlot } from "./attendance-rule"

export type AttendanceVerdict = "passed" | "failed" | "pending"

export interface AttendanceView {
  gameIndex: number
  verdict: AttendanceVerdict
  /** the chain has applied the verdict: `Score.Participants` already holds
   *  this game, so a prize claim need not wait for the game to settle */
  final: boolean
  /** the player's own report is in; an unreported player never passes early */
  reported: boolean
  /** the least Person weight still to come after which the votes pass the
   *  player: 0 once they do, null once they cannot. A weight, not a count:
   *  a recognized co-player's vote weighs more than a candidate's. */
  personWeightNeeded: number | null
}

/** Null while the row holds no verdict for this game (`attendanceInGame`). */
export function deriveAttendance(
  gameIndex: number,
  game: GameSlot | undefined,
  row: AttendanceRow | undefined,
): AttendanceView | null {
  const attendance = attendanceInGame(game, row, gameIndex)
  if (!attendance || !row) return null
  const { status, personWeightNeeded } = attendance
  return {
    gameIndex,
    verdict: status === "attended" ? "passed" : status === "notAttended" ? "failed" : "pending",
    final: row.early_attendance_enactment !== null,
    reported: row.sent_report,
    personWeightNeeded,
  }
}
