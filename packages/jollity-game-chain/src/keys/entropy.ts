// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Signaling encryption key from host-derived entropy (RFC-0007
 * `host_derive_entropy`).
 *
 * This is the one remaining hosted use of `deriveEntropy`: RFC-0022 moves
 * the playing account to the `//product//dim2.dot/0` product account (whose
 * key stays in the host), but explicitly keeps product E2E-encryption key
 * material on `host_derive_entropy` — a product can never see product-account
 * secrets, and ECDH needs the raw scalar in-page.
 *
 * The context is part of the identity: changing it changes the derived
 * CommunicationIdentifier. Bump the `-v1` suffix only with a migration plan
 * (peers resolve the identifier from chain state at signaling time).
 */
import { blake2b } from "@noble/hashes/blake2.js"
import { p256 } from "@noble/curves/nist.js"

/** deriveEntropy context for the P-256 signaling encryption scalar */
export const COMM_ENTROPY_CONTEXT = "dim2-comm-v1"

export interface CommKeys {
  /** P-256 private scalar for signaling ECDH (32 bytes) */
  encryptionPrivateKey: Uint8Array
  /** 65-byte uncompressed SEC1 public key = on-chain CommunicationIdentifier */
  communicationIdentifier: Uint8Array
}

/**
 * The host entropy is uniform 32-byte output of a keyed-blake2b chain, so it
 * is used directly as the P-256 scalar; the (≈2⁻³² per key) case of a value
 * outside [1, n-1] rehashes deterministically until valid.
 */
function p256ScalarFromEntropy(entropy: Uint8Array): Uint8Array {
  let scalar = entropy
  while (!p256.utils.isValidSecretKey(scalar)) {
    scalar = blake2b(scalar, { dkLen: 32 })
  }
  return scalar
}

/** Build the signaling encryption pair from 32 bytes of host entropy. */
export function commKeysFromEntropy(commEntropy: Uint8Array): CommKeys {
  if (commEntropy.length !== 32)
    throw new Error(`host entropy must be 32 bytes, got ${commEntropy.length}`)
  const encryptionPrivateKey = p256ScalarFromEntropy(commEntropy)
  return {
    encryptionPrivateKey,
    communicationIdentifier: p256.getPublicKey(encryptionPrivateKey, false),
  }
}
