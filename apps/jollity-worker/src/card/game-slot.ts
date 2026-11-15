// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * One pure derivation that decides what the game card says.
 *
 * The worker of jollity kept a phase flag in host storage and morphed the card
 * from scheduled to live to recap when it changed. That made the face of the
 * card depend on what had been written, not on what was true, so a stale flag,
 * a missing recap or a NaN deadline each produced a face nobody meant. Here the
 * face is a function of what the source knows and the clock:
 *
 *     gameSlot({ game, registered, results, nowSeconds })
 *
 * So "render the next game if one is coming, the results if there are any, the
 * missed message if there are none" is a single switch the worker calls, with
 * no React, no host and no storage.
 *
 * After the game the card keeps changing without the game changing. The player
 * opens the chest, the draw is held, they watch it, and a win is claimed.
 * `payoff()` reads those off the results, from what the app recorded the
 * player doing in `seen` and where the draw is in `prize.phase`, and hands the
 * card the short list of what is still to do. When that list is empty the card
 * is the recap, and stays so.
 *
 * The windows are duplicated from JOIN_WINDOW_S in lib/game-source on purpose,
 * since a value import of the doorway would pull the chain client into the
 * chat bundle, and the worker has no doorway at all.
 */
import type { GameStatus } from "@jollity/protocol"

/** Registration opens this long before the game.
 *
 *  It is a hardcoded guess, the same one as REGISTER_BAND_S in lib/game-source.ts.
 *  The worker reads the real window off the chain and passes it as
 *  `SlotInput.window`, so this only stands in for a source that has none, the
 *  test fixtures.
 */
export const REGISTRATION_OPENS_S = 3600
/** Registration closes this long before the game without a window, and a registered player counts down from then. */
export const JOIN_WINDOW_S = 300

/** The scheduled or active game as the worker sees it, in seconds. */
export interface SlotGame {
  id: string
  status: GameStatus
  /** Unix seconds when round 0 begins. */
  startAt: number
}

export interface SlotCollectable {
  name: string
  rarity: "rare" | "common"
  /** The Bulletin CID of its picture, which the host fetches, absent when the art could not be read. */
  image?: string
}

/** The ticket of this player in the prize draw of the game, which the chain calls an airdrop. */
export interface SlotPrize {
  /** Whole units of the prize asset, which `formatPrize` names. */
  amountUsd: number
  /** The ticket hash, which the card never shows. */
  ticket: string
  /** Unix seconds when the draw is held. */
  drawAt: number
  /** Waiting before the draw, drawn once the winners are known, and over once the claim window has closed. */
  phase: "waiting" | "drawn" | "over"
  /** Authoritative once drawn, and never decided by the card. */
  won: boolean
  /** Won, inside the claim window, and not yet claimed. */
  claimable: boolean
  /**
   * Won, but the chain will not pay it: the player is not a member, nor over
   * the personhood threshold, after this game. Absent until the chain holds
   * this game's attendance, and for everyone else.
   */
  membersOnly?: boolean
  /**
   * Won, and the chain confirmed the claim landed, through `confirmClaim` of
   * the SDK. Absent until the worker has seen the winning ticket go, and on
   * a stored prize from before the worker asked. The card does not read it
   * yet, and it is the record of the claim.
   */
  claimed?: boolean
}

/** The recap of a finished game for this player, authoritative and never decided by the UI. */
export interface GameResults {
  endedAt: number
  passed: boolean
  /** Null until the worker has read the chest on Asset Hub, then the tiles the stash would mint. */
  collectables: SlotCollectable[] | null
  /** How many collectibles the game earned the player, from the claims on Asset
   *  Hub. Absent until the worker has read them. */
  earned?: number
  prize: SlotPrize | null
  /** `gamesToMembership` is null when the source cannot count, and the card then
   *  says nothing about progress rather than invent a number. */
  membership: { member: boolean; justBecameMember: boolean; gamesToMembership: number | null }
  /** What the player has already done in the app, from `jollity.seen:<game>`. */
  seen: { chest: boolean; draw: boolean }
}

export interface SlotInput {
  game: SlotGame | null
  registered: boolean
  results: GameResults | null
  /** Whether this player was a member going in. */
  member?: boolean
  /** The chain suspended the membership, which only the outcome read after the game can say. */
  paused?: boolean
  /** Games a member can still miss before the chain suspends them, or null when unread. */
  missesLeft?: number | null
  nowSeconds: number
  /** When sign-up opens and closes, from the chain. Without it the card falls
   *  back to the hardcoded guess of REGISTRATION_OPENS_S and JOIN_WINDOW_S. */
  window?: { opensAt: number; closesAt: number }
  /** The chain abandoned the game, too few players or a missed shuffle. */
  cancelled?: boolean
  /** Games left to membership when there are no results to carry the count. */
  gamesToMembership?: number | null
  /** The report of the player landed, by `jollity.seen:<game>` of the app or the stored outcome of the chain. */
  reported?: boolean
  earned?: number
}

