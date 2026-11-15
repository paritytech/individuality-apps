// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { p256 } from "@noble/curves/nist.js"
import { createCipheriv } from "node:crypto"
import {
  ENCRYPTION_OVERHEAD_BYTES,
  NONCE_BYTES,
  deriveSessionKey,
  encryptionKeyBytes,
  sessionCipher,
  sessionCipherFromSecret,
  sharedSecret,
} from "./crypto"

const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const randomScalar = () => p256.utils.randomSecretKey()
const publicOf = (scalar: Uint8Array) => p256.getPublicKey(scalar, false)

describe("sharedSecret", () => {
  it("is symmetric: A→B equals B→A", () => {
    const a = randomScalar()
    const b = randomScalar()
    const ab = sharedSecret(a, publicOf(b))
    expect(ab).toEqual(sharedSecret(b, publicOf(a)))
    expect(ab.length).toBe(32)
  })

  it("is the X coordinate of the shared point", () => {
    const a = randomScalar()
    const b = randomScalar()
    // uncompressed shared point = 0x04 ‖ X[32] ‖ Y[32]
    expect(sharedSecret(a, publicOf(b))).toEqual(
      p256.getSharedSecret(a, publicOf(b), false).slice(1, 33),
    )
  })

  it("rejects a compressed peer identifier", () => {
    expect(() =>
      sharedSecret(randomScalar(), p256.getPublicKey(randomScalar(), true)),
    ).toThrow(/65-byte/)
  })

  it("rejects a bad scalar length", () => {
    expect(() =>
      sharedSecret(new Uint8Array(31), publicOf(randomScalar())),
    ).toThrow(/32 bytes/)
  })
})

describe("encryptionKeyBytes", () => {
  it("derives the same 32-byte AES key on both sides", () => {
    const a = randomScalar()
    const b = randomScalar()
    const keyA = encryptionKeyBytes(sharedSecret(a, publicOf(b)))
    expect(keyA).toEqual(encryptionKeyBytes(sharedSecret(b, publicOf(a))))
    expect(keyA.length).toBe(32)
  })

  it("HKDF-SHA256 empty salt/info pin", () => {
    // An interop vector from an earlier implementation of the native wire,
    // self-generated there. It locks salt = empty, info = empty, len = 32
    // (the phones' parameters) against an accidental parameter change.
    expect(hex(encryptionKeyBytes(new Uint8Array(32).fill(0x0b)))).toBe(
      "27488977d7c845fa17e618b4e225651a0a417521175396f455da2c465679eea8",
    )
  })

  it("rejects a non-32-byte secret", () => {
    expect(() => encryptionKeyBytes(new Uint8Array(16))).toThrow(/32 bytes/)
  })
})

describe("deriveSessionKey", () => {
  it("imports the HKDF output as a non-extractable AES-GCM CryptoKey", async () => {
    const key = await deriveSessionKey(new Uint8Array(32).fill(1))
    expect(key.type).toBe("secret")
    expect(key.extractable).toBe(false)
    expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 })
  })
})

describe("SessionCipher", () => {
  const cipher = sessionCipherFromSecret(new Uint8Array(32).fill(1))

  it("round-trips in both directions with the pairwise key", async () => {
    const a = randomScalar()
    const b = randomScalar()
    const cipherA = sessionCipher(a, publicOf(b))
    const cipherB = sessionCipher(b, publicOf(a))
    const plaintext = new TextEncoder().encode("opaque signalling payload")
    expect(await cipherB.open(await cipherA.seal(plaintext))).toEqual(plaintext)
    expect(await cipherA.open(await cipherB.seal(plaintext))).toEqual(plaintext)
  })

  it("uses the combined wire layout nonce[12] ‖ ct ‖ tag[16]", async () => {
    const plaintext = new Uint8Array([1, 2, 3, 4, 5])
    const nonce = new Uint8Array(NONCE_BYTES).fill(9)
    const combined = await cipher.seal(plaintext, nonce)
    expect(combined.length).toBe(plaintext.length + ENCRYPTION_OVERHEAD_BYTES)
    expect(combined.slice(0, NONCE_BYTES)).toEqual(nonce)
    // deterministic with a fixed nonce
    expect(await cipher.seal(plaintext, nonce)).toEqual(combined)
  })

  it("matches an independent AES-256-GCM implementation, byte for byte", async () => {
    // Provenance: generated here from node:crypto (a different AES-GCM
    // implementation than the WebCrypto one under test), so this pins the
    // WHOLE chain — HKDF params, key bytes, 12-byte IV, 16-byte tag appended
    // to the ciphertext, and the nonce-first combined layout.
    const secret = new Uint8Array(32).fill(1)
    const plaintext = new Uint8Array([1, 2, 3, 4, 5])
    const nonce = new Uint8Array(NONCE_BYTES).fill(9)
    expect(hex(encryptionKeyBytes(secret))).toBe(
      "29cbef482b4acd04af7fb3d5e8bedbaa393040396f69e325f1029ec8f99f1ed2",
    )
    expect(hex(await cipher.seal(plaintext, nonce))).toBe(
      "090909090909090909090909efb694dd2ee6e74376f8aecf88db78cb4bd36fd0cd",
    )

    // …and recompute it live, so the vector cannot rot silently.
    const node = createCipheriv(
      "aes-256-gcm",
      Buffer.from(encryptionKeyBytes(secret)),
      Buffer.from(nonce),
    )
    const ciphertext = Buffer.concat([node.update(plaintext), node.final()])
    const expected = Buffer.concat([nonce, ciphertext, node.getAuthTag()])
    expect(hex(await cipher.seal(plaintext, nonce))).toBe(expected.toString("hex"))
  })

  it("generates a fresh random nonce per message by default", async () => {
    const plaintext = new Uint8Array([7])
    const one = await cipher.seal(plaintext)
    const two = await cipher.seal(plaintext)
    expect(hex(one)).not.toBe(hex(two))
    expect(await cipher.open(one)).toEqual(plaintext)
    expect(await cipher.open(two)).toEqual(plaintext)
  })

  it("rejects a wrong-length nonce", async () => {
    await expect(
      cipher.seal(new Uint8Array([1]), new Uint8Array(11)),
    ).rejects.toThrow(/nonce must be 12 bytes/)
  })

  it("detects tampering (tag, ciphertext and nonce alike)", async () => {
    const combined = await cipher.seal(new Uint8Array([1, 2, 3]))
    for (const index of [0, NONCE_BYTES, combined.length - 1]) {
      const tampered = combined.slice()
      tampered[index]! ^= 0x01
      await expect(cipher.open(tampered)).rejects.toThrow()
    }
  })

  it("rejects a wrong key", async () => {
    const combined = await cipher.seal(new Uint8Array([1, 2, 3]))
    const other = sessionCipherFromSecret(new Uint8Array(32).fill(2))
    await expect(other.open(combined)).rejects.toThrow()
  })

  it("rejects truncated input", async () => {
    await expect(
      cipher.open(new Uint8Array(ENCRYPTION_OVERHEAD_BYTES - 1)),
    ).rejects.toThrow(/too short/)
  })

  it("seals the empty plaintext (overhead only)", async () => {
    const combined = await cipher.seal(new Uint8Array(0))
    expect(combined.length).toBe(ENCRYPTION_OVERHEAD_BYTES)
    expect(await cipher.open(combined)).toEqual(new Uint8Array(0))
  })
})
