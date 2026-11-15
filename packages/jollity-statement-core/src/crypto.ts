// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The end-to-end encryption primitives of the native apps' signalling wire:
 * one pairwise P-256 ECDH secret per peer link, one AES-256-GCM key derived
 * from it, and the "combined" blob layout the phones put in a statement's
 * Data field. `statementTransport` seals its directed frames with
 * `sharedSecret` and `encryptionKeyBytes` (with its own HKDF info label); the
 * AEAD wrapper below keeps the phones' layout for interop.
 *
 * Wire-format parity targets (the native Polkadot apps' implementation):
 * - ECDH shared secret = X coordinate of (localP256Priv · peerP256Pub),
 *   32 bytes big-endian (iOS CryptoKit `sharedSecretFromKeyAgreement`,
 *   Android JCA/BouncyCastle `KeyAgreement("ECDH")`).
 * - AES key = HKDF-SHA256(ikm = that secret, salt = EMPTY, info = EMPTY,
 *   len = 32). Empty salt ≡ 32 zero bytes per RFC 5869.
 * - AEAD = AES-256-GCM, 12-byte RANDOM nonce per message, 16-byte tag, no AAD,
 *   and the on-wire layout `nonce[12] ‖ ciphertext ‖ tag[16]`
 *   (iOS `AES.GCM.SealedBox.combined`, Android `iv + doFinal(..)`).
 *
 * Load-bearing rules:
 *
 * 1. THE SAME KEY RUNS BOTH DIRECTIONS for the whole session — no ratcheting,
 *    no per-direction keys, no AAD. Adding any of those is a wire break.
 * 2. THE SECRET IS USED TWICE on the phones' wire: it is the HKDF input here
 *    AND the BLAKE2b key of their session topics. Do not hand the *derived
 *    AES key* to a topic derivation, or the topics stop matching the phones'.
 * 3. THE NONCE MUST BE FRESH PER MESSAGE. `seal` takes an explicit nonce only
 *    so tests can pin a vector; production callers must let it default.
 *
 * Representation choice: the session key lives as a WebCrypto `CryptoKey`
 * (`SessionCipher` hides it), which is why `seal`/`open` are async. WebCrypto
 * ships in browsers and in Node ≥ 18 as `globalThis.crypto.subtle`, so this
 * needs no cipher dependency; the ECDH and HKDF halves are pure @noble and
 * therefore synchronous and byte-identical everywhere.
 */
import { p256 } from "@noble/curves/nist.js"
import { hkdf } from "@noble/hashes/hkdf.js"
import { sha256 } from "@noble/hashes/sha2.js"

export const NONCE_BYTES = 12
export const TAG_BYTES = 16
/** Bytes `seal` adds on top of the plaintext length */
export const ENCRYPTION_OVERHEAD_BYTES = NONCE_BYTES + TAG_BYTES

const AES_GCM = "AES-GCM"
const TAG_BITS = TAG_BYTES * 8

function subtle(): SubtleCrypto {
  const webcrypto = globalThis.crypto
  if (!webcrypto?.subtle)
    throw new Error(
      "WebCrypto SubtleCrypto is unavailable — a browser needs a secure context (https/localhost); Node needs ≥ 18",
    )
  return webcrypto.subtle
}

function randomNonce(): Uint8Array {
  const nonce = new Uint8Array(NONCE_BYTES)
  globalThis.crypto.getRandomValues(nonce)
  return nonce
}

/**
 * ECDH over P-256: the X coordinate of the shared point, 32 bytes big-endian.
 * Symmetric — both parties compute the same value.
 *
 * @param privateScalar my 32-byte raw P-256 scalar
 * @param peerIdentifier the peer's 65-byte uncompressed SEC1
 *   `CommunicationIdentifier` (`0x04 ‖ X ‖ Y`) as registered on chain
 */
export function sharedSecret(
  privateScalar: Uint8Array,
  peerIdentifier: Uint8Array,
): Uint8Array {
  if (privateScalar.length !== 32)
    throw new Error(
      `P-256 private scalar must be 32 bytes, got ${privateScalar.length}`,
    )
  if (peerIdentifier.length !== 65 || peerIdentifier[0] !== 0x04)
    throw new Error(
      "peer CommunicationIdentifier must be a 65-byte uncompressed SEC1 point (0x04 ‖ X ‖ Y)",
    )
  // The compressed shared point is `prefix ‖ X[32]`; the phones keep X alone.
  return p256.getSharedSecret(privateScalar, peerIdentifier, true).slice(1)
}

/** HKDF-SHA256(secret, salt = empty, info) → the raw 32-byte AES key. The
 *  phones' derivation has an empty info, the default; a protocol of our own
 *  passes its label, so its keys are not those of any other use of the pair. */
export function encryptionKeyBytes(secret: Uint8Array, info: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (secret.length !== 32)
    throw new Error(`shared secret must be 32 bytes, got ${secret.length}`)
  return hkdf(sha256, secret, new Uint8Array(0), info, 32)
}

/**
 * The session key as WebCrypto sees it. `encryptionKeyBytes` is the byte-level
 * primitive this wraps — pin vectors against that one, pass this one around.
 */
export function deriveSessionKey(secret: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey(
    "raw",
    encryptionKeyBytes(secret) as BufferSource,
    AES_GCM,
    false,
    ["encrypt", "decrypt"],
  )
}

/**
 * The pairwise AEAD of one peer link. The key representation is deliberately
 * hidden: callers carry OPAQUE payload bytes across it and never
 * learn whether a `CryptoKey`, a raw key or a host-held handle is inside.
 */
export interface SessionCipher {
  /**
   * `nonce[12] ‖ AES-256-GCM(plaintext) ‖ tag[16]`.
   * @param nonce TESTS ONLY — omit it in production so every message gets a
   *   fresh random nonce, as GCM requires.
   */
  seal(plaintext: Uint8Array, nonce?: Uint8Array): Promise<Uint8Array>
  /** Opens that layout. Rejects on truncation, tampering or a wrong key. */
  open(blob: Uint8Array): Promise<Uint8Array>
}

/** A `SessionCipher` over an already-computed ECDH secret. */
export function sessionCipherFromSecret(secret: Uint8Array): SessionCipher {
  // Derive the raw key eagerly (so a bad secret throws HERE, at construction,
  // not on the first send) but import it lazily and once — importKey is async
  // and we want the cipher itself to be a plain synchronous value.
  const keyBytes = encryptionKeyBytes(secret)
  let imported: Promise<CryptoKey> | undefined
  const key = () =>
    (imported ??= subtle().importKey("raw", keyBytes as BufferSource, AES_GCM, false, [
      "encrypt",
      "decrypt",
    ]))

  return {
    async seal(plaintext, nonce = randomNonce()) {
      if (nonce.length !== NONCE_BYTES)
        throw new Error(`nonce must be ${NONCE_BYTES} bytes, got ${nonce.length}`)
      const sealed = new Uint8Array(
        await subtle().encrypt(
          { name: AES_GCM, iv: nonce as BufferSource, tagLength: TAG_BITS },
          await key(),
          plaintext as BufferSource,
        ),
      ) // ciphertext ‖ tag[16]
      const combined = new Uint8Array(NONCE_BYTES + sealed.length)
      combined.set(nonce, 0)
      combined.set(sealed, NONCE_BYTES)
      return combined
    },

    async open(blob) {
      if (blob.length < ENCRYPTION_OVERHEAD_BYTES)
        throw new Error(
          `encrypted payload too short: ${blob.length} < ${ENCRYPTION_OVERHEAD_BYTES}`,
        )
      const plaintext = await subtle().decrypt(
        {
          name: AES_GCM,
          iv: blob.subarray(0, NONCE_BYTES) as BufferSource,
          tagLength: TAG_BITS,
        },
        await key(),
        blob.subarray(NONCE_BYTES) as BufferSource,
      )
      return new Uint8Array(plaintext)
    },
  }
}

/**
 * The phones' AEAD for one peer link: my P-256 scalar + the peer's on-chain
 * `CommunicationIdentifier` → the cipher for that link. On the phones' wire
 * the same raw secret also keys the session topics (rule 2 above), so a
 * caller that needs both computes `sharedSecret` once and uses
 * `sessionCipherFromSecret`.
 */
export function sessionCipher(
  privateScalar: Uint8Array,
  peerIdentifier: Uint8Array,
): SessionCipher {
  return sessionCipherFromSecret(sharedSecret(privateScalar, peerIdentifier))
}
