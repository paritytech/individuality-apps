// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Pure availability rule for a single scratch-off entry. Shared by the
 *  live and debug branches of `PrizePage`. The home card is reachable
 *  exactly until it has been opened: scratching consumes it, win or miss,
 *  and the next card appears when the next draw does. The claim itself is
 *  submitted when the daily screen opens, so nothing is left to do here
 *  after the reveal. */

export interface DailyPrizeEntry {
  scratched: boolean;
  /** `null` when no ticket exists to open: the standing has nothing in
   *  `Claiming`, no debug prize, etc. */
  outcome: "win" | "miss" | null;
}

export function dailyPrizeEntryAvailable({
  scratched,
  outcome,
}: DailyPrizeEntry): boolean {
  return outcome != null && !scratched;
}
