// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * `withAuthorizeCall`: submit a call whose pallet declares
 * `#[pallet::authorize]` as the unsigned General (v5) transaction the runtime
 * accepts for it.
 *
 * Such a call needs no account: `frame_system::AuthorizeCall` runs the
 * pallet's own authorization (for `Resources.remove_expired_username_reservation`,
 * "this queue entry has expired") and gives the call the `Authorized`
 * origin. A signed origin would be refused, so the wrapper sets
 * `VerifyMultiSignature` to `Disabled`, which makes the host assemble an
 * unsigned general transaction — origin `None` until `AuthorizeCall` lifts
 * it — exactly as `withAsDotnsGateway` does, without that wrapper's proof.
 * `RestrictOrigins` is sent as `false`: an `Authorized` origin is not an
 * entity the People runtime restricts, so the slot is only filled for a
 * deterministic encoding. The wrapped product account signs nothing.
 */
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common";

import {
  cachedPipeline,
  encodeChecked,
  RESTRICT_ORIGINS,
  toExtensionMap,
  toPayloadExtensions,
  VERIFY_SIGNATURE,
  VERIFY_SIGNATURE_DISABLED,
  withSlot,
  withStandardExtensions,
  type HostTxCreator,
  type TxCreate,
} from "./extension-pipeline.ts";

export function withAuthorizeCall(signer: CommonSignerTxCreator): CommonSignerTxCreator {
  const inner = signer as unknown as HostTxCreator;
  const pipelineFor = cachedPipeline();

  const create: TxCreate = async (payload, opts, bindings, mocked) => {
    if (mocked) return inner(payload, opts, bindings, true);
    const standard = await withStandardExtensions(inner.publicKey, payload, opts, bindings);
    const pipeline = pipelineFor(standard.context.metadata);
    let extensions = toExtensionMap(pipeline, standard.extensions);
    extensions = withSlot(
      pipeline,
      extensions,
      RESTRICT_ORIGINS,
      encodeChecked(pipeline.codec(pipeline.slot(RESTRICT_ORIGINS).type), false),
    );
    extensions = withSlot(
      pipeline,
      extensions,
      VERIFY_SIGNATURE,
      encodeChecked(pipeline.codec(pipeline.slot(VERIFY_SIGNATURE).type), VERIFY_SIGNATURE_DISABLED),
    );
    return inner(
      { ...standard, extensions: toPayloadExtensions(extensions), txExtVersion: pipeline.version },
      opts,
      bindings,
      false,
    );
  };
  return Object.assign(create, {
    publicKey: inner.publicKey,
    signBytes: (data: Uint8Array) => inner.signBytes(data),
  }) as unknown as CommonSignerTxCreator;
}
