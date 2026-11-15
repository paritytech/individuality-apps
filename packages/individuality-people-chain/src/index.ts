// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The People chain, as every shared package that reads or submits speaks it:
 * the client a surface connects (./client.ts), what a transaction is signed
 * with and comes back as (./types.ts), settling one at the best block and
 * naming a refusal (./submit.ts), and the words of a host's failure
 * (./host-failure.ts).
 */
export type { PeopleApi, PeopleClient } from "./client"
export type { DispatchResult, PeopleSigner } from "./types"
export { abortError, dispatchErrorName, isNonceRefusal, isTrackingStopped, submitToBestBlock, toDispatchResult, type TxEvent } from "./submit"
export {
  chainVerdict,
  classifyHostFailure,
  HOST_FAILURE_CLASSES,
  walkTags,
  type ChainVerdict,
  type HostFailureClass,
} from "./host-failure"
