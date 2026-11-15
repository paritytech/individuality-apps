// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The credits a game earned the player, on the chain pair `getClaims` of
 * `@parity/product-sdk-nfts` reads (`readGameCredits`, counted by
 * ../credits.ts), and that pair (`claimsChain`).
 *
 * The People chain awards the claims, and Asset Hub says whether their roots
 * arrived and which leaves are spent. Asset Hub is read through the unsafe
 * papi API, because the SDK types its reads structurally and a second
 * descriptor pin would drift as the People one did.
 *
 * Without an Asset Hub only `getClaims` may read the pair. Its two Asset Hub
 * reads answer nothing, so the claims People awarded come back, each as
 * earned, and every catalogue read is missing. Only the scripts read without
 * an Asset Hub.
 */
import type { PolkadotClient } from "polkadot-api"
import type { NftsChain, NftsCreditsChain } from "@parity/product-sdk-nfts"
import type { PeopleClient } from "@individuality/people-chain"
import { gameCredits, type GameCredits } from "../credits"

export type ClaimsChain = NftsChain & NftsCreditsChain

type ClaimsReads = NftsCreditsChain & Pick<NftsChain, "raw">

const NO_BLOCK = { hash: "0x", number: 0 }

const nothingFor = async <K>(keys: K[]) => keys.map(() => undefined)

const noAssetHub = {
  query: {
    NftClaims: {
      CreditTrees: { getValues: nothingFor },
      ClaimedLeaves: { getValues: async (keys: [number][]) => keys.map(() => new Uint8Array()) },
    },
  },
}

export function claimsChain(people: PeopleClient, assetHub?: PolkadotClient): ClaimsChain {
  const reads = {
    individuality: people.api,
    assetHub: assetHub ? (assetHub.getUnsafeApi() as unknown as NftsCreditsChain["assetHub"]) : noAssetHub,
    raw: {
      individuality: people.client,
      assetHub: assetHub ?? { getFinalizedBlock: async () => NO_BLOCK, getBestBlocks: async () => [NO_BLOCK] },
    },
  } satisfies ClaimsReads
  // The SDK types every nfts read over the whole NftsChain. With an Asset Hub
  // the unsafe api carries all of it, and without one the header says what is left.
  return reads as ClaimsReads as ClaimsChain
}

/**
 * The credits `gameIndex` earned `address`, or null when the read fails.
 * `latestGame`: the game is the last one the player attended, so the credits
 * still waiting for a root are its own.
 *
 * The nfts SDK is loaded on the first read, so a surface that never asks
 * carries none of it at start.
 */
export async function readGameCredits(
  chain: ClaimsChain,
  options: { address: string; gameIndex: number; latestGame: boolean },
): Promise<GameCredits | null> {
  const nfts = await import("@parity/product-sdk-nfts")
  const claims = await nfts.getClaims(chain, { claimant: { tag: "Account", address: options.address }, individualityAt: "best" })
  if (!claims.ok) return null
  return gameCredits(claims.value.claims, options.gameIndex, options.latestGame)
}
