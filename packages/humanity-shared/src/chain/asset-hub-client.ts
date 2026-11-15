// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import type { PolkadotClient, TypedApi } from "polkadot-api";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";

import { envConfig } from "@humanity/shared/config/env.ts";
import { getOrCreateClient } from "./connection.ts";
import { resolveNetwork, type NetworkConfig } from "./networks.ts";

/**
 * The Asset Hub API as the SDK's paseo-next-v2 descriptors type it. Previewnet
 * runs the same runtime family; the pallets this app touches (`DotnsGateway`,
 * `MembersSubscriber`) have the same shape there, and a drift fails at the
 * call with a PAPI incompatibility error rather than silently.
 */
export type AssetHubApi = TypedApi<typeof paseo_asset_hub>;

export interface AssetHubClient {
  readonly client: PolkadotClient;
  readonly api: AssetHubApi;
  readonly network: NetworkConfig;
  readonly wsUrl: string;
}

/**
 * The typed Asset Hub client for the selected network: the dotNS contracts
 * and the `DotnsGateway` pallet live there, not on People. Cached per genesis
 * like the People client, through the host bridge when inside a host.
 */
export async function getAssetHubClient(): Promise<AssetHubClient> {
  const network = resolveNetwork(envConfig.chain.network);
  const wsUrl = network.assetHub.wsUrl;
  const client = await getOrCreateClient(network.assetHub.genesisHash, wsUrl, {
    metadataSlot: "per-genesis",
  });
  return { client, api: client.getTypedApi(paseo_asset_hub), network, wsUrl };
}
