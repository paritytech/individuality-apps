// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * WHO `Game.claim_airdrop` PAYS: a winner the chain recognizes as a person
 * (`Recognized` or `ExternallyRecognized`, pallet-score `is_recognized`) or
 * who has reached personhood, and only while this game is the last one they
 * attended, so playing the next game closes the claim. The pallet refuses
 * anything else with `NotEligibleForAirdrop`, which names neither rule, and a
 * refused claim costs a fee: so a claim button, an automatic claim and the
 * chat's card all ask this first, with the reason a refusal would have.
 *
 * Pure, over the player's standing as each surface reads it.
 *
 * The product SDK's `deriveClaimEligibility` holds these same two rules, but
 * only together with the draw's (its phase, the winner, the window, the
 * asset), so it cannot answer before the draw or while a surface waits for
 * attendance to land. This is the player's part alone, until the SDK exports
 * it on its own.
 */

/** The player's `Score.Participants` row, as far as the claim reads it. */
export interface ClaimStanding {
  /** recognized in pallet-score: `Recognized` or `ExternallyRecognized` */
  recognized: boolean
  reachedPersonhood: boolean
  lastAttendedGame: number | null
}

/** Why `Game.claim_airdrop` would or would not go through for a game */
export interface ClaimEligibility {
  eligible: boolean
  /** recognized in pallet-score, or over the personhood threshold */
  personhood: boolean
  /** `Score.Participants.last_attended_game === gameIndex` */
  isMostRecentAttendedGame: boolean
  lastAttendedGame: number | null
  /** short human-readable reason when not eligible */
  reason: string | null
}

/** pallet-score's recognitions that count as a person for the claim */
export const CLAIM_RECOGNITIONS: ReadonlySet<string> = new Set(["Recognized", "ExternallyRecognized"])

/** Whether a winner of `gameIndex` with this standing (none: no score row) can claim. */
export function prizeClaimEligibility(standing: ClaimStanding | undefined, gameIndex: number): ClaimEligibility {
  const personhood = standing !== undefined && (standing.recognized || standing.reachedPersonhood)
  const lastAttendedGame = standing?.lastAttendedGame ?? null
  const isMostRecentAttendedGame = lastAttendedGame === gameIndex
  const reason = !standing
    ? "not a scored participant yet"
    : !personhood
      ? "not recognized and below the personhood threshold"
      : !isMostRecentAttendedGame
        ? lastAttendedGame === null
          ? "no attended game recorded"
          : `most recent attended game is #${lastAttendedGame}`
        : null
  return { eligible: personhood && isMostRecentAttendedGame, personhood, isMostRecentAttendedGame, lastAttendedGame, reason }
}
