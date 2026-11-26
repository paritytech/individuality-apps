// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Asset Hub, reached through the host: the DotNS contracts (the `profile`
 * record is a content-resolver text record, so every read and write is a
 * pallet-revive contract call through a `ContractRuntime`) and PGAS, the asset
 * that pays the fee and the record's storage deposit.
 */
import { getChainAPI } from "@parity/product-sdk/chain";
import { createContractRuntimeFromClient, type ContractRuntime } from "@parity/product-sdk/contracts";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { previewnet_asset_hub } from "@parity/product-sdk-descriptors/previewnet-asset-hub";

import { network } from "./config.ts";

/**
 * The PGAS reads `funding.ts` makes outside the profile module, typed here
 * rather than through one network's descriptor so paseo and previewnet share
 * them.
 */
export interface AssetHubApi {
  readonly constants: { readonly Pgas: { readonly PgasAssetId: () => Promise<number | bigint> } };
  readonly query: {
    readonly Assets: {
      readonly Account: {
        getValue(id: number, who: string, opts?: { at?: "best" | "finalized" }): Promise<{ balance: bigint } | undefined>;
      };
    };
  };
}

export interface Chains {
  readonly assetHub: AssetHubApi;
  /** For every profile read and prepare. */
  readonly runtime: ContractRuntime;
}

let connecting: Promise<Chains> | null = null;

/**
 * Connect once and share the connection. The environment is pinned, so a host
 * on another network throws `EnvironmentMismatchError` instead of quietly
 * reading the wrong chain.
 */
export function chains(): Promise<Chains> {
  connecting ??= connect().catch((error: unknown) => {
    connecting = null;
    throw error;
  });
  return connecting;
}

async function connect(): Promise<Chains> {
  const client = network.environment === "previewnet" ? await getChainAPI("previewnet") : await getChainAPI("paseo");
  const descriptor = network.environment === "previewnet" ? previewnet_asset_hub : paseo_asset_hub;
  return {
    assetHub: client.raw.assetHub.getUnsafeApi() as unknown as AssetHubApi,
    runtime: createContractRuntimeFromClient(client.raw.assetHub, descriptor),
  };
}
