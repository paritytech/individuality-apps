// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A MISSED REPORT, decided from the chain.
 *
 * The pallet takes a player's report only while the game is in Reporting.
 * Once the chain has left Reporting and holds no report for this player in
 * this game, the report is MISSED: the session stops retrying, skips the
 * prize draw (no attendance, no draw) and hands over to the chest, which
 * shows what the chain gives a non-reporter.
 *
 * Both facts are the chain's, read at one block: the window is shut by the
 * game's phase, never by the page clock (which runs a delivery lag behind
 * block time, so a report in the last block can still be on its way), and
 * the report is absent by a row read that answered, never by one that failed
 * nor by a local submit error. A submit that failed locally but landed on
 * chain is NOT missed (#597).
 */
import type { PalletReportStanding } from "@jollity/protocol"

/** true once the chain has shut the window with no report from this player */
export function reportMissed(status: Pick<ReportStatus, "closed" | "report">): boolean {
  return status.closed && status.report === "not-sent"
}

/**
 * THE REPORT'S STATUS, in every phase of the game. `gameView()` resolves only
 * in Shuffle and Reporting, but the pallet leaves Reporting at report_ends, or
 * EARLIER once every attendance is decided (in a game where everyone reported,
 * that is the block after the last report), and PlayerProcess step 1 then
 * archives or resets each Players row, taking `sent_report` with it (#596).
 *
 * - `closed`: the chain has shut the window (the game left Reporting, or was
 *   cleared or replaced). Nothing filed from here on can count.
 * - `report`: "sent" counted; "not-sent" not (yet) on chain, and final once
 *   `closed`; "unknown" a read failed, read again; "gone" the chain processed
 *   the player and kept nothing that says whether a report was sent.
 */
export interface ReportStatus {
  gameIndex: number | undefined
  /** the game's `game_date`, when the block still holds this game */
  gameDate?: number
  closed: boolean
  report: "sent" | "not-sent" | "unknown" | "gone"
}

/** The status of game `gameIndex` (default: the game the block holds) from
 *  one block's reads. A row step 1 has not processed (still `registered`) is
 *  final once the window shut, since the pallet refuses a report outside
 *  Reporting, and so is the row at the last block still in Reporting. With
 *  neither, attendance is the fact left: attending needs a sent report, so
 *  attended means sent. Not attended cannot tell a non-reporter from a
 *  reporter the co-players rejected, so that is "gone". */
export function reportStatusOf(standing: PalletReportStanding, gameIndex?: number): ReportStatus {
  const { game, player, lastAttendedGame, reportingRow } = standing
  const index = gameIndex ?? game?.index
  if (index === undefined) return { gameIndex: undefined, closed: false, report: "unknown" }
  const same = game?.index === index ? game : undefined
  const dated = same ? { gameDate: same.game_date } : {}
  const open = same !== undefined && ["Registration", "Shuffle", "Reporting"].includes(same.state.type)
  // the row that still holds sent_report: the block's own while step 1 has
  // not processed it, else the last block in Reporting, if one was held
  const final =
    same === undefined ? undefined : player?.registered === true ? player : reportingRow?.registered ? reportingRow : undefined
  const report: ReportStatus["report"] = final
    ? final.sent_report === true
      ? "sent"
      : "not-sent"
    : lastAttendedGame === index
      ? "sent"
      : open
        ? "unknown"
        : "gone"
  return { gameIndex: index, ...dated, closed: !open, report }
}
