// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * WHAT THE HOME SHOWS — one value, from the view and the card over it.
 *
 * The order of the checks is the order of the gates (host-only, update, the
 * restart card, which the waiting room carries on its status line), then one
 * `kind` per status: every screen the page draws is one `kind`. The page
 * switches on it and draws (AGENTS.md: a screen renders from ONE view value),
 * and the order is tested without React.
 *
 * `homeSituation` is the other half: what the home's hooks key off (the wake
 * lock, the TURN warm-up, the waiting room's camera and the handover) from the
 * status alone. It is not the screen: a restart card over the waiting room
 * still keeps the phone awake and the camera warm.
 */
import type { RestartCardReason } from "./chain-health"
import type { GameStatus } from "./game-source"
import type { HomeView } from "./home-gate"
import { handoverAt } from "./joined"
import type { UpdatePlatform } from "./release/update-copy"

type Registration = Extract<GameStatus, { kind: "registration" }>

/** the player's place relative to the game, from the status alone */
export interface HomeSituation {
  /** the game the countdowns run to, while it is ahead */
  gameAt: number | undefined
  /** signed up for a game that has not started */
  registered: boolean
  /** within the join window: the waiting room */
  inWaiting: boolean
  /** LATE JOIN (#699): registered in a running game while turns remain */
  goesIn: boolean
}

export function homeSituation(status: GameStatus, now: number): HomeSituation {
  return {
    gameAt:
      status.kind === "scheduled" ||
      status.kind === "registration" ||
      status.kind === "starting" ||
      status.kind === "waiting"
        ? status.gameAt
        : undefined,
    registered: (status.kind === "registration" || status.kind === "starting") && status.registered,
    inWaiting: status.kind === "waiting",
    goesIn: status.kind === "live" && status.registered && now < status.playEndsAt,
  }
}

export type HomeScreen =
  | { kind: "host-only" }
  | { kind: "update"; platform: UpdatePlatform }
  /** the chain-health card or the launch stall (lib/chain-health) */
  | { kind: "restart"; reason: RestartCardReason; consecutiveLost: number; reconnecting: boolean; gameAt?: number }
  /** not in this game and no longer able to join it: ONE dead end, minutes
   *  away or running */
  | { kind: "missed" }
  /** registered, within the join window. A restart card shows on the room's
   *  status line here, not as a screen of its own. */
  | {
      kind: "waiting-room"
      gameAt: number
      restart?: { reason: RestartCardReason; consecutiveLost: number; reconnecting: boolean }
    }
  // the band: the game exists and the player can sign up or has
  | { kind: "registered"; gameAt: number }
  | { kind: "unfunded"; gameAt: number; funds: NonNullable<Registration["funds"]> }
  | { kind: "register"; gameAt: number; closesAt: number; signup: Registration["signup"] }
  // nothing to act on
  /** the first answers are out, or the handover to /game is under way */
  | { kind: "loading" }
  /** a game QUEUED behind the current one: nothing to sign up for until it
   *  becomes the game, however far out it is */
  | { kind: "queued"; gameAt: number }
  | { kind: "wrapping-up" }
  | { kind: "no-game" }

export interface HomeScreenInput {
  view: HomeView
  /** the restart card on screen */
  restart?: { reason: RestartCardReason; consecutiveLost: number }
  /** inside the silent-host minute (lib/use-reconnect-window) */
  reconnecting: boolean
  /** a page load passing through on its way to a game page (lib/front-door):
   *  the bare title until it goes on, not a screen it is about to leave */
  passing?: boolean
}

export function homeScreen({ view, restart, reconnecting, passing }: HomeScreenInput, now: number): HomeScreen {
  if (view.gate === "host-only") return { kind: "host-only" }
  if (view.gate === "update") return { kind: "update", platform: view.platform }
  const { status } = view
  if (restart) {
    const { reason, consecutiveLost } = restart
    if (status.kind === "waiting")
      return { kind: "waiting-room", gameAt: status.gameAt, restart: { reason, consecutiveLost, reconnecting } }
    const { gameAt } = homeSituation(status, now)
    return { kind: "restart", reason, consecutiveLost, reconnecting, ...(gameAt !== undefined ? { gameAt } : {}) }
  }
  if (passing) return { kind: "loading" }
  switch (status.kind) {
    case "loading":
      return { kind: "loading" }
    case "none":
      return { kind: "no-game" }
    case "scheduled":
      return { kind: "queued", gameAt: status.gameAt }
    // REGISTRATION IS OPEN from the scheduling block until the pallet closes
    // it, however far out the game is
    case "registration":
      if (status.registered) return { kind: "registered", gameAt: status.gameAt }
      // a new account that cannot cover the play deposit
      if (status.seat?.path === "unfunded" && status.funds)
        return { kind: "unfunded", gameAt: status.gameAt, funds: status.funds }
      return { kind: "register", gameAt: status.gameAt, closesAt: status.closesAt, signup: status.signup }
    case "starting":
      return status.registered ? { kind: "registered", gameAt: status.gameAt } : { kind: "missed" }
    case "waiting":
      return { kind: "waiting-room", gameAt: status.gameAt }
    case "live":
      // turns remain while the status is live: the bare title while the
      // handover takes a registered player in (homeHandover)
      return status.registered ? { kind: "loading" } : { kind: "missed" }
    case "processing":
      return { kind: "wrapping-up" }
  }
}

/**
 * THE HANDOVER to /game, if it is due now. A late joiner goes in at any turn
 * while turns remain. From the waiting room the door opens at `handoverAt`,
 * and only with the camera live: NO CAMERA, NO GAME. `door` marks the
 * waiting-room way in (lib/joined).
 */
export function homeHandover(
  status: GameStatus,
  now: number,
  cameraLive: boolean,
): { gameAt: number; door: boolean } | null {
  if (status.kind === "live" && status.registered && now < status.playEndsAt) return { gameAt: status.gameAt, door: false }
  if (status.kind === "waiting" && now >= handoverAt(status.gameAt) && cameraLive) return { gameAt: status.gameAt, door: true }
  return null
}