export type GameSlot =
  | { kind: "none" }
  | { kind: "cancelled"; startAt: number }
  | { kind: "next"; startAt: number; opensAt: number }
  | { kind: "register"; startAt: number; closesAt: number }
  | { kind: "registered"; startAt: number }
  | { kind: "starting"; startAt: number }
  | { kind: "closed"; startAt: number }
  | { kind: "pending"; endedAt: number }
  | { kind: "results"; results: GameResults }
  | {
      kind: "missed"
      endedAt: number
      reason: "never-registered" | "no-show" | "not-passed"
      /** A member going in. One the chain did not suspend keeps the membership through a miss. */
      member: boolean
      membershipPaused: boolean
      /** Null when unread, and the card then gives no number. */
      missesLeft: number | null
      /** Null when the source cannot count, and the card then gives no number. */
      gamesToMembership: number | null
      earned?: number
    }

type MissedReason = Extract<GameSlot, { kind: "missed" }>["reason"]

export function gameSlot(input: SlotInput): GameSlot {
  const { game, registered, results, nowSeconds } = input
  if (!game || game.status === "idle") return { kind: "none" }
  if (input.cancelled) return { kind: "cancelled", startAt: game.startAt }
  const untilStart = game.startAt - nowSeconds
  switch (game.status) {
    case "scheduled": {
      const opensAt = input.window?.opensAt ?? game.startAt - REGISTRATION_OPENS_S
      const closesAt = input.window?.closesAt ?? game.startAt - JOIN_WINDOW_S
      if (nowSeconds < opensAt) return { kind: "next", startAt: game.startAt, opensAt }
      if (registered)
        return untilStart > JOIN_WINDOW_S
          ? { kind: "registered", startAt: game.startAt }
          : { kind: "starting", startAt: game.startAt }
      return nowSeconds < closesAt
        ? { kind: "register", startAt: game.startAt, closesAt }
        : { kind: "closed", startAt: game.startAt }
    }
    case "active":
      // A registered player can join a running game at any turn (lib/late-join.ts,
      // #699), so the way in stays.
      return registered ? { kind: "starting", startAt: game.startAt } : { kind: "closed", startAt: game.startAt }
    case "reporting":
      return registered ? { kind: "pending", endedAt: game.startAt } : missed(input, "never-registered")
    case "finished":
      if (!registered && !input.reported) return missed(input, "never-registered")
      if (results) return { kind: "results", results: { ...results, endedAt: game.startAt } }
      return missed(input, input.reported ? "not-passed" : "no-show")
  }
}

function missed(input: SlotInput, reason: MissedReason): GameSlot {
  return {
    kind: "missed",
    endedAt: input.game?.startAt ?? input.nowSeconds,
    reason,
    member: input.member === true,
    membershipPaused: input.paused === true,
    missesLeft: input.paused === true ? null : (input.missesLeft ?? null),
    gamesToMembership: input.results?.membership.gamesToMembership ?? input.gamesToMembership ?? null,
    ...(reason === "not-passed" && input.earned ? { earned: input.earned } : {}),
  }
}

/**
 * What is still to do after a game, as the to-do list of the results card.
 *
 * The draw is none without a ticket, pending while it is ahead, and ready once
 * drawn and not yet watched. It is claim for a win the chain would pay, which
 * the worker claims by itself, and claimed once that landed, both shown at once
 * whether watched or not. It is members-only for a win the chain will not pay
 * a non-member, shown at once too, so the player learns why there is no prize.
 * It is revealed once seen or over, and the card then states the outcome.
 */
export interface Payoff {
  draw: "none" | "pending" | "ready" | "claim" | "claimed" | "members-only" | "revealed"
}

export function payoff(results: GameResults): Payoff {
  let draw: Payoff["draw"]
  const prize = results.prize
  if (!prize) draw = "none"
  else if (prize.phase === "waiting") draw = "pending"
  else if (prize.won && prize.claimed) draw = "claimed"
  else if (prize.won && prize.claimable) draw = "claim"
  else if (prize.won && prize.membersOnly) draw = "members-only"
  else if (prize.phase === "over" || results.seen.draw) draw = "revealed"
  else draw = "ready"
  return { draw }
}
