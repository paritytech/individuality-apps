// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The lite route's chain facts, for a script: the product SDK's reads over a
 * People client. The app and the chat reach these through the sign-up
 * (@individuality/sign-up over the SDK's `readGameSeat`), never through here.
 */
import type { SS58String } from "polkadot-api"
import {
  fromPapi,
  litePeopleRing,
  readLiteSignUpRequirement,
  readScoreContext,
  type LiteSignUpRequirement,
  type RingLocation,
  type ScoreContext,
} from "@parity/product-sdk-individuality"
import type { PeopleApi, PeopleClient } from "@jollity/game-chain"

/** this chain's people-lite ring, named by its genesis */
export async function litePeopleRingOf(client: PeopleClient): Promise<RingLocation> {
  const { genesisHash } = await client.client.getChainSpecData()
  // papi types the genesis as `string`; the SDK wants the `0x` literal it is
  return litePeopleRing(genesisHash as `0x${string}`)
}

/** `Score.score_context`: the context a lite proof is minted in */
export async function readScoreContextOf(client: PeopleClient): Promise<ScoreContext> {
  const result = await readScoreContext(fromPapi(client.client, client.api))
  if (!result.ok) throw result.error
  return result.value
}

/** what stands between `account` and a free sign-up */
export async function readLiteSignUp(client: PeopleClient, account: SS58String): Promise<LiteSignUpRequirement> {
  const result = await readLiteSignUpRequirement(fromPapi(client.client, client.api), { account })
  if (!result.ok) throw result.error
  return result.value
}

/** `PeopleLite.AccountToAlias[account]` at the finalized block: the lite binding, if any */
export function liteAliasBinding(api: PeopleApi, account: SS58String) {
  return api.query.PeopleLite.AccountToAlias.getValue(account, { at: "finalized" })
}
