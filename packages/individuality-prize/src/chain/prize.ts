// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * A won prize on the People chain: whether the claim would be paid
 * (../claim-eligibility.ts over the player's `Score.Participants` row), the
 * claim itself (`Game.claim_airdrop`), and what the game account holds in the
 * prize assets afterwards, which the surface hands to the host's purse
 * (../prize-sweep.ts).
 *
 * Every surface that claims a prize hands in its client and calls these,
 * directly or through an engine of its own that carries the same calls.
 */
import { Enum, type SS58String } from "polkadot-api"
import { claimPrizeTx, fromPapi, withScoreParticipant, type PlayerKey } from "@parity/product-sdk-individuality"
import { submitToBestBlock, type DispatchResult, type PeopleSigner, type PeopleApi, type PeopleClient } from "@individuality/people-chain"
import { CLAIM_RECOGNITIONS, prizeClaimEligibility, type ClaimEligibility, type ClaimStanding } from "../claim-eligibility"
import type { PrizeBalanceHeld } from "../prize-sweep"

const accountKey = (player: SS58String | PlayerKey): PlayerKey => (typeof player === "string" ? Enum("Account", player) : player)

/** `Score.Participants` value — a player's standing in the personhood race */
export type ScoreParticipant = NonNullable<Awaited<ReturnType<PeopleApi["query"]["Score"]["Participants"]["getValue"]>>>

/** The claim's view of a `Score.Participants` row (none: no row). */
export function claimStanding(participant: ScoreParticipant | undefined): ClaimStanding | undefined {
  if (participant === undefined) return undefined
  return {
    recognized: CLAIM_RECOGNITIONS.has(participant.recognition.type),
    reachedPersonhood: participant.reached_personhood,
    lastAttendedGame: participant.last_attended_game ?? null,
  }
}

/**
 * Mirror of the personhood and attendance gates of `claim_airdrop` in the
 * pallet, so the UI can explain a refusal instead of surfacing a bare
 * `NotEligibleForAirdrop`.
 *
 * Pure, so a caller already watching `Score.Participants` does not need a
 * second read — see {@link claimEligibility} for the fetching version.
 */
export function evaluateClaimEligibility(participant: ScoreParticipant | undefined, gameIndex: number): ClaimEligibility {
  return prizeClaimEligibility(claimStanding(participant), gameIndex)
}

/** {@link evaluateClaimEligibility} over a fresh `Score.Participants` read */
export async function claimEligibility(
  api: PeopleApi,
  options: { gameIndex: number; player: SS58String | PlayerKey },
): Promise<ClaimEligibility> {
  const participant = await api.query.Score.Participants.getValue(accountKey(options.player), { at: "best" })
  return evaluateClaimEligibility(participant, options.gameIndex)
}

/** A balance in one asset the prize draws pay in. */
export interface PrizeBalance {
  /** the asset location as JSON, with bigints written as strings */
  assetKey: string
  amount: bigint
}

export function prizeAssetKey(location: unknown): string {
  return JSON.stringify(location ?? null, (_, value: unknown) => (typeof value === "bigint" ? value.toString() : value))
}

/**
 * What `player` holds in every asset `Airdrop.SupportedAssets` lists, at the
 * best block, leaving out the empty ones.
 *
 * A claimed prize is paid into the game account, which no wallet of the host
 * counts, so the surface reads it here to hand it to the host. The SDK has no
 * asset balance read yet.
 */
export async function fetchPrizeBalances({ api }: PeopleClient, player: SS58String): Promise<PrizeBalance[]> {
  const assets = await api.query.Airdrop.SupportedAssets.getEntries({ at: "best" })
  const balances = await Promise.all(
    assets.map(async ({ keyArgs: [asset] }) => {
      const account = await api.query.Assets.Account.getValue(asset, player, { at: "best" })
      return { assetKey: prizeAssetKey(asset), amount: account?.balance ?? 0n }
    }),
  )
  return balances.filter((balance) => balance.amount > 0n)
}

/** A won prize's calls, which an engine of a product's own may carry too. */
export interface PrizeChain {
  /** whether `Game.claim_airdrop` would pay `address` for `gameIndex`, and why not */
  eligibility(address: string, gameIndex: number): Promise<ClaimEligibility>
  /** what `address` holds in the prize assets, amounts in planck as text */
  prizeBalances(address: string): Promise<PrizeBalanceHeld[]>
  /** `Game.claim_airdrop`, settled at the best block */
  claimPrize(signer: PeopleSigner, gameIndex: number, airdropIndex: number, beneficiary: string): Promise<DispatchResult>
}

/** The prize calls over a People-chain client: the eligibility read, the claim, and the game account's prize balances. */
export function createPrizeChain(client: PeopleClient): PrizeChain {
  const chain = fromPapi(client.client, client.api)
  return {
    eligibility: (address, gameIndex) => claimEligibility(client.api, { gameIndex, player: address }),
    async prizeBalances(address) {
      const balances = await fetchPrizeBalances(client, address)
      return balances.map(({ assetKey, amount }) => ({ assetKey, amount: amount.toString() }))
    },
    // the same origin as the report: the pallet takes a participant
    // (`ensure_signed_or_participant_or_person`), so the claim rides
    // ScoreAsParticipant and costs a free-signed-up account nothing. A
    // REFUSED claim would pay a fee, which is why a surface only claims once
    // every gate it can read is open.
    claimPrize: (signer, gameIndex, airdropIndex, beneficiary) =>
      submitToBestBlock(claimPrizeTx(chain, { gameIndex, airdropIndex, beneficiary }).createSubmitAndWatch(withScoreParticipant(signer))),
  }
}
