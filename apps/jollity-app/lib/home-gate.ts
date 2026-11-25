// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * WHAT STANDS BETWEEN THE PLAYER AND HOME — one answer, from the real state.
 *
 * Two things replace the whole home screen: no host to run in, and a build the
 * name has moved past (lib/release). The page asks for ONE value and branches
 * once.
 *
 * The update screen covers everything BEFORE the game: sign-up, a registered
 * player waiting for kickoff, and the waiting room up to its handover to /game
 * (a player playing on an old build is the problem; signing up is not, but a
 * restart keeps the seat, so the gate covers both).
 *
 * THE WAY INTO A GAME (#1102). A player who has had the app open on home
 * since before a release has had their build checked once, at app open, and
 * would go in on it and connect to nobody. So a device going into a
 * game for the first time, through the waiting room's door or as a late
 * joiner, has its build asked again for that entry (`entryRecheck`), and the
 * handover waits for that answer (`entryBuildClear`). A stale one gets the
 * update screen instead of the game.
 *
 * It is never shown to a device already in the game (a reload or a relaunch
 * mid-game): the game screen has taken over and is not interrupted, whatever
 * the build says.
 *
 * A fresh page load held here on its way to a game page (lib/front-door) is
 * covered too, whatever the status: a reopened collectables screen is not shown on an old
 * build either (#1137).
 */
import type { GameStatus } from "./game-source"
import { handoverAt } from "./joined"
import type { BuildAnswer, BuildState } from "./release/stale-build"
import type { UpdatePlatform } from "./release/update-copy"

export type HomeGate = "host-only" | "update"

/** what the home page renders from: the game's status and the gate over it */
export interface HomeView {
  status: GameStatus
  gate: HomeGate | null
  /** which instruction the update screen gives (lib/release/update-copy) */
  platform: UpdatePlatform
}

/** How many seconds before the waiting room's handover the build is asked
 *  again: one check's grant and timeout, with room to spare, so the answer is
 *  normally in before the door opens. */
export const ENTRY_RECHECK_LEAD = 15

/** `joined`: this device is already in the status's game (lib/joined
 *  hasJoined). `held`: a fresh page load is held here with its gates done
 *  (lib/front-door arrivalStep "hold"). `now` is the source clock in seconds,
 *  the one the waiting room counts to the handover on. */
export function homeGate(
  hostOnly: boolean,
  build: BuildState,
  status: GameStatus,
  now: number,
  { joined, held }: { joined: boolean; held: boolean },
): HomeGate | null {
  if (hostOnly) return "host-only"
  if (build !== "stale") return null
  if (held) return "update"
  switch (status.kind) {
    case "registration":
      return "update"
    case "starting":
      // an unregistered player here is past sign-up: nothing to play
      return status.registered ? "update" : null
    case "waiting":
      // from the handover on, only the door into a game not yet entered
      return now < handoverAt(status.gameAt) || !joined ? "update" : null
    case "live":
      // a late joiner going in for the first time
      return status.registered && now < status.playEndsAt && !joined ? "update" : null
    default:
      return null
  }
}

/** Is the version check worth running? Not once the gate is moot: in a game
 *  the device is already in, or one it cannot go into, and while the result
 *  is processed, nothing polls. A fresh page load held here (`held`, any step
 *  of lib/front-door) always waits for it. It starts again at the next app
 *  open, or when the status is back before the handover. */
export function buildCheckWanted(
  status: GameStatus,
  now: number,
  { joined, held }: { joined: boolean; held: boolean },
): boolean {
  if (held) return true
  switch (status.kind) {
    case "live":
      return status.registered && now < status.playEndsAt && !joined
    case "processing":
      return false
    case "waiting":
      return now < handoverAt(status.gameAt) || !joined
    default:
      return true
  }
}

/**
 * The game this device is about to go into for the first time, which the
 * build is asked again for (#1102): the waiting room from ENTRY_RECHECK_LEAD
 * before its handover, or a late joiner's game. Undefined when there is none,
 * or when the device is already in it.
 */
export function entryRecheck(status: GameStatus, now: number, joined: boolean): number | undefined {
  if (joined) return undefined
  if (status.kind === "waiting")
    return now >= handoverAt(status.gameAt) - ENTRY_RECHECK_LEAD ? status.gameAt : undefined
  if (status.kind === "live" && status.registered && now < status.playEndsAt) return status.gameAt
  return undefined
}

/**
 * May the handover take this device in, as far as the build goes? A first
 * entry waits for the answer asked for it, and a stale build never goes in.
 * Every other way to fail opens the door, as the check does: a check that
 * could not tell, and a refused grant, which is never asked again.
 */
export function entryBuildClear(status: GameStatus, now: number, joined: boolean, build: BuildAnswer): boolean {
  const entry = entryRecheck(status, now, joined)
  if (entry === undefined) return true
  if (build.state === "stale") return false
  return build.last === "denied" || (build.last !== undefined && build.askedFor === entry)
}
