// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The chain pair `getClaims` reads, for a script.
 *
 * `NEXT_PUBLIC_ASSET_HUB_WS` picks the Asset Hub, and paseo-next-v2 People
 * gets the paseo-next-v2 Asset Hub by default. Any other People endpoint, a
 * local node above all, reads People alone, because an Asset Hub of another
 * network would answer for block numbers it never saw.
 */
import { createClient } from "polkadot-api"
import { getWsProvider } from "polkadot-api/ws"
import { claimsChain, type ClaimsChain } from "@individuality/game-outcome/chain"
import type { PeopleClient } from "@jollity/game-chain"

export const PASEO_PEOPLE_WS = "wss://paseo-people-next-system-rpc.polkadot.io"
const PASEO_ASSET_HUB_WS = "wss://paseo-asset-hub-next-rpc.polkadot.io"

export function scriptClaimsChain(people: PeopleClient, peopleWs: string): { chain: ClaimsChain; close(): void } {
  const assetHubWs =
    process.env.NEXT_PUBLIC_ASSET_HUB_WS || (peopleWs === PASEO_PEOPLE_WS ? PASEO_ASSET_HUB_WS : undefined)
  const assetHub = assetHubWs ? createClient(getWsProvider(assetHubWs)) : undefined
  return { chain: claimsChain(people, assetHub), close: () => assetHub?.destroy() }
}
