// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The chain's transaction-extension pipeline, read from its metadata, and the
 * pieces a signer wrapper needs to rewrite slots of the payload PAPI hands a
 * `SignerTxCreator` before the host assembles the extrinsic.
 *
 * Shared by the wrappers that turn the host's product-account signer into a
 * General (v5) transaction with `VerifyMultiSignature: Disabled`
 * (`dotns-gateway/as-dotns-gateway-signer.ts`, `authorize-call-signer.ts`).
 * Ported from `@parity/product-sdk-individuality` (`as-person-codec.ts`,
 * `as-person-implication.ts`, `with-origin-extension.ts`), which exports only
 * `withAsPerson`.
 *
 * RE-VERIFY ON EVERY SDK BUMP. This code leans on SDK internals the type
 * checker cannot see: the wrappers cast the SDK's `CommonSignerTxCreator` to
 * `HostTxCreator` (the call shape `(payload, opts, bindings, mocked)`) with
 * `as unknown as`, and they rewrite the `VerifyMultiSignature` and
 * `RestrictOrigins` slots by identifier. A product-sdk or polkadot-api
 * release that changes the signer's call shape, the extension identifiers or
 * the encodings ported above still compiles here and breaks signing at run
 * time. When the root's `@parity/product-sdk*` pins move, compare the ported
 * modules with the new SDK sources, run `npm run humanity:test`, and sign one
 * authorized call and one DotNS registration against a real host: the unit
 * tests fake the host signer and the PAPI fillers, so they check the slots
 * this code writes, not the SDK's call shape.
 */
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common";
import { withCommonExtensions, withNonce } from "@polkadot-api/signers-common";
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import { decAnyMetadata, u8, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { fromHex, mergeUint8, toHex } from "polkadot-api/utils";

export const VERIFY_SIGNATURE = "VerifyMultiSignature";
export const RESTRICT_ORIGINS = "RestrictOrigins";
export const VERIFY_SIGNATURE_DISABLED = { type: "Disabled", value: undefined };

export class ExtensionPipelineError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ExtensionPipelineError";
  }
}

interface ExtensionSlot {
  identifier: string;
  type: number;
  implicit: number;
}

type SlotCodec = [encode: (value: unknown) => Uint8Array, decode: (bytes: Uint8Array) => unknown];

export interface ExtensionPipeline {
  version: number;
  extensions: ExtensionSlot[];
  codec: (typeId: number) => SlotCodec;
  indexOf: (identifier: string) => number;
  slot: (identifier: string) => ExtensionSlot;
}

interface SuppliedExtension {
  identifier: string;
  value: Uint8Array;
  additionalSigned: Uint8Array;
}

export type ExtensionMap = Record<string, SuppliedExtension>;

interface PayloadExtension {
  id: string;
  extra: string;
  additionalSigned: string;
}

/** The payload PAPI hands a `SignerTxCreator`, as far as these wrappers read it. */
export interface TxPayload {
  callData: string;
  extensions: PayloadExtension[];
  txExtVersion?: number;
  context: { metadata: string };
}

export type TxCreate = (
  payload: TxPayload,
  opts: unknown,
  bindings: unknown,
  mocked: boolean,
) => Promise<string>;

/** The host signer as the wrappers call it: a `TxCreate` with its key. */
export type HostTxCreator = TxCreate & {
  publicKey: Uint8Array;
  signBytes: (data: Uint8Array) => Promise<Uint8Array>;
};

export function readExtensionPipeline(metadata: Uint8Array): ExtensionPipeline {
  const unified = unifyMetadata(decAnyMetadata(metadata));
  const declared = Object.keys(unified.extrinsic.extensionsByVersion).map(Number);
  if (declared.length === 0) {
    throw new ExtensionPipelineError("chain declares no transaction-extension pipeline");
  }
  const version = Math.max(...declared);
  const extensions: ExtensionSlot[] = unified.extrinsic.extensionsByVersion[version]!.map(
    (entry) => ({
      identifier: entry.identifier,
      type: entry.type,
      implicit: entry.additionalSigned,
    }),
  );
  const builder = getDynamicBuilder(getLookupFn(unified));
  const indexOf = (identifier: string): number => {
    const index = extensions.findIndex((slot) => slot.identifier === identifier);
    if (index === -1) {
      throw new ExtensionPipelineError(`chain does not declare the ${identifier} extension`);
    }
    return index;
  };
  return {
    version,
    extensions,
    codec: (typeId) => {
      const codec = builder.buildDefinition(typeId);
      return [codec.enc as (value: unknown) => Uint8Array, codec.dec as (bytes: Uint8Array) => unknown];
    },
    indexOf,
    slot: (identifier) => extensions[indexOf(identifier)]!,
  };
}

