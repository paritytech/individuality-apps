// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Jollity's words for a refused prize claim, by the reason the claim gives
 * (`CLAIM_REFUSALS` of @individuality/prize, which keeps the reasons and leaves
 * the words to each product). Keyed by those reasons, so a reason the package
 * adds without words here is a compile error.
 */
import type { CLAIM_REFUSALS } from "@individuality/prize"

type ClaimRefusal = (typeof CLAIM_REFUSALS)[number]

const WINDOW_CLOSED = "The claim window for this prize has closed."
const NOT_PAYING = "This prize isn't being paid out right now."
const NOT_PAID_IN = "The prize couldn't be paid into your account."
const NOT_A_PLAYER = "This account didn't play this game, so it can't claim this prize."

/**
 * A refusal in the words of the player, by the reason it carries.
 *
 * Most keys are the errors the chain names. `NotEligibleForAirdrop` is the
 * Game pallet (claim_airdrop), which does not say which of its two rules
 * failed, and the four keys after it are those rules as the draw read before
 * a send tells them apart. The window and payout keys are the Airdrop pallet
 * (do_claim) and the asset transfer under it. `Call` and the long origin error
 * are the participant extension and the origin check of the Score pallet, both
 * for an account with no game recorded.
 */
const REFUSAL_WORDS: Record<ClaimRefusal, string> = {
  NotEligibleForAirdrop: "Only a member can claim this prize, before playing another game.",
  NotMember: "Only a member can claim this prize.",
  PlayedSince: "You've played another game since, so this prize can no longer be claimed.",
  NotAttended: "This game didn't count as attended, so its prize can't be claimed.",
  AttendanceNotRecorded: "Your attendance for this game isn't recorded yet.",
  NoSuchWinner: "This ticket didn't win this draw.",
  ClaimingWindowClosed: WINDOW_CLOSED,
  NotClaiming: WINDOW_CLOSED,
  UnknownEvent: WINDOW_CLOSED,
  AssetNotEnabled: NOT_PAYING,
  FundsUnavailable: NOT_PAYING,
  UnknownAsset: NOT_PAYING,
  BelowMinimum: NOT_PAID_IN,
  Frozen: NOT_PAID_IN,
  Blocked: NOT_PAID_IN,
  CannotCreate: NOT_PAID_IN,
  Overflow: NOT_PAID_IN,
  Call: NOT_A_PLAYER,
  BadOriginNotPersonNotSignedNotAccountParticipant: NOT_A_PLAYER,
}

export function claimRefusalWords(reason: string): string {
  return REFUSAL_WORDS[reason as ClaimRefusal] ?? "This prize can't be claimed."
}
