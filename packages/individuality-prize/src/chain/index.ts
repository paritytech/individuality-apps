// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A won prize's chain side (./prize.ts): whether the claim would be paid, the
 * claim, and the prize balances a claim leaves on the game account. A subpath
 * of its own: it brings the SDK and papi, which the pure rules keep out of a
 * screen's bundle.
 */
export {
  claimEligibility,
  claimStanding,
  createPrizeChain,
  evaluateClaimEligibility,
  fetchPrizeBalances,
  prizeAssetKey,
  type PrizeBalance,
  type PrizeChain,
  type ScoreParticipant,
} from "./prize"
