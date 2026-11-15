// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * WHY A CLAIM CANNOT GO, OR DID NOT LAND — why a won prize cannot be claimed
 * (a key of claimRefusalWords in @jollity/protocol, for the chat), read off
 * the draw the source already has (`prizeDrawView`), and what a claim that did
 * not land failed on.
 *
 * The chain decides everything here: whether the player won, and whether
 * `Game.claim_airdrop` would pay now. A refused claim costs a fee, so the
 * automatic claim (./auto-claim.ts) sends only when every gate the read can
 * see is open.
 *
 * A winner who is not a member cannot claim, and cannot come back for it
 * either: membership comes from playing more games, and playing the next game
 * closes this claim (`last_attended_game` must be this game).
 */
import type { ClaimFailure } from "@individuality/prize"
import type { PrizeDrawView } from "./prize-draw"

export type { ClaimFailure }

export class ClaimError extends Error {
  constructor(
    readonly failure: ClaimFailure,
    /** the error the chain or the call named */
    readonly detail: string,
  ) {
    super(`claim ${failure}: ${detail}`)
    this.name = "ClaimError"
  }
}

/** the failure behind a rejected claim; anything untyped did not reach the chain */
export function claimFailureOf(error: unknown): ClaimFailure {
  return error instanceof ClaimError ? error.failure : "failed"
}

/** the error a refusal named, for its words (claimRefusalWords in @jollity/protocol) */
export function claimRefusalOf(error: unknown): string | null {
  return error instanceof ClaimError && error.failure === "refused" ? error.detail : null
}

/** why the draw read says the claim would be refused, as a key of claimRefusalWords in @jollity/protocol */
export function claimClosedReason(draw: PrizeDrawView): string {
  if (draw.phase !== "drawn") return "ClaimingWindowClosed"
  if (!draw.won) return "NoSuchWinner"
  const reason = draw.claimBlockedReason ?? ""
  if (MEMBERS_ONLY.test(reason)) return "NotMember"
  if (attendedBefore(draw)) return "NotAttended"
  if (/most recent attended game/.test(reason)) return "PlayedSince"
  if (/no attended game|not a scored participant/.test(reason)) return "AttendanceNotRecorded"
  return "NotEligibleForAirdrop"
}

/** the eligibility reasons that mean "not a member" (lib/game-source claimBlockedReason) */
const MEMBERS_ONLY = /below the personhood threshold|not recognized/

/** the last game the chain counts the player as attending is before this
 *  one: they did not attend it, rather than played another since
 *  (`most recent attended game is #<n>`, the shared prizeClaimEligibility) */
function attendedBefore(draw: PrizeDrawView): boolean {
  const last = Number(/most recent attended game is #(\d+)/.exec(draw.claimBlockedReason ?? "")?.[1])
  return Number.isFinite(last) && last < draw.gameIndex
}
