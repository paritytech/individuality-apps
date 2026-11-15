// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A won prize: who a claim pays (./claim-eligibility.ts), the claim with its
 * retries (./claim.ts), a claim made once the chain would pay it
 * (./claim-when-payable.ts), and the prize handed to the host's purse
 * (./prize-sweep.ts). The claim's chain side is ./chain, a subpath of its own.
 */
export { CLAIM_RECOGNITIONS, prizeClaimEligibility, type ClaimEligibility, type ClaimStanding } from "./claim-eligibility"
export {
  CLAIM_REFUSALS,
  CLAIM_RETRY_MS,
  claimWithRetry,
  type ClaimDependencies,
  type ClaimFailure,
  type ClaimOutcome,
  type ClaimStatus,
} from "./claim"
export { claimWhenPayable, type ClaimRun, type ClaimWhenPayableOptions, type PayableDraw } from "./claim-when-payable"
export {
  prizeTopUpId,
  sweepPrizes,
  topUpErrorOutcome,
  type PrizeBalanceHeld,
  type PrizeSweepDependencies,
  type PrizeTopUp,
  type TopUpOutcome,
} from "./prize-sweep"
