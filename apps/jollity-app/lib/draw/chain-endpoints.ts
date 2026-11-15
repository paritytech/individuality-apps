// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { localNetwork } from "@jollity/protocol"

/**
 * Each network's own chains, by DotNS TLD, for a page whose host serves none
 * (the local host CLI): where the names on the draw's wheel are read
 * from (../player-names.ts), and linked (./name-link.ts), without one.
 */
const CHAIN_WS: Record<string, { assetHub: string; people: string }> = {
  paseo: { assetHub: "wss://paseo-asset-hub-next-rpc.polkadot.io", people: "wss://paseo-people-next-system-rpc.polkadot.io" },
  testnet: { assetHub: "wss://previewnet.substrate.dev/asset-hub", people: "wss://previewnet.substrate.dev/people" },
}

/** The network's Asset Hub and People endpoints, which `NEXT_PUBLIC_ASSET_HUB_WS` and
 *  `NEXT_PUBLIC_PEOPLE_WS` override; null where there is none. */
export function chainEndpoints(tld: string): { assetHub: string | null; people: string | null } {
  const local = localNetwork()
  if (local) return local.endpoints
  return {
    assetHub: process.env.NEXT_PUBLIC_ASSET_HUB_WS || CHAIN_WS[tld]?.assetHub || null,
    people: process.env.NEXT_PUBLIC_PEOPLE_WS || CHAIN_WS[tld]?.people || null,
  }
}
