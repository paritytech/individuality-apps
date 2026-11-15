// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Binds transactions to a signer that holds its own key.
 *
 * The origin signers of the SDK and `@parity/product-sdk-tx` leave
 * `VerifyMultiSignature` to the signer, which is right for the host: it fills
 * the slot itself. The local keypair creator of papi refuses to build without
 * it, so the scripts bind their transactions here.
 */
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common"

export interface SubmittableTx {
  // `any` on purpose: this is the structural minimum every papi transaction
  // satisfies, and BoundTx reads the exact option and return types back off the
  // concrete transaction. `unknown` would not unify with papi's generics.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  createAndSubmit: (creator: CommonSignerTxCreator, options?: any) => any
  createSubmitAndWatch: (creator: CommonSignerTxCreator, options?: any) => any
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** A papi transaction with the signer pre-bound — caller picks the submit style */
export interface BoundTx<T extends SubmittableTx> {
  /** the raw papi transaction (fee estimation, encoded call data, manual signing) */
  tx: T
  /** promise-based submit, resolves on finalization */
  createAndSubmit: (
    options?: Parameters<T["createAndSubmit"]>[1],
  ) => ReturnType<T["createAndSubmit"]>
  /** observable-based submit with lifecycle events */
  createSubmitAndWatch: (
    options?: Parameters<T["createSubmitAndWatch"]>[1],
  ) => ReturnType<T["createSubmitAndWatch"]>
}

/**
 * Individuality runtimes carry custom transaction extensions that
 * polkadot-api cannot auto-default. Most are empty composites (fine), but
 * `VerifyMultiSignature` is an enum (`Disabled | Signed`) and must be sent
 * explicitly as `Disabled` — otherwise papi rejects signing with
 * "Missing VerifyMultiSignature signed extension" (matches dot-cli's
 * auto-default: enum with a `Disabled` variant ⇒ `Disabled`).
 */
const CUSTOM_SIGNED_EXTENSIONS = {
  VerifyMultiSignature: { value: { type: "Disabled", value: undefined } },
} as const

type CustomSignedExtensions = Record<string, { value: unknown; additionalSigned?: unknown }>
type WithCustomExtensions = { customSignedExtensions?: CustomSignedExtensions }

export function withCustomExtensions<T extends WithCustomExtensions>(
  options?: T,
): T & { customSignedExtensions: CustomSignedExtensions } {
  return {
    ...(options as T),
    customSignedExtensions: {
      ...CUSTOM_SIGNED_EXTENSIONS,
      ...options?.customSignedExtensions,
    },
  }
}

export function bindTx<T extends SubmittableTx>(
  tx: T,
  signer: CommonSignerTxCreator,
): BoundTx<T> {
  return {
    tx,
    createAndSubmit: (options) =>
      tx.createAndSubmit(signer, withCustomExtensions(options)),
    createSubmitAndWatch: (options) =>
      tx.createSubmitAndWatch(signer, withCustomExtensions(options)),
  }
}

/**
 * Wrap a signer so every extrinsic it builds for the wire is reported to `log` as hex.
 *
 * A build with a mocked signature, which papi asks for to estimate fees, is
 * passed through unlogged, since those bytes never reach the chain.
 *
 * Written for the host-backed product signer: the host's `createTransaction`
 * re-assembles the transaction from the forwarded extension values, so when
 * the chain rejects one, the bytes it actually built are the only evidence of
 * what went on the wire (decodable offline against the chain metadata). Wrap
 * an in-page signer with it too and the two paths become byte-diffable, which
 * is how a host-side rebuild bug gets pinned to a field.
 */
export function withExtrinsicLogging(
  signer: CommonSignerTxCreator,
  log: (hex: string, byteLength: number) => void,
): CommonSignerTxCreator {
  const create = async (...args: Parameters<CommonSignerTxCreator>) => {
    const hex = await signer(...args)
    const [, , , mockedSignature] = args
    if (!mockedSignature) log(hex, (hex.length - 2) / 2)
    return hex
  }
  return Object.assign(create, {
    publicKey: signer.publicKey,
    signBytes: signer.signBytes,
  }) as unknown as CommonSignerTxCreator
}
