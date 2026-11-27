// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
// Humanity reads the People chain through the typed API generated from the
// humanity-spa submodule's own committed PAPI metadata by this example's
// polkadot-api 3.x CLI (.papi/generate.mjs), bound to product-lab's
// environment-neutral ChainConnection over the polkadot-api adapter.
import type { PolkadotClient, TypedApi } from "polkadot-api";
import { people } from "../../../chain/descriptors.ts";
import type { ActivitySink } from "@parity/product-lab";
import { connectPeopleChain, type PeopleChainConnection } from "../../../chain/people.ts";

export type PeopleApi = TypedApi<typeof people>;
export type PeopleConnection = PeopleChainConnection<PeopleApi>;
export const peopleApi = (client: PolkadotClient): PeopleApi =>
  client.getTypedApi(people);

/** Open Humanity's People connection; closed when `signal` aborts or on `close()`. */
export const connectPeople = (
  ws: string,
  signal: AbortSignal,
  activity?: ActivitySink,
): PeopleConnection => connectPeopleChain(ws, peopleApi, signal, activity);

export { peopleTransactions } from "../../../chain/people.ts";
