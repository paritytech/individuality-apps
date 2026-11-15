// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * `withAsDotnsGateway`: submit `DotnsGateway.register_name` as the General
 * (v5) transaction the Asset Hub runtime requires.
 *
 * The call takes no account origin. `AsDotnsGateway` — a transaction
 * extension — authenticates it from `RegisterFullName { proof, ring_index,
 * revision, signature }`, where `proof` is the person's ring-VRF proof over
 * the registration intent (built before the transaction, see
 * `proof-message.ts`) and `signature` is `who`'s sr25519 signature over
 * `blake2_256(inherited implication)`. The implication is the call plus the
 * explicit value and implicit of every extension *after* `AsDotnsGateway` in
 * the pipeline (`RestrictOrigins`), prefixed by the extension version — the
 * same shape the SDK's `withAsPerson` hashes for `AsPerson` on People.
 *
 * Like `withAsPerson`, this wraps the host's signer rather than the submitter:
 * PAPI only resolves nonce, mortality and the runtime versions inside its own
 * `createTx`, so the implication can only be hashed from the signer's
 * `signTx`. Inside it, in order:
 *
 * 1. `RestrictOrigins` to `true` (after `AsDotnsGateway`, so inside the hash;
 *    the origin-restriction pallet refuses the call otherwise).
 * 2. `VerifyMultiSignature` to `Disabled`, which makes the host assemble an
 *    unsigned general transaction — origin `None`, the only origin the
 *    extension accepts.
 * 3. Hash the implication and ask `who` for a signature over it.
 * 4. Write `AsDotnsGateway` last; its own slot is outside its hash.
 *
 * The pipeline reading, round-trip-checked encoding and implication builder
 * live in `../extension-pipeline.ts`. Fold this back into the SDK once it
 * grows a dotNS gateway signer.
 */
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common";
import { Blake2256 } from "@polkadot-api/substrate-bindings";
import { fromHex, toHex } from "polkadot-api/utils";

import {
  buildImplication,
  cachedPipeline,
  encodeChecked,
  RESTRICT_ORIGINS,
  toExtensionMap,
  toPayloadExtensions,
  VERIFY_SIGNATURE,
  VERIFY_SIGNATURE_DISABLED,
  withSlot,
  withStandardExtensions,
  type ExtensionPipeline,
  type HostTxCreator,
  type TxCreate,
} from "../extension-pipeline.ts";

export const AS_DOTNS_GATEWAY = "AsDotnsGateway";
const SR25519_SIGNATURE_BYTES = 64;
const PROOF_BYTES_MAX = 8 * 1024;

export class AsDotnsGatewayError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AsDotnsGatewayError";
  }
}

/** What `AsDotnsGateway` carries for a full-name registration. */
export interface AsDotnsGatewayInfo {
  /** Ring-VRF proof over the registration intent (`registerNameProofMessage`). */
  readonly proof: Uint8Array;
  /** The People ring the proof was built in. */
  readonly ringIndex: number;
  /** The People root revision the proof was built against; Asset Hub must hold it. */
  readonly ringRevision: number;
  /**
   * `who`'s raw sr25519 signature over the 32-byte implication digest — no
   * `<Bytes>` wrapping, the chain verifies the digest as given.
   */
  readonly signImplication: (digest: Uint8Array) => Promise<Uint8Array>;
}

function checkProof(proof: Uint8Array): Uint8Array {
  if (proof.length === 0) {
    throw new AsDotnsGatewayError("ring VRF proof is empty");
  }
  if (proof.length > PROOF_BYTES_MAX) {
    throw new AsDotnsGatewayError("ring VRF proof is larger than the chain will accept");
  }
  return proof;
}

/** `Some(RegisterFullName { .. })` in the dynamic builder's enum shape. */
function encodeAsDotnsGatewayValue(
  pipeline: ExtensionPipeline,
  info: AsDotnsGatewayInfo,
  signature: Uint8Array,
): Uint8Array {
  if (signature.length !== SR25519_SIGNATURE_BYTES) {
    throw new AsDotnsGatewayError(
      `implication signature is ${signature.length} bytes, expected ${SR25519_SIGNATURE_BYTES}`,
    );
  }
  return encodeChecked(pipeline.codec(pipeline.slot(AS_DOTNS_GATEWAY).type), {
    type: "RegisterFullName",
    value: {
      proof: checkProof(info.proof),
      ring_index: info.ringIndex,
      revision: info.ringRevision,
      signature: { type: "Sr25519", value: toHex(signature) },
    },
  });
}

/**
 * Wrap the host's product-account signer so the transaction it produces is a
 * general transaction authenticated by `AsDotnsGateway`. The wrapped account
 * does not sign anything: `VerifyMultiSignature` is disabled, and the only
 * signature in the extrinsic is the one `info.signImplication` produces.
 */
export function withAsDotnsGateway(
  signer: CommonSignerTxCreator,
  info: AsDotnsGatewayInfo,
): CommonSignerTxCreator {
  const inner = signer as unknown as HostTxCreator;
  const pipelineFor = cachedPipeline();

  const create: TxCreate = async (payload, opts, bindings, mocked) => {
    if (mocked) return inner(payload, opts, bindings, true);
    const standard = await withStandardExtensions(inner.publicKey, payload, opts, bindings);
    const pipeline = pipelineFor(standard.context.metadata);
    const callData = fromHex(standard.callData);
    let extensions = toExtensionMap(pipeline, standard.extensions);
    extensions = withSlot(
      pipeline,
      extensions,
      RESTRICT_ORIGINS,
      encodeChecked(pipeline.codec(pipeline.slot(RESTRICT_ORIGINS).type), true),
    );
    extensions = withSlot(
      pipeline,
      extensions,
      VERIFY_SIGNATURE,
      encodeChecked(
        pipeline.codec(pipeline.slot(VERIFY_SIGNATURE).type),
        VERIFY_SIGNATURE_DISABLED,
      ),
    );
    const digest = Blake2256(buildImplication(pipeline, callData, extensions, AS_DOTNS_GATEWAY));
    let signature: Uint8Array;
    try {
      signature = await info.signImplication(digest);
    } catch (cause) {
      throw new AsDotnsGatewayError("implication signature request failed", { cause });
    }
    extensions = withSlot(
      pipeline,
      extensions,
      AS_DOTNS_GATEWAY,
      encodeAsDotnsGatewayValue(pipeline, info, signature),
    );
    return inner(
      {
        ...standard,
        extensions: toPayloadExtensions(extensions),
        txExtVersion: pipeline.version,
      },
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
