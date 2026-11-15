// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest"
import { blake2b } from "@noble/hashes/blake2.js"
import { p256 } from "@noble/curves/nist.js"
import { COMM_ENTROPY_CONTEXT, commKeysFromEntropy } from "./entropy"

const hex = (b: Uint8Array) =>
  "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")

/** Deterministic stand-in for host entropy (RFC-0007 output is uniform
 * 32 bytes; any fixed bytes exercise the same pipeline). */
const commEntropy = blake2b(new TextEncoder().encode("test-comm"), {
  dkLen: 32,
})

describe("commKeysFromEntropy", () => {
  it("is deterministic and the context string is pinned", () => {
    // the context IS the identity — changing it is a key migration
    expect(COMM_ENTROPY_CONTEXT).toBe("dim2-comm-v1")

    const a = commKeysFromEntropy(commEntropy)
    const b = commKeysFromEntropy(commEntropy)
    expect(hex(a.communicationIdentifier)).toBe(hex(b.communicationIdentifier))
  })

  it("pins the derivation pipeline (fixture)", () => {
    // Regression anchor: if these change, every existing entropy-derived
    // CommunicationIdentifier changes with them.
    const keys = commKeysFromEntropy(commEntropy)
    expect(hex(keys.communicationIdentifier)).toBe(
      "0x04d31a0420a752608113cfe9caff643dad86212cadf508fa205681ff13f5c5e418c1f4b50b77326c081d1d016fde0ab020e064bc64dc21d9d6698f2943eff8763e",
    )
    // comm scalar is the entropy itself (valid P-256 scalar, no rehash)
    expect(hex(keys.encryptionPrivateKey)).toBe(hex(commEntropy))
  })

  it("derives a 65-byte uncompressed P-256 CommunicationIdentifier", () => {
    const keys = commKeysFromEntropy(commEntropy)
    expect(keys.communicationIdentifier.length).toBe(65)
    expect(keys.communicationIdentifier[0]).toBe(0x04)
    expect(hex(keys.communicationIdentifier)).toBe(
      hex(p256.getPublicKey(keys.encryptionPrivateKey, false)),
    )
  })

  it("rejects entropy that is not 32 bytes", () => {
    expect(() => commKeysFromEntropy(new Uint8Array(31))).toThrow(
      /must be 32 bytes/,
    )
  })
})
