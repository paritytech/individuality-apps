// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { people } from "@polkadot-api/descriptors";
import type { PolkadotClient, TypedApi } from "polkadot-api";

import { envConfig } from "@humanity/shared/config/env.ts";
import { getOrCreateClient } from "./connection.ts";
import { resolveNetwork, type NetworkConfig } from "./networks.ts";

export interface PeopleClient {
  readonly client: PolkadotClient;
  readonly api: TypedApi<typeof people>;
  readonly network: NetworkConfig;
  readonly wsUrl: string;
}

/**
 * The typed People-chain client. Types come from descriptors generated off the
 * live runtime metadata (`.papi/metadata/people.scale`) — never from
 * hand-written mirrors of the Rust structs, which drift silently.
 */
export async function getPeopleClient(): Promise<PeopleClient> {
  const network = resolveNetwork(envConfig.chain.network);
  const wsUrl = envConfig.chain.peopleWsUrl ?? network.peopleChain.wsUrl;
  const client = await getOrCreateClient(
    network.peopleChain.genesisHash,
    wsUrl
    
  );
  return { client, api: client.getTypedApi(people), network, wsUrl };
}
