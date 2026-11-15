// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The joined markers. A player goes into a game through the waiting-room
 * handover, which fires at `handoverAt(gameAt)` — the game's connection stage
 * before T-0, so the countdown and then the connect grid stand while the mesh
 * opens and turn 1 starts on the game clock — or, once it is running, from
 * the home at any turn (lib/late-join.ts, #699). Both set the joined marker
 * (keyed by game time). The waiting-room handover also sets its own, which
 * tells a REJOIN (a reload or relaunch mid-game: you were there) apart from a
 * first-time late join (you weren't); stored vote books for the game prove a
 * rejoin too, when local storage was lost.
 *
 * The home page counts to KICKOFF and holds no clock of its own past the
 * handover. The dial belongs to /game alone.
 */
import { CONNECTION_STAGE_DURATION } from "@jollity/game-chain/game"

const KEY = "jollity.joined"
/** set ONLY by the waiting-room door, never by a late join (#527) */
const DOOR_KEY = "jollity.joined.door"

/** the second the waiting room hands over to /game for the game at `gameAt`:
 *  T-64, the start of the connection stage (CONNECTION_STAGE_DURATION). A
 *  whole second, because the home screen ticks once per second. This is the
 *  ONE place that turns it into a second. */
export function handoverAt(gameAt: number): number {
  return gameAt - CONNECTION_STAGE_DURATION
}

export function markJoined(gameAt: number, viaWaitingRoom = false): void {
  try {
    localStorage.setItem(KEY, String(gameAt))
    if (viaWaitingRoom) localStorage.setItem(DOOR_KEY, String(gameAt))
  } catch {
    /* storage unavailable — rejoin will be treated as late join */
  }
}

/** the kickoff (chain seconds) stored at the handover, so /game can show the
 *  countdown at once, before the live view resolves */
export function readJoinedGameAt(): number | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === null) return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

export function hasJoined(gameAt: number): boolean {
  try {
    return localStorage.getItem(KEY) === String(gameAt)
  } catch {
    return false
  }
}

/** this device went through the waiting room for the game at `gameAt` — proof
 *  that a relaunch is a REJOIN even when no turn was opened yet, which `hasJoined`
 *  cannot say because a late join sets that marker too (#527) */
export function cameThroughWaitingRoom(gameAt: number): boolean {
  try {
    return localStorage.getItem(DOOR_KEY) === String(gameAt)
  } catch {
    return false
  }
}
