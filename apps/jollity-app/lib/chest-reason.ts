// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * WHY AN EMPTY CHEST IS EMPTY, narrowed from what the chain says.
 *
 * The chest's own vocabulary, so the screen never reads the pallet's flags:
 *   · report-missed  — the player was in the game but the chain holds no report
 *                      from them (it did not land before `report_ends`)
 *   · no-attestations — they attended and the group attested nobody for them
 *   · absent          — the chain does not show them attending this game
 */
export type ChestEmptyReason = "report-missed" | "no-attestations" | "absent"

export function emptyReason(view: { attended?: boolean; reportSent?: boolean }): ChestEmptyReason {
  if (view.attended === true) return "no-attestations"
  // a settled game is past report_ends, so a player row with no report is a miss
  return view.reportSent === false ? "report-missed" : "absent"
}
