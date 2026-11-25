// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * THE COLLECTABLES SCREEN COLLECTS, THEN OPENS. The vessel lands and rests closed while the
 * game's claims fly into it as orbs (components/collectables/collectables-scene). When it
 * opens is decided here:
 *
 *   · everything this game will give is in (`allIn`: the game has settled)
 *     and has flown in: open at once, there is nothing to wait for;
 *   · otherwise it collects for COLLECT_MS from the landing, and opens with
 *     what came;
 *   · never empty: with nothing in yet it keeps collecting, and opens on the
 *     first claim that lands after the wait.
 *
 * A tap opens it early once something is in (the screen's `canOpen`). What
 * comes after it opened flies into the open collectables screen.
 */

/** how long the closed vessel collects after it lands, ms */
export const COLLECT_MS = 10_000

export interface CollectState {
  /** the vessel has landed */
  landed: boolean
  /** COLLECT_MS have passed since it landed (the screen's timer) */
  waited: boolean
  /** pieces that have flown in */
  collected: number
  /** pieces the vessel shows */
  shown: number
  /** nothing more will come: the game has settled */
  allIn: boolean
}

/** whether the vessel should open now; the screen keeps the answer once it is yes */
export function collectablesShouldOpen({ landed, waited, collected, shown, allIn }: CollectState): boolean {
  if (!landed || collected === 0) return false
  if (allIn && collected >= shown) return true
  return waited
}
