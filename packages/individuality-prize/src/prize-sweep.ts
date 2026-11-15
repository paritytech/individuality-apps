// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Hands a claimed prize to the host, for the results screen of the app and the
 * results card of the chat alike.
 *
 * `Game.claim_airdrop` pays into the game account, and the CASH card of the
 * host counts only the coins of its own purse, so a prize stays out of sight
 * until the host tops the purse up from that account (RFC-0006
 * `payment.topUp`). Each balance the game account holds in a prize asset is
 * topped up once per claim. The host runs one top-up per source at a time and
 * answers once it has accepted one, so a second asset would be refused as busy
 * while the first runs. The host tops up its one payment asset
 * (RFC-0006 has a single asset), so the sweep is right only while every asset
 * in `Airdrop.SupportedAssets` is that asset.
 *
 * The id of a top-up is a hash of the namespace of the product, the account,
 * the asset, the amount and the claim the sweep follows, so a retry of one
 * claim at the same balance is refused as `AlreadyExists`, and a later claim
 * that leaves the same balance is paid.
 */

/** A balance the game account holds in one prize asset, the amount in planck as text. */
export interface PrizeBalanceHeld {
  assetKey: string
  amount: string
}

const hex = (bytes: Uint8Array): `0x${string}` => `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`

/**
 * What the host answered: `already-sent` for an id it has seen, `busy` for a
 * source with a top-up still running, and `no-host` outside a host.
 */
export type TopUpOutcome = "sent" | "already-sent" | "busy" | "refused" | "timeout" | "no-host"

export interface PrizeTopUp {
  assetKey: string
  amount: bigint
  outcome: TopUpOutcome
}

export interface PrizeSweepDependencies {
  balances(): Promise<PrizeBalanceHeld[]>
  topUp(amount: bigint, id: `0x${string}`): Promise<TopUpOutcome>
  /** blake2b-256 */
  hash(bytes: Uint8Array): Uint8Array
  /**
   * The namespace of the product (`jollity` for Jollity), the product account
   * and the address of the game account, which scope the id.
   */
  account: { namespace: string; product: string; address: string }
  /** The landed claim the sweep follows, which scopes the id. */
  claim: { gameIndex: number; airdropIndex: number }
}

export function prizeTopUpId(
  hash: (bytes: Uint8Array) => Uint8Array,
  account: { namespace: string; product: string; address: string },
  balance: PrizeBalanceHeld,
  claim: { gameIndex: number; airdropIndex: number },
): `0x${string}` {
  const seed = `${account.namespace}:prize:${account.product}:${account.address}:${balance.assetKey}:${balance.amount}:${claim.gameIndex}:${claim.airdropIndex}`
  return hex(hash(new TextEncoder().encode(seed)))
}

/** Rejects when the balances cannot be read, and resolves with the answer of the host to each top-up. */
export async function sweepPrizes(deps: PrizeSweepDependencies): Promise<PrizeTopUp[]> {
  const balances = await deps.balances()
  const topUps: PrizeTopUp[] = []
  for (const balance of balances) {
    const amount = BigInt(balance.amount)
    if (amount <= 0n) continue
    const outcome = await deps.topUp(amount, prizeTopUpId(deps.hash, deps.account, balance, deps.claim))
    topUps.push({ assetKey: balance.assetKey, amount, outcome })
  }
  return topUps
}

/**
 * The outcome a top-up error carries, read from the innermost tag of its
 * cause: the SDK throws `Error(label, { cause })` around the truapi error,
 * which nests the tag of the host under `Domain` and `V1`.
 */
export function topUpErrorOutcome(error: unknown): TopUpOutcome {
  const tag = innermostTag(error)
  if (tag === "AlreadyExists") return "already-sent"
  if (tag === "SourceBusy") return "busy"
  return "refused"
}

function innermostTag(error: unknown): string | undefined {
  let current: unknown = error instanceof Error ? error.cause : error
  let tag: string | undefined
  for (let depth = 0; depth < 6 && typeof current === "object" && current !== null; depth++) {
    const tagged = current as { tag?: unknown; value?: unknown }
    if (typeof tagged.tag !== "string") break
    tag = tagged.tag
    current = tagged.value
  }
  return tag
}
