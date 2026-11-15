// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * One claim of a won prize, sent the way the app files its vote report, for
 * the automatic claim of the app's draw screen and the results card of the
 * chat alike.
 *
 * Every send is preceded by a status read, so a claim that already landed is
 * never sent again, since a second claim is refused and a refusal costs a fee.
 * A call that never reached the chain is sent again by itself, after each wait
 * of `CLAIM_RETRY_MS`. A closed signing sheet and a refusal end it at once.
 */
import { isNonceRefusal, type DispatchResult } from "@individuality/people-chain"

/**
 * Why a claim did not land: the player closed the signing sheet, the chain
 * refused it, or every call failed before reaching the chain.
 */
export type ClaimFailure = "cancelled" | "refused" | "failed"

export type ClaimOutcome = { kind: "claimed" } | { kind: ClaimFailure; detail: string }

export const CLAIM_RETRY_MS = [1500, 3000, 6000] as const

/**
 * The reasons a claim is refused for, which a surface words for the player.
 *
 * Most are the errors the chain names. `NotEligibleForAirdrop` is the Game
 * pallet (claim_airdrop), which does not say which of its two rules failed,
 * and the four reasons after it are those rules as the draw read before a send
 * tells them apart. The window and payout reasons are the Airdrop pallet
 * (do_claim) and the asset transfer under it. `Call` and the long origin error
 * are the participant extension and the origin check of the Score pallet, both
 * for an account with no game recorded.
 */
export const CLAIM_REFUSALS = [
  "NotEligibleForAirdrop",
  "NotMember",
  "PlayedSince",
  "NotAttended",
  "AttendanceNotRecorded",
  "NoSuchWinner",
  "ClaimingWindowClosed",
  "NotClaiming",
  "UnknownEvent",
  "AssetNotEnabled",
  "FundsUnavailable",
  "UnknownAsset",
  "BelowMinimum",
  "Frozen",
  "Blocked",
  "CannotCreate",
  "Overflow",
  "Call",
  "BadOriginNotPersonNotSignedNotAccountParticipant",
] as const

/**
 * Undefined when the read failed, which never stops a send. `closed` carries
 * the reason the read gives, one of `CLAIM_REFUSALS`.
 */
export type ClaimStatus = "claimed" | "claimable" | { closed: string } | undefined

export interface ClaimDependencies {
  status(): Promise<ClaimStatus>
  send(): Promise<DispatchResult>
  /** Whether a refusal is the player closing the signing sheet, by its words. */
  declined(detail: string): boolean
  sleep(ms: number): Promise<void>
  onRetry?(attempt: number, detail: string): void
}

/** Claims one won prize: reads its status before every send, and sends again only a call that never reached the chain. */
export async function claimWithRetry(deps: ClaimDependencies): Promise<ClaimOutcome> {
  const status = () => deps.status().catch((): ClaimStatus => undefined)
  let detail = ""
  for (let attempt = 0; attempt <= CLAIM_RETRY_MS.length; attempt++) {
    if (attempt > 0) {
      deps.onRetry?.(attempt, detail)
      await deps.sleep(CLAIM_RETRY_MS[attempt - 1]!)
    }
    const before = await status()
    if (before === "claimed") return { kind: "claimed" }
    if (typeof before === "object") return { kind: "refused", detail: before.closed }
    let result: DispatchResult
    try {
      result = await deps.send()
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error)
      continue
    }
    if (result.ok) return { kind: "claimed" }
    detail = result.error
    if (deps.declined(result.error)) return { kind: "cancelled", detail }
    if (result.landingUnknown || isNonceRefusal(result.error)) continue
    const after = await status()
    if (after === "claimed") return { kind: "claimed" }
    return { kind: "refused", detail: typeof after === "object" ? after.closed : detail }
  }
  // the last send threw or lost its watch, which says nothing of where it went
  if ((await status()) === "claimed") return { kind: "claimed" }
  return { kind: "failed", detail }
}
