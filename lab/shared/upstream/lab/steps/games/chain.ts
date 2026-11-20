// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
// The games integration reads People through the typed API generated from the
// humanity-spa submodule's committed PAPI metadata by this example's polkadot-api
// 3.x CLI (.papi/generate.mjs), bound to product-lab's ChainConnection over the
// polkadot-api adapter.
import type { PolkadotClient, TypedApi } from "polkadot-api";
import { people } from "../../chain/descriptors.ts";
import { connectPeopleChain, type PeopleChainConnection } from "../../chain/people.ts";

export type GamesPeopleApi = TypedApi<typeof people>;
export type GamesPeopleConnection = PeopleChainConnection<GamesPeopleApi>;
export const gamesPeopleApi = (client: PolkadotClient): GamesPeopleApi =>
  client.getTypedApi(people);

/** Open games' People connection; closed when `signal` aborts or on `close()`. */
export const connectGamesPeople = (ws: string, signal: AbortSignal): GamesPeopleConnection =>
  connectPeopleChain(ws, gamesPeopleApi, signal);