/** Normalise bytes, hex and numbers so a decode can be compared with its input. */
function canonical(value: unknown): unknown {
  if (value instanceof Uint8Array) return toHex(value);
  if (typeof value === "string") return value.startsWith("0x") ? value.toLowerCase() : value;
  if (typeof value === "number" || typeof value === "bigint") return `#${value}`;
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, inner]) => [key, canonical(inner)]),
    );
  }
  return value;
}

/** Encode `value` with `codec` and refuse an encoding that does not decode back to it. */
export function encodeChecked(codec: SlotCodec, value: unknown): Uint8Array {
  const [encode, decode] = codec;
  let bytes: Uint8Array;
  let decoded: unknown;
  try {
    bytes = encode(value);
    decoded = decode(bytes);
  } catch (cause) {
    throw new ExtensionPipelineError("extension value could not be encoded for this chain", {
      cause,
    });
  }
  if (JSON.stringify(canonical(decoded)) !== JSON.stringify(canonical(value))) {
    throw new ExtensionPipelineError("encoded extension value does not round-trip");
  }
  return bytes;
}

/**
 * The bytes an origin extension signs over: the extension version, the call,
 * then the explicit value and the implicit of every extension after it, in
 * pipeline order — `TransactionExtension::validate`'s inherited implication.
 */
export function buildImplication(
  pipeline: ExtensionPipeline,
  callData: Uint8Array,
  extensions: ExtensionMap,
  identifier: string,
): Uint8Array {
  const after = pipeline.extensions.slice(pipeline.indexOf(identifier) + 1);
  const part = (slotName: string, pick: "value" | "additionalSigned"): Uint8Array => {
    const supplied = extensions[slotName];
    if (!supplied) {
      throw new ExtensionPipelineError(
        `signed extension ${slotName} is missing, so the implication cannot be built`,
      );
    }
    return supplied[pick];
  };
  return mergeUint8([
    u8.enc(pipeline.version),
    callData,
    ...after.map((slot) => part(slot.identifier, "value")),
    ...after.map((slot) => part(slot.identifier, "additionalSigned")),
  ]);
}

export function withSlot(
  pipeline: ExtensionPipeline,
  extensions: ExtensionMap,
  identifier: string,
  value: Uint8Array,
): ExtensionMap {
  const slot = pipeline.slot(identifier);
  const additionalSigned =
    extensions[identifier]?.additionalSigned ??
    // Throws unless the declared implicit is empty, the only case this file
    // can fill on the chain's behalf.
    encodeChecked(pipeline.codec(slot.implicit), undefined);
  const next: ExtensionMap = {
    ...extensions,
    [identifier]: { identifier, value, additionalSigned },
  };
  return Object.fromEntries(
    pipeline.extensions
      .filter((declared) => declared.identifier in next)
      .map((declared) => [declared.identifier, next[declared.identifier]!]),
  );
}

export async function withStandardExtensions(
  publicKey: Uint8Array,
  payload: TxPayload,
  opts: unknown,
  bindings: unknown,
): Promise<TxPayload> {
  let filled: TxPayload | undefined;
  const keep = (async (complete: TxPayload) => {
    filled = complete;
    return "0x";
  }) as unknown as CommonSignerTxCreator;
  const enhanced = withNonce(publicKey)(withCommonExtensions(keep)) as unknown as TxCreate;
  await enhanced(payload, opts, bindings, false);
  if (!filled) {
    throw new ExtensionPipelineError("transaction extensions could not be filled");
  }
  return filled;
}

export function toExtensionMap(pipeline: ExtensionPipeline, supplied: PayloadExtension[]): ExtensionMap {
  const byId = new Map<string, PayloadExtension>();
  for (const extension of supplied) {
    if (!byId.has(extension.id)) byId.set(extension.id, extension);
  }
  return Object.fromEntries(
    pipeline.extensions.flatMap(({ identifier }) => {
      const extension = byId.get(identifier);
      return extension
        ? [
            [
              identifier,
              {
                identifier,
                value: fromHex(extension.extra),
                additionalSigned: fromHex(extension.additionalSigned),
              },
            ],
          ]
        : [];
    }),
  );
}

export function toPayloadExtensions(extensions: ExtensionMap): PayloadExtension[] {
  return Object.values(extensions).map(({ identifier, value, additionalSigned }) => ({
    id: identifier,
    extra: toHex(value),
    additionalSigned: toHex(additionalSigned),
  }));
}

/** A pipeline reader that re-reads the metadata only when it changes. */
export function cachedPipeline(): (metadata: string) => ExtensionPipeline {
  let cached: { metadata: string; pipeline: ExtensionPipeline } | undefined;
  return (metadata) => {
    if (cached?.metadata !== metadata) {
      cached = { metadata, pipeline: readExtensionPipeline(fromHex(metadata)) };
    }
    return cached.pipeline;
  };
}
