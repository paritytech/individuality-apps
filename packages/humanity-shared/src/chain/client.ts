// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { people } from "@polkadot-api/descriptors";
import { paseo } from "../../.papi/paseo-descriptors/dist/index.js";
import type { PolkadotClient, TypedApi } from "polkadot-api";

import { envConfig } from "@humanity/shared/config/env.ts";
import { getOrCreateClient } from "./connection.ts";
import { resolveNetwork, type NetworkConfig } from "./networks.ts";

// The worker build folds this branch before bundling generated metadata.
declare const __WORKER_PASEO__: boolean | undefined;

export type PeopleApi = TypedApi<typeof people> | TypedApi<typeof paseo>;

export interface PeopleClient {
  readonly client: PolkadotClient;
  readonly api: PeopleApi;
  readonly network: NetworkConfig;
  readonly wsUrl: string;
}

/** Both descriptors are generated at install time from the committed SCALE metadata. */
export async function getPeopleClient(): Promise<PeopleClient> {
  const network = resolveNetwork(envConfig.chain.network);
  const wsUrl = envConfig.chain.peopleWsUrl ?? network.peopleChain.wsUrl;
  const client = await getOrCreateClient(network.peopleChain.genesisHash, wsUrl);
  const usePaseo = typeof __WORKER_PASEO__ === "undefined" ? network.key === "paseo-next-v2" : __WORKER_PASEO__;
  const api = usePaseo
    ? client.getTypedApi(paseo)
    : client.getTypedApi(people);
  return { client, api, network, wsUrl };
}
