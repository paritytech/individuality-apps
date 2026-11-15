// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * What every transaction on the People chain is signed with and comes back as,
 * whoever submits it: the sign-up, the bind, the report, a prize claim.
 */
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common"

/** The signer a surface hands in — product-sdk's product-account signer.
 *  The chain side signs extrinsics with it. */
export type PeopleSigner = CommonSignerTxCreator

/** What an extrinsic comes back as. `error` is the pallet's own error name
 *  (`AlreadyRegistered`, `NotRegistered`, `Early`, …) so every surface fails the
 *  same way and the app explains a refusal with the same code. */
export type DispatchResult =
  | { ok: true }
  /** `landingUnknown`: the landing watch stopped (or the stream
   *  ended) without learning the outcome. It is NOT a refusal by the chain, so
   *  the caller re-reads the state before calling the transaction failed. */
  | { ok: false; error: string; landingUnknown?: true }
