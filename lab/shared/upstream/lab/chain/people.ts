// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
// Connections and transactions on the People chain for the humanity and games
// integrations: the polkadot-api adapters from product-lab, People's signing
// extensions and its Sudo convention. Before refactor step 3 product-lab core
// supplied the signing defaults and the Sudo check itself.
import { Enum } from "polkadot-api";
import type { ActivitySink } from "@parity/product-lab";
import {
  ChainConnection,
  TransactionExecutor,
  type TransactionJournal,
  type TransactionMode,
} from "@parity/product-lab/chain";
import {
  PapiChainAccess,
  PapiTransactionSubmitter,
  type ChainApiFactory,
} from "@parity/product-lab/chain-papi";
import { SudoDispatchValidator } from "./sudo.ts";
import { nodeSystem } from "../system.ts";

/** The People runtime's custom signed extensions, carried by every signed call. */
export const PEOPLE_SIGNING = {
  customSignedExtensions: {
    VerifyMultiSignature: { value: Enum("Disabled") },
    RestrictOrigins: { value: false },
  },
};

/** A People connection over the polkadot-api adapter, with the consumer's typed API. */
export type PeopleChainConnection<Api> = ChainConnection<PapiChainAccess<Api>>;

/** Open a People connection whose lifetime follows `signal`. */
export function connectPeopleChain<Api>(
  ws: string,
  api: ChainApiFactory<Api>,
  signal: AbortSignal,
  activity?: ActivitySink,
): PeopleChainConnection<Api> {
  return new ChainConnection(PapiChainAccess.connect(ws, { api }), signal, { clock: nodeSystem().clock, ...(activity ? { activity } : {}) });
}

/** The transaction executor for a People connection: People signing, Sudo inner results checked. */
export function peopleTransactions(
  chain: PeopleChainConnection<unknown>,
  journal: TransactionJournal,
  mode?: TransactionMode,
): TransactionExecutor {
  return new TransactionExecutor(new PapiTransactionSubmitter(chain.access, { signing: PEOPLE_SIGNING }), journal, {
    signal: chain.signal,
    chain: "people",
    clock: nodeSystem().clock,
    ...(mode ? { mode } : {}),
    validator: new SudoDispatchValidator(),
  });
}
