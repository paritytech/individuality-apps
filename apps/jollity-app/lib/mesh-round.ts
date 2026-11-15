// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * WHICH MESH ROUND A GAME CLOCK READING BELONGS TO. The Mesh forms rooms ahead
 * of the turn on screen: round 0's room opens across the connection stage,
 * and a gap connects the next round's group from its first second. So the
 * Mesh switches to round r+1 at the START OF THE GAP, not at round r+1's
 * first turn, and is closed (null) before the waiting room's connect beat and
 * once the game is over. One pure function, so the game session and the
 * state-machine models read the same rule.
 */
import { calculateSnapshot } from "@jollity/game-chain/game"
import type { GameSnapshot, GameTimingInfo } from "@jollity/game-chain"

/** The Mesh round for a snapshot of the game clock, or null (no room). */
export function meshRoundOfSnapshot(snapshot: GameSnapshot | undefined): number | null {
  if (snapshot?.kind === "round") return snapshot.round
  if ((snapshot?.kind === "waiting-room" || snapshot?.kind === "between-rounds") && snapshot.preconnectRound !== null)
    return snapshot.preconnectRound
  return null
}

/** The Mesh round `gameMs` after game_date (negative before it), or null. */
export function meshRoundAt(gameMs: number, timing: GameTimingInfo): number | null {
  return meshRoundOfSnapshot(calculateSnapshot(timing.gameDate + gameMs / 1000, timing))
}
