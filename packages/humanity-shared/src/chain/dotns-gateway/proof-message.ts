// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The 32 bytes the ring-VRF proof of a `DotnsGateway.register_name` commits
 * to, as `Pallet::construct_register_proof_message` builds them:
 * `blake2_256(SCALE((who, label, link)))` with
 *
 * - `who`: `AccountId32`, its 32 raw bytes, no length prefix;
 * - `label`: `&[u8]`, compact length then the bytes;
 * - `link`: `Link`, one variant byte then the payload —
 *   `LiteUsername(BaseLabel)` is `0x00` + compact length + bytes (the
 *   `BaseLabel` newtype is transparent), `None(ChatKey)` is `0x01` + 65 bytes.
 *
 * Verified against the `dotns-gateway` pallet's `types.rs` and truapi's
 * `build_register_proof_message`. A wrong
 * variant index or a missing compact prefix fails on chain as `BadProof`
 * with nothing local to read, hence the hand-derived vector in the test.
 */
import {
  AccountId,
  Blake2256,
  compact,
} from "@polkadot-api/substrate-bindings";
import { mergeUint8 } from "polkadot-api/utils";

const SS58_PREFIX = 42;
const CHAT_KEY_BYTES = 65;
const LABEL_BYTES_MAX = 32;

/** `Link`: how the full-person label relates to the account's lite identity. */
export type RegisterNameLink =
  | { tag: "LiteUsername"; label: string }
  | { tag: "None"; chatKey: Uint8Array };

const utf8 = new TextEncoder();

/** `&[u8]` / `BoundedVec<u8, 32>`: compact length, then the bytes. */
export function encodeLabel(label: string): Uint8Array {
  const bytes = utf8.encode(label);
  if (bytes.length === 0 || bytes.length > LABEL_BYTES_MAX) {
    throw new RangeError(`dotNS label must be 1–${LABEL_BYTES_MAX} bytes, got ${bytes.length}`);
  }
  return mergeUint8([compact.enc(bytes.length), bytes]);
}

export function encodeLink(link: RegisterNameLink): Uint8Array {
  switch (link.tag) {
    case "LiteUsername":
      return mergeUint8([Uint8Array.of(0), encodeLabel(link.label)]);
    case "None":
      if (link.chatKey.length !== CHAT_KEY_BYTES) {
        throw new RangeError(`chat key must be ${CHAT_KEY_BYTES} bytes, got ${link.chatKey.length}`);
      }
      return mergeUint8([Uint8Array.of(1), link.chatKey]);
  }
}

/**
 * `blake2_256(SCALE((who, label, link)))`: the message the person's ring-VRF
 * proof is built over, and what `AsDotnsGateway` verifies it against.
 */
export function registerNameProofMessage(
  who: string,
  label: string,
  link: RegisterNameLink,
): Uint8Array {
  return Blake2256(
    mergeUint8([AccountId(SS58_PREFIX).enc(who), encodeLabel(label), encodeLink(link)]),
  );
}
